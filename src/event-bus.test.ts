import { describe, expect, test } from "bun:test";
import { EventBusForwarder } from "./event-bus";
import { DeviceEventLogs } from "./models/device-event-log";
import type { ServiceEvent } from "./models/event-log";

const event: ServiceEvent = {
  at: "2026-09-11T12:00:00.000Z",
  type: "availability_changed",
  level: "info",
  subject: "aqara-hub-m2",
  message: "Aqara hub is online",
  data: { current: "online" },
};

describe("EventBusForwarder", () => {
  test("shutdown waits for accepted publications and ignores late events", async () => {
    const delivered = Promise.withResolvers<void>();
    const published: ServiceEvent[] = [];
    const errors: unknown[] = [];
    const forwarder = new EventBusForwarder({
      async publishEvent(value) {
        await delivered.promise;
        published.push(value);
      },
    }, (error) => errors.push(error));
    forwarder.publish(event);
    let stopped = false;
    const stopping = forwarder.stop().then(() => { stopped = true; });
    const stoppingAgain = forwarder.stop();
    forwarder.publish({ ...event, message: "Late event" });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(published).toEqual([]);
    delivered.resolve();
    await Promise.all([stopping, stoppingAgain]);
    expect(published).toEqual([event]);
    expect(errors).toEqual([]);
  });

  test.each([false, true])("reports publication failures, including synchronous throws (%s)", async (synchronous) => {
    const failure = new Error("Publish failed");
    const errors: { error: unknown; event: ServiceEvent }[] = [];
    const forwarder = new EventBusForwarder({
      publishEvent() {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      },
    }, (error, event) => errors.push({ error, event }));
    forwarder.publish(event);
    await forwarder.stop();
    expect(errors).toEqual([{ error: failure, event }]);
  });

  test("late device events remain in the local log after forwarding stops", async () => {
    const published: ServiceEvent[] = [];
    const forwarder = new EventBusForwarder({
      async publishEvent(event) { published.push(event); },
    }, () => {});
    const logs = new DeviceEventLogs(200, undefined, forwarder.publish);
    await forwarder.stop();
    const recorded = logs.record("aqara-hub-m2", event.type, event.message, { data: event.data! });
    expect(logs.recent("aqara-hub-m2")).toEqual([recorded]);
    expect(published).toEqual([]);
  });
});
