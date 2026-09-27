import { afterEach, describe, expect, test } from "bun:test";
import mqtt from "mqtt";
import { homeTruthEventTopic, startMqttBroker, type MqttBroker } from "./index";
import { DogAnnouncer } from "../../automations/dog-announcer";
import { DEFAULT_DOG_CONFIG } from "../../automations/dog-config";

let broker: MqttBroker | undefined;
const clients: ReturnType<typeof mqtt.connect>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.end(true);
  await broker?.stop();
  broker = undefined;
});

function connect(port: number, options: Parameters<typeof mqtt.connect>[1] = {}) {
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { connectTimeout: 2_000, reconnectPeriod: 0, ...options });
  clients.push(client);
  return client;
}

function once<T extends unknown[]>(emitter: { once(event: string, listener: (...args: T) => void): unknown }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, (...args: T) => resolve(args)));
}

describe("startMqttBroker", () => {
  test("picks a free port by default and reports it", async () => {
    broker = await startMqttBroker();
    expect(broker.port).toBeGreaterThan(0);
  });

  test("delivers a published message to a subscriber on the same topic, and nowhere else", async () => {
    broker = await startMqttBroker();
    const publisher = connect(broker.port, { clientId: "publisher" });
    await once(publisher, "connect");

    const received: { topic: string; payload: string }[] = [];
    broker.onMessage("thingino/porch", (topic, payload) => received.push({ topic, payload: payload.toString() }));
    broker.onMessage("thingino/other", () => received.push({ topic: "other", payload: "should not happen" }));

    publisher.publish("thingino/porch", JSON.stringify({ camera_id: "abc", timestamp: 1_000 }));
    await Bun.sleep(200);

    expect(received).toEqual([{ topic: "thingino/porch", payload: JSON.stringify({ camera_id: "abc", timestamp: 1_000 }) }]);
  });

  test("an unsubscribe function stops further delivery to that handler only", async () => {
    broker = await startMqttBroker();
    const publisher = connect(broker.port, { clientId: "publisher" });
    await once(publisher, "connect");

    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = broker.onMessage("thingino/porch", (_topic, payload) => first.push(payload.toString()));
    broker.onMessage("thingino/porch", (_topic, payload) => second.push(payload.toString()));

    publisher.publish("thingino/porch", "one");
    await Bun.sleep(150);
    stopFirst();
    publisher.publish("thingino/porch", "two");
    await Bun.sleep(150);

    expect(first).toEqual(["one"]);
    expect(second).toEqual(["one", "two"]);
  });

  test("enforces credentials when configured, rejecting a bad password and admitting the right one", async () => {
    broker = await startMqttBroker({ credentials: { username: "wyze-cam-v3", password: "s3cret" } });

    const badClient = connect(broker.port, { clientId: "bad", username: "wyze-cam-v3", password: "wrong" });
    const [badError] = await once<[Error]>(badClient, "error");
    expect(badError).toBeDefined();

    // A short settle delay before the next connection: opening a second raw
    // TCP connection immediately after a server-side auth rejection tends to
    // segfault Bun's `node:net` implementation (reproduced in isolation,
    // 2026-09-05, deterministic; not present when this test runs alone with
    // a delay, and not a bug in this module or in aedes/aedes-server-factory,
    // which behave identically under plain Node). Worth revisiting once a
    // Bun release fixes the underlying race.
    await Bun.sleep(100);
    const goodClient = connect(broker.port, { clientId: "good", username: "wyze-cam-v3", password: "s3cret" });
    await expect(once(goodClient, "connect")).resolves.toBeDefined();
  });

  test("stop() closes the listener so a new connection is refused", async () => {
    broker = await startMqttBroker();
    const port = broker.port;
    await broker.stop();
    broker = undefined;

    const client = connect(port, { clientId: "after-stop" });
    const [error] = await once<[Error]>(client, "error");
    expect(error).toBeDefined();
  });

  test("stop() disconnects a persistent subscriber before awaiting the listener and allows a restart", async () => {
    broker = await startMqttBroker({ hostname: "127.0.0.1" });
    const port = broker.port;
    const client = connect(port, { clientId: "frigate-persistent" });
    await once(client, "connect");
    const closed = once(client, "close");
    // The old ordering would wait indefinitely for this still-connected client.
    const firstStop = broker.stop();
    expect(broker.stop()).toBe(firstStop);
    await Promise.all([firstStop, closed]);
    expect(broker.status().availability).toBe("offline");
    broker = await startMqttBroker({ port, hostname: "127.0.0.1" });
    const reconnected = connect(port, { clientId: "frigate-reconnected" });
    await once(reconnected, "connect");
    expect(broker.status().availability).toBe("online");
  });
});

