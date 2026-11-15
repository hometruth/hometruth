import { definition, end } from "../../tests/fixtures/workflow";
import { expect, test } from "bun:test";
import { BroadlinkRm4Pro } from "../devices/blasters/broadlink-rm4-pro";
import { ActionButtonDevice } from "../devices/composites/action-button";
import { OptimisticSwitchDevice } from "../devices/composites/optimistic-switch";
import { WorkflowButtonDevice } from "../devices/composites/workflow-button";
import { validators } from "../validation";
import type { Device } from "./device";

function fixture() {
  let probes = 0;
  let fail = false;
  const source = new BroadlinkRm4Pro({ id: "transmitter", name: "Example transmitter" }, { host: "192.0.2.10" }, {
    transmitter: {
      async probe() { probes++; if (fail) throw new Error("No reply"); },
      async send() { throw new Error("This test must not send a command"); },
      async learn() { throw new Error("This test must not learn a command"); },
    },
  });
  const context = { device: () => source };
  const on = new ActionButtonDevice({ id: "on", name: "On" }, { device: source.id, control: "infraredBlaster.send" }, {}, context);
  const off = new ActionButtonDevice({ id: "off", name: "Off" }, { device: source.id, control: "infraredBlaster.send" }, {}, context);
  const sw = new OptimisticSwitchDevice({ id: "switch", name: "Example switch" }, { onButton: on.id, offButton: off.id, initialState: "off" }, {}, {
    device: id => id === on.id ? on : off,
  });
  const workflow = new WorkflowButtonDevice({ id: "workflow", name: "Example workflow" }, { workflow: definition([
    { id: "on", type: "action", action: { target: source.id, operation: "infraredBlaster.send", input: { value: "test-code" } }, next: "done", onError: "done" }, end(),
  ]) }, {}, context);
  return { source, on, off, sw, workflow, probes: () => probes, fail: (value: boolean) => { fail = value; } };
}

test("dependent descriptions and health checks inherit one physical observation without any probes", async () => {
  const f = fixture();
  const dependents = [f.on, f.off, f.sw, f.workflow];
  try {
    for (const dependent of dependents) {
      expect((await dependent.describe()).status).toBe("unknown");
      expect(await dependent.checkHealth()).toMatchObject({ status: "unknown", checkedAt: null });
    }
    expect(f.probes()).toBe(0);
    await f.source.describe();
    const probes = f.probes();
    for (let i = 0; i < 3; i++) for (const dependent of dependents) {
      const document = await dependent.describe();
      expect(document.status).toBe("online");
      expect(Object.values(document.capabilities).every(capability => (capability as { state: { availability: string } }).state.availability === "online")).toBe(true);
      expect(validators.homeTruthObject(document)).toBe(true);
      expect(await dependent.checkHealth()).toMatchObject({ status: "healthy", checkedAt: document.health.checkedAt });
      await dependent.probe();
    }
    expect(f.probes()).toBe(probes);
    f.fail(true);
    await f.source.describe();
    for (const dependent of dependents) {
      expect((await dependent.describe()).status).toBe("offline");
      expect((await dependent.checkHealth()).status).toBe("unhealthy");
    }
    f.fail(false);
    await f.source.describe();
    expect((await f.sw.describe()).health.status).toBe("healthy");
    expect((await f.sw.switch.describe()).state).toMatchObject({ availability: "online", value: "off" });
  } finally { await f.sw.close(); await f.workflow.close(); }
});

test("timeouts, recovery and disable changes propagate transitively without refreshing the children", async () => {
  const f = fixture();
  const changes: string[] = [];
  const health: string[] = [];
  const release = f.sw.subscribeAvailability(() => changes.push(f.sw.availability()));
  const releaseHealth = f.sw.subscribeHealth(value => health.push(value.status));
  try {
    await f.source.describe();
    f.source.reportAvailability("offline");
    expect(f.sw.availability()).toBe("offline");
    await f.source.describe();
    f.source.enabled = false;
    expect((await f.on.button.describe()).state.availability).toBe("offline");
    f.source.enabled = true;
    expect(f.sw.availability()).toBe("unknown");
    await f.source.describe();
    expect(changes).toEqual(["online", "offline", "online", "offline", "unknown", "online"]);
    expect(health).toEqual(["healthy", "unhealthy", "healthy", "unhealthy", "unknown", "healthy"]);
    release(); releaseHealth();
    f.source.reportAvailability("offline");
    expect(changes).toHaveLength(6);
  } finally { release(); releaseHealth(); await f.sw.close(); await f.workflow.close(); }
});

test("all required sources must be observed, and independent source failures produce degraded availability", async () => {
  const a = fixture(), b = fixture();
  const sources: Record<string, Device> = { a: a.on, b: b.on };
  const sw = new OptimisticSwitchDevice({ id: "combined", name: "Combined" }, { onButton: "a", offButton: "b" }, {}, { device: id => sources[id]! });
  try {
    await a.source.describe();
    expect((await sw.describe()).status).toBe("unknown");
    b.source.reportAvailability("offline");
    expect((await sw.describe()).status).toBe("degraded");
    a.source.reportAvailability("offline");
    expect((await sw.describe()).status).toBe("offline");
    expect(validators.healthCheck(sw.health)).toBe(true);
  } finally { await sw.close(); await a.sw.close(); await b.sw.close(); await a.workflow.close(); await b.workflow.close(); }
});

test("a read completing after its deadline cannot replace a newer offline observation", async () => {
  const f = fixture();
  let resume!: () => void;
  const document = await f.source.capabilities.infraredBlaster.describe();
  f.source.capabilities.infraredBlaster.describe = async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    return document;
  };
  try {
    const late = f.source.describe();
    f.source.reportAvailability("offline");
    resume();
    await late;
    expect(f.source.availability()).toBe("offline");
    expect(f.sw.availability()).toBe("offline");
  } finally { await f.sw.close(); await f.workflow.close(); }
});
