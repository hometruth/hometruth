import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSupervisor } from "./supervisor";

const resources: { root: string; hub: Awaited<ReturnType<typeof startSupervisor>> }[] = [];
afterEach(async () => {
  for (const { root, hub } of resources.splice(0)) {
    await hub.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureSource(label: string, options: { delay?: number; hangOnStop?: boolean; hangOnActivate?: boolean; crashOnActivate?: boolean; failOnActivate?: boolean } = {}) {
  return `
process.on('message', message => {
  if (message.type === 'stop') { ${options.hangOnStop ? "return;" : "process.exit(0);"} }
  if (message.type === 'activate') {
    ${options.crashOnActivate ? "process.exit(17);" : options.hangOnActivate ? "while (true) {}" : options.failOnActivate ? "process.send({ type: 'failed' });" : "process.send({ type: 'running' });"}
  }
});
setInterval(() => process.send({ type: 'heartbeat' }), 50);
await Bun.sleep(${options.delay ?? 0});
const server = Bun.serve({hostname:'127.0.0.1', port:0, async fetch(request) {
  if (new URL(request.url).pathname === '/stop-http') { setTimeout(() => server.stop(true), 10); return new Response('stopping'); }
  if (new URL(request.url).pathname === '/env') return Response.json({value:process.env.HOMETRUTH_TEST_VALUE ?? null});
  if (new URL(request.url).pathname === '/echo') return Response.json({url:request.headers.get('x-hometruth-original-url'),origin:request.headers.get('origin'),body:await request.text()});
  if (new URL(request.url).pathname === '/stream') return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: first\\n\\n'));setTimeout(()=>{c.enqueue(new TextEncoder().encode('data: second\\n\\n'));c.close()}, 100)}}),{headers:{'content-type':'text/event-stream'}});
  return new Response(${JSON.stringify(label)});
}});
process.send({type:'ready',port:server.port});
`;
}
async function fixture(source: string, extra: Parameters<typeof startSupervisor>[0] = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "hometruth-supervisor-"));
  const root = join(workspace, "source");
  const installationRoot = join(workspace, "installation");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(installationRoot);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "src", "fixture.ts"), source);
  const hub = await startSupervisor({ root, installationRoot, port: 0, hostname: "127.0.0.1", entrypoint: "src/fixture.ts", readyTimeoutMs: 2_000, shutdownTimeoutMs: 150, heartbeatTimeoutMs: 300, ...extra });
  resources.push({ root: workspace, hub });
  return { root: installationRoot, sourceRoot: root, hub, source: join(root, "src", "fixture.ts") };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state change");
    await Bun.sleep(20);
  }
}
const body = async (url: string) => (await fetch(url)).text();