describe("MqttBroker as a Service", () => {
  test("the first dog detection reaches MQTT even when speech fails", async () => {
    broker = await startMqttBroker();
    const client = connect(broker.port);
    await once(client, "connect");
    const topic = `hometruth/events/example-camera-2/dog_detected`;
    await client.subscribeAsync(topic);
    const message = once<[string, Buffer]>(client, "message");
    const publishes: Promise<void>[] = [];
    const automation = new DogAnnouncer({
      store: { load: async () => ({ ...DEFAULT_DOG_CONFIG, enabled: true, cameraId: "example-camera-2" }), save: async () => {} },
      detect: async () => ({ source: "frigate", camera: "kitchen", dog: true, capturedAt: 0, imageHash: "a".repeat(64), elapsedMs: 500 }),
      speak: async () => { throw new Error("Speaker offline"); }, validate: () => {},
    });
    const unsubscribe = automation.subscribe(event => { publishes.push(broker!.publishEvent(event)); });
    try {
      await automation.start(); await automation.check(); await Promise.all(publishes);
      const [receivedTopic, bytes] = await message;
      expect(receivedTopic).toBe(topic);
      expect(JSON.parse(bytes.toString())).toMatchObject({ type: `dog_detected`, subject: "example-camera-2", data: { source: "frigate", camera: "kitchen" } });
    } finally { unsubscribe(); await automation.stop(); }
  });

  test("status() reports online with the listen address and live client count", async () => {
    broker = await startMqttBroker();
    expect(broker.status()).toEqual({ availability: "online", detail: `Listening on 0.0.0.0:${broker.port}, 0 clients connected` });

    const client = connect(broker.port, { clientId: "watcher" });
    await once(client, "connect");
    expect(broker.status().detail).toBe(`Listening on 0.0.0.0:${broker.port}, 1 client connected`);
  });

  test("status() reports offline after stop()", async () => {
    broker = await startMqttBroker();
    await broker.stop();
    const status = broker.status();
    broker = undefined;
    expect(status).toEqual({ availability: "offline", detail: "Stopped" });
  });

  test("logs a started event immediately, then connect, publish, and disconnect events as they happen", async () => {
    broker = await startMqttBroker();
    const startedEvents = broker.events().filter((event) => event.type === "started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]?.data).toEqual({ hostname: "0.0.0.0", port: broker.port });

    const client = connect(broker.port, { clientId: "logged-client" });
    await once(client, "connect");
    client.publish("thingino/porch", "hello");
    await Bun.sleep(150);
    client.end(true);
    await Bun.sleep(150);

    const types = broker.events().map((event) => event.type);
    expect(types).toContain("client_connected");
    expect(types).toContain("message_published");
    expect(types).toContain("client_disconnected");

    const published = broker.events().find((event) => event.type === "message_published");
    expect(published?.data).toMatchObject({ clientId: "logged-client", topic: "thingino/porch" });
  });

  test("events() returns newest first and honors a limit", async () => {
    broker = await startMqttBroker();
    const client = connect(broker.port, { clientId: "many-events" });
    await once(client, "connect");
    client.publish("thingino/a", "1");
    client.publish("thingino/b", "2");
    await Bun.sleep(150);

    const all = broker.events();
    const first = all[0];
    const last = all[all.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect((first?.at ?? "") >= (last?.at ?? "")).toBe(true);
    expect(broker.events(1)).toHaveLength(1);
  });

  test("logs a connection_rejected event for a bad password", async () => {
    broker = await startMqttBroker({ credentials: { username: "u", password: "right" } });
    const bad = connect(broker.port, { clientId: "bad", username: "u", password: "wrong" });
    await once<[Error]>(bad, "error");
    await Bun.sleep(100);
    expect(broker.events().some((event) => event.type === "connection_rejected" && event.level === "warn")).toBe(true);
  });

  test("publishes normalized HomeTruth events and mirrors them in the unified broker log", async () => {
    broker = await startMqttBroker();
    const subscriber = connect(broker.port, { clientId: "event-observer" });
    await once(subscriber, "connect");
    const topic = homeTruthEventTopic({ subject: "gate-relay", type: "device_control" });
    await new Promise<void>((resolve, reject) => subscriber.subscribe(topic, (error) => error ? reject(error) : resolve()));
    const received = once<[string, Buffer]>(subscriber, "message");

    await broker.publishEvent({
      at: "2026-09-08T12:00:00.000Z",
      level: "info",
      type: "device_control",
      message: "Gate relay: toggle",
      subject: "gate-relay",
      data: { control: "toggle" },
    });

    const [receivedTopic, payload] = await received;
    expect(receivedTopic).toBe(topic);
    expect(JSON.parse(payload.toString())).toMatchObject({ type: "device_control", subject: "gate-relay", data: { control: "toggle" } });
    expect(broker.events().find((event) => event.type === "device_control")).toMatchObject({ subject: "gate-relay", message: "Gate relay: toggle" });
    expect(broker.subjects()).toContain("gate-relay");
  });
});
