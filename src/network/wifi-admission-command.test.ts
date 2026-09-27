import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileAdmissionJournal } from "./wifi-admission-command";

test("journal is exclusive, private, and refuses recovery while its owner runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wifi-admission-"));
  try {
    const journal = new FileAdmissionJournal(directory, { target: "https://10.77.0.1/default" });
    const wlan = { id: "one", ssid: "Test", enabled: true, filterEnabled: true, policy: "allow", macs: ["02:00:00:00:00:01"] };
    await journal.save(wlan);
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(journal.path, "utf8")).wlan).toEqual(wlan);
    await expect(journal.save(wlan)).rejects.toThrow("already exists");
    await expect(journal.read("Test")).rejects.toThrow("still running");
    await expect(journal.read("Other")).rejects.toThrow("does not match");
    await expect(new FileAdmissionJournal(directory, { target: "other-router/site" }).pending()).rejects.toThrow("does not match");
    await journal.clear();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`worker restores the mock router when the CLI receives ${signal}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "wifi-admission-process-"));
    const statePath = join(directory, "router.json");
    await Bun.write(statePath, JSON.stringify({ filterEnabled: true, opened: false }));
    const providerPath = join(directory, "router.ts");
    await Bun.write(providerPath, `
      const statePath = ${JSON.stringify(statePath)};
      const request = JSON.parse(await Bun.stdin.text());
      const state = await Bun.file(statePath).json();
      let result = null;
      if (request.operation === "admission.wlans") result = [{ id: "test-wlan", ssid: "Test", enabled: true,
        filterEnabled: state.filterEnabled, policy: "allow", macs: ["02:00:00:00:00:01"] }];
      else if (request.operation === "admission.clients") result = [];
      else if (request.operation === "admission.set-filter") {
        state.filterEnabled = request.input.enabled;
        if (!state.filterEnabled) state.opened = true;
        await Bun.write(statePath, JSON.stringify(state));
      } else throw new Error("Unexpected operation");
      process.stdout.write(JSON.stringify(result));
    `);
    const source = `import { runWifiAdmissionCommand } from ${JSON.stringify(resolve(import.meta.dir, "wifi-admission-command.ts"))}; await runWifiAdmissionCommand({ssid:"Test",timeoutMs:10000,dryRun:false,recover:false});`;
    const parent = spawn(process.execPath, ["-e", source], { cwd: directory, stdio: "ignore", env: {
      ...process.env, HOMETRUTH_SECRETS: join(directory, "empty-secrets.yml"),
      HOMETRUTH_NETWORK_ADAPTER: "command", HOMETRUTH_NETWORK_COMMAND: JSON.stringify([process.execPath, providerPath]),
      HOMETRUTH_NETWORK_CAPABILITIES: "admission", HOMETRUTH_NETWORK_TARGET: "test-router/site",
    } });
    const exited = new Promise(resolveExit => parent.on("exit", resolveExit));
    const journal = join(directory, ".hometruth/wifi-admission/active.json");
    const waitUntil = async (predicate: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 8000;
      while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("Mock admission did not settle"); await Bun.sleep(25); }
    };
    try {
      await waitUntil(async () => (await Bun.file(statePath).json()).opened);
      parent.kill(signal);
      await exited;
      await waitUntil(async () => (await Bun.file(statePath).json()).filterEnabled && !(await Bun.file(journal).exists()));
      expect((await Bun.file(statePath).json()).filterEnabled).toBe(true);
    } finally {
      parent.kill("SIGTERM");
      const snapshot = await Bun.file(journal).json().catch(() => undefined);
      if (snapshot?.pid) { try { process.kill(snapshot.pid, "SIGTERM"); } catch {} }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}