describe("public listener and supervised generations", () => {
  test("binds immediately but returns an uncached 503 until an application can serve pages", async () => {
    const { hub, root, sourceRoot } = await fixture(fixtureSource("ready", { delay: 600 }));
    expect(hub.status().pid).toBeNull();
    const start = performance.now();
    const response = await fetch(hub.url);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(await response.text()).toBe("HomeTruth is unavailable.\n");
    expect(performance.now() - start).toBeLessThan(500);
    const head = await fetch(hub.url, { method: "HEAD" });
    expect(head.status).toBe(503);
    expect(await head.text()).toBe("");
    expect((await fetch(`${hub.url}/api/devices`)).status).toBe(503);
    await expect(startSupervisor({ root: sourceRoot, installationRoot: root, port: hub.server.port!, hostname: "127.0.0.1" })).rejects.toThrow();
    await until(() => hub.status().state === "running");
    expect(await body(hub.url)).toBe("ready");
  });

  test("a syntax error takes the application down instead of serving the generation that worked", async () => {
    const { hub, source } = await fixture(fixtureSource("one"), { watch: true });
    await until(() => hub.status().state === "running");
    const original = hub.status().pid;
    await writeFile(source, "const broken = ;");
    await until(() => hub.status().pid === null);
    const down = await fetch(hub.url);
    expect(down.status).toBe(503);
    expect(await down.text()).toBe("HomeTruth is unavailable.\n");
    await writeFile(source, fixtureSource("two"));
    await until(async () => await body(hub.url) === "two");
    expect(hub.status().pid).not.toBe(original);
  });

  test("atomic saves replace the running generation without failed requests", async () => {
    const { hub, source } = await fixture(fixtureSource("one"), { watch: true });
    await until(() => hub.status().state === "running");
    const original = hub.status().pid;
    const observations: string[] = [];
    let reading = true;
    const traffic = (async () => { while (reading) { observations.push(await body(hub.url)); await Bun.sleep(5); } })();
    try {
      await writeFile(`${source}.tmp`, fixtureSource("two", { delay: 200 }));
      await rename(`${source}.tmp`, source);
      await until(async () => await body(hub.url) === "two");
    } finally { reading = false; await traffic; }
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(value => value === "one" || value === "two")).toBe(true);
    expect(hub.status().pid).not.toBe(original);
  });

  test("a crash while the source is broken stays down; no earlier snapshot is revived", async () => {
    const { hub, source } = await fixture(fixtureSource("known-good"));
    await until(() => hub.status().state === "running");
    const original = hub.status().pid!;
    await writeFile(source, "broken syntax !");
    process.kill(original, "SIGKILL");
    await until(() => hub.status().pid === null);
    for (let attempt = 0; attempt < 5; attempt++) {
      const down = await fetch(hub.url);
      expect(down.status).toBe(503);
      expect(await down.text()).toBe("HomeTruth is unavailable.\n");
      await Bun.sleep(100);
    }
    await writeFile(source, fixtureSource("repaired"));
    hub.reload();
    await until(() => hub.status().state === "running");
    expect(await body(hub.url)).toBe("repaired");
  });

  test("a failed startup cannot keep serving a nonworking preview", async () => {
    const { hub, source } = await fixture(fixtureSource("broken preview", { failOnActivate: true }));
    await until(() => hub.status().state === "retrying");
    for (const path of ["/", "/switches", "/api/health", "/api/devices"]) {
      const response = await fetch(`${hub.url}${path}`);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("broken preview");
    }
    await writeFile(source, fixtureSource("recovered"));
    hub.reload();
    await until(() => hub.status().state === "running");
    expect(await body(hub.url)).toBe("recovered");
  });

  test("upstream connection failures return 503 instead of a successful fallback page", async () => {
    const { hub } = await fixture(fixtureSource("working page"));
    await until(() => hub.status().state === "running");
    const pid = hub.status().pid;
    await fetch(`${hub.url}/stop-http`);
    await until(async () => (await fetch(hub.url)).status === 503);
    const response = await fetch(`${hub.url}/switches`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("HomeTruth is unavailable.\n");
    expect(hub.status().pid).toBe(pid);
    expect((await fetch(`${hub.url}/api/devices`)).status).toBe(503);
  });

  test("stopping the supervisor refuses connections instead of serving any page", async () => {
    const { hub } = await fixture(fixtureSource("working page"));
    await until(() => hub.status().state === "running");
    await hub.stop();
    await expect(fetch(hub.url)).rejects.toThrow();
  });

  test("environment changes and deletions reach new generations", async () => {
    const { hub, root } = await fixture(fixtureSource("ready"), { watch: true });
    await until(() => hub.status().state === "running");
    await writeFile(join(root, ".env"), "HOMETRUTH_TEST_VALUE=first\n");
    await until(async () => (await (await fetch(`${hub.url}/env`)).json()).value === "first");
    await writeFile(join(root, ".env"), "HOMETRUTH_TEST_VALUE=second\n");
    await until(async () => (await (await fetch(`${hub.url}/env`)).json()).value === "second");
    await rm(join(root, ".env"));
    await until(async () => (await (await fetch(`${hub.url}/env`)).json()).value === null);
  });

  test("a hung shutdown cannot block serving or activation of a replacement", async () => {
    const { hub, source } = await fixture(fixtureSource("one", { hangOnStop: true }));
    await until(() => hub.status().state === "running");
    const original = hub.status().pid;
    await writeFile(source, fixtureSource("two"));
    hub.reload();
    await until(() => hub.status().state === "running" && hub.status().pid !== original);
    expect(await body(hub.url)).toBe("two");
    expect(() => process.kill(original!, 0)).toThrow();
  });

  test("watchdog takes a worker whose event loop is stuck off the socket", async () => {
    const { hub, source } = await fixture(fixtureSource("good"));
    await until(() => hub.status().state === "running");
    const originalVersion = hub.status().version;
    await writeFile(source, fixtureSource("stuck", { hangOnActivate: true }));
    hub.reload();
    await until(() => hub.status().version !== originalVersion);
    await until(() => hub.status().pid === null, 6_000);
    const down = await fetch(hub.url);
    expect(down.status).toBe(503);
    expect(await down.text()).toBe("HomeTruth is unavailable.\n");
    await writeFile(source, fixtureSource("recovered"));
    hub.reload();
    await until(() => hub.status().state === "running", 6_000);
    expect(await body(hub.url)).toBe("recovered");
  }, 20_000);

  test("preserves origin, request bodies and streaming responses", async () => {
    const { hub } = await fixture(fixtureSource("ready"));
    await until(() => hub.status().state === "running");
    const result = await (await fetch(`${hub.url}/echo`, { method: "POST", headers: { origin: hub.url }, body: "command" })).json();
    expect(result).toEqual({ url: `${hub.url}/echo`, origin: hub.url, body: "command" });
    const stream = await fetch(`${hub.url}/stream`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const chunks = stream.body!.getReader();
    expect(new TextDecoder().decode((await chunks.read()).value)).toContain("first");
    expect(new TextDecoder().decode((await chunks.read()).value)).toContain("second");
  });
});
