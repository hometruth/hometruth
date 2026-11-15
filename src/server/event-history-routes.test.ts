import { expect, test } from "bun:test";
import { createApp } from "./app";
import { EventHistory } from "../models/event-history";
import { DeviceEventLogs } from "../models/device-event-log";
import { validators } from "../validation";

test("Events API pages persisted filtered history and receives new device events", async () => {
  const history = new EventHistory(":memory:");
  try {
    for (let n = 0; n < 205; n++) history.save({ at: "2020-01-01T00:00:00.000Z", type: "started", level: "info", message: `Startup ${n}` });
    const logs = new DeviceEventLogs(200, undefined, event => history.save(event));
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, logs,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, history);
    const first = await (await app.request("/api/events?type=started")).json();
    expect(validators.eventsResponse(first)).toBe(true);
    expect(first.events).toHaveLength(200);
    const second = await (await app.request(`/api/events?type=started&before=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(validators.eventsResponse(second)).toBe(true);
    expect(second.events).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.events, ...second.events].map(event => event.message)).size).toBe(205);
    logs.record("example-relay", "device_control", "Relay turned on", { data: { control: "turnOn" } });
    const filtered = await (await app.request("/api/events?subject=example-relay")).json();
    expect(filtered.events).toHaveLength(1);
    expect((await app.request("/api/events?before=invalid")).status).toBe(400);
    const html = await (await app.request("/events")).text();
    expect(html).toContain('id="events-older"');
  } finally { history.close(); }
});
