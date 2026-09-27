import { describe, expect, test } from "bun:test";
import { DeviceEventLogs } from "./device-event-log";

describe("DeviceEventLogs", () => {
  test("keeps a separate bounded ring for every device", () => {
    let tick = 0;
    const logs = new DeviceEventLogs(2, () => new Date(1_700_000_000_000 + tick++));
    logs.record("light", "availability_changed", "first", { data: { current: "online" } });
    logs.record("relay", "availability_changed", "relay", { data: { current: "online" } });
    logs.record("light", "availability_changed", "second", { data: { current: "offline" } });
    logs.record("light", "availability_changed", "third", { data: { current: "online" } });
    expect(logs.recent("light").map((event) => event.message)).toEqual(["third", "second"]);
    expect(logs.recent("relay").map((event) => event.message)).toEqual(["relay"]);
    expect(logs.recent("light")[0]?.subject).toBe("light");
  });

  test("streams only the requested device", () => {
    const logs = new DeviceEventLogs();
    const seen: string[] = [];
    const unsubscribe = logs.subscribe("light", (event) => seen.push(event.message));
    logs.record("relay", "availability_changed", "not this one", { data: { current: "online" } });
    logs.record("light", "availability_changed", "light changed", { data: { current: "offline" } });
    unsubscribe();
    logs.record("light", "availability_changed", "after unsubscribe", { data: { current: "online" } });
    expect(seen).toEqual(["light changed"]);
  });

  test("publishes every recorded device event to the configured event bus", () => {
    const published: { type: string; subject?: string }[] = [];
    const logs = new DeviceEventLogs(200, () => new Date(1_700_000_000_000), (event) => published.push(event));

    logs.record("relay", "device_control", "Relay: toggle", { data: { control: "toggle" } });

    expect(published).toEqual([expect.objectContaining({ type: "device_control", subject: "relay" })]);
  });
});
