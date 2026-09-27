import { describe, expect, test } from "bun:test";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveSite } from "./live-site";

async function writeTempYaml(contents: string): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "hometruth-live-site-"));
  const path = join(directory, "devices.yml");
  await writeFile(path, contents, "utf8");
  return path;
}

const oneSwitch = `schemaVersion: 2
devices:
  - id: relay
    name: Relay
    model: shelly-plus-1
    config:
      host: 10.77.0.228
`;

const twoSwitches = `schemaVersion: 2
devices:
  - id: relay
    name: Relay
    model: shelly-plus-1
    config:
      host: 10.77.0.228
  - id: relay-2
    name: Relay 2
    model: shelly-plus-1
    config:
      host: 10.77.0.229
`;

const invalidYaml = `schemaVersion: 2
devices:
  - id: relay
    model: shelly-plus-1
    config:
      host: 10.77.0.228
      channel: "not a number"
`;

describe("createLiveSite", () => {
  test("reload() builds a Site from the file and the returned site reflects it", async () => {
    const path = await writeTempYaml(oneSwitch);
    const liveSite = createLiveSite({ path, services: {}, secrets: undefined });
    await liveSite.reload();

    expect(liveSite.site.devices).toHaveLength(1);
    expect(liveSite.site.get("relay")).toBeDefined();
  });

  test("the returned site's identity never changes across reload()", async () => {
    const path = await writeTempYaml(oneSwitch);
    const liveSite = createLiveSite({ path, services: {}, secrets: undefined });
    const siteBefore = liveSite.site;
    await liveSite.reload();
    await writeFile(path, twoSwitches, "utf8");
    await liveSite.reload();

    expect(liveSite.site).toBe(siteBefore);
    expect(liveSite.site.devices).toHaveLength(2);
  });

  test("a reload that fails to parse leaves the previous site in place", async () => {
    const path = await writeTempYaml(oneSwitch);
    const errors: unknown[] = [];
    const liveSite = createLiveSite({ path, services: {}, secrets: undefined, onError: (error) => errors.push(error) });
    await liveSite.reload();
    expect(liveSite.site.devices).toHaveLength(1);

    await writeFile(path, invalidYaml, "utf8");
    await liveSite.reload();

    expect(liveSite.site.devices).toHaveLength(1);
    expect(liveSite.site.get("relay")).toBeDefined();
    expect(errors).toHaveLength(1);
  });

  test("watch() follows atomic file replacements without calling reload() manually", async () => {
    const path = await writeTempYaml(oneSwitch);
    let reloadCount = 0;
    const liveSite = createLiveSite({
      path,
      services: {},
      secrets: undefined,
      debounceMs: 20,
      onReload: () => { reloadCount += 1; },
    });
    await liveSite.reload();
    liveSite.watch();

    const replacement = `${path}.replacement`;
    await writeFile(replacement, twoSwitches, "utf8");
    await rename(replacement, path);

    const deadline = Date.now() + 3_000;
    while (liveSite.site.devices.length < 2 && Date.now() < deadline) {
      await Bun.sleep(50);
    }

    expect(liveSite.site.devices).toHaveLength(2);
    expect(reloadCount).toBeGreaterThanOrEqual(1);

    await writeFile(replacement, oneSwitch, "utf8");
    await rename(replacement, path);
    const secondDeadline = Date.now() + 3_000;
    while (liveSite.site.devices.length > 1 && Date.now() < secondDeadline) await Bun.sleep(50);
    expect(liveSite.site.devices).toHaveLength(1);
    liveSite.close();
  });

  test("close() stops watching", async () => {
    const path = await writeTempYaml(oneSwitch);
    let reloadCount = 0;
    const liveSite = createLiveSite({
      path,
      services: {},
      secrets: undefined,
      debounceMs: 20,
      onReload: () => { reloadCount += 1; },
    });
    await liveSite.reload();
    liveSite.watch();
    liveSite.close();
    const reloadCountAfterClose = reloadCount;

    await writeFile(path, twoSwitches, "utf8");
    await Bun.sleep(200);

    expect(liveSite.site.devices).toHaveLength(1);
    expect(reloadCount).toBe(reloadCountAfterClose);
  });
});


test("replacing inventory retires old device subscriptions and closing prevents pending publication", async () => {
  const path = await writeTempYaml(oneSwitch);
  const live = createLiveSite({ path, services: {}, secrets: undefined });
  await live.reload();
  let closed = 0;
  live.site.get("relay")!.close = async () => { closed++; };
  await writeFile(path, twoSwitches, "utf8");
  await live.reload();
  expect(closed).toBe(1);
  expect(live.site.devices).toHaveLength(2);
  await writeFile(path, oneSwitch, "utf8");
  const pending = live.reload();
  live.close();
  await pending;
  expect(live.site.devices).toHaveLength(2);
});
