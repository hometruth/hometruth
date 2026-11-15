import { describe, expect, test } from "bun:test";
import { RoborockError, RoborockLocalClient } from "./client";
import { FakeRoborock, fakeStatus } from "./fake-device";

const LOCAL_KEY = "AbCdEfGh12345678";

function client(robot: FakeRoborock, options: { timeoutMs?: number; idleMs?: number; pingMs?: number } = {}) {
  return new RoborockLocalClient({ host: "10.77.0.40", localKey: LOCAL_KEY, connect: robot.connect, timeoutMs: options.timeoutMs ?? 200, ...options });
}

describe("RoborockLocalClient", () => {
  test("says hello once, then serves RPCs on the same session", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, methods: { get_status: { result: fakeStatus() }, app_start: { result: ["ok"] } } });
    const session = client(robot);
    expect(await session.rpc("get_status")).toEqual(fakeStatus());
    expect(await session.rpc("app_start")).toEqual(["ok"]);
    expect(robot.connections).toBe(1);
    expect(robot.requests.map((request) => request.method ?? request.protocol)).toEqual([0, "get_status", "app_start"]);
    expect(robot.requests[1]).toMatchObject({ protocol: 4, params: [] });
    session.close();
    expect(robot.closes).toBe(1);
  });

  test("serializes concurrent calls and matches replies by id", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, fragment: true, replyProtocol: 5, methods: { get_status: { result: fakeStatus() }, find_me: { result: ["ok"] } } });
    const session = client(robot);
    const results = await Promise.all([session.rpc("get_status"), session.rpc("find_me"), session.rpc("get_status")]);
    expect(results).toEqual([fakeStatus(), ["ok"], fakeStatus()]);
    const ids = robot.requests.flatMap((request) => request.id ?? []);
    expect(new Set(ids).size).toBe(3);
    session.close();
  });

  test("ignores unsolicited pushes while waiting", async () => {
    let robot!: FakeRoborock;
    robot = new FakeRoborock({ localKey: LOCAL_KEY, methods: { get_status: () => { robot.push(); return { result: fakeStatus() }; } } });
    const session = client(robot);
    expect(await session.rpc("get_status")).toEqual(fakeStatus());
    session.close();
  });

  test("a device error is rejected, not unreachable", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, methods: { app_start: { error: { code: -10007, message: "invalid status" } } } });
    const session = client(robot);
    const error = await session.rpc("app_start").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RoborockError);
    expect(error).toMatchObject({ code: "rejected" });
    session.close();
  });

  test("a refused connection is unreachable", async () => {
    const error = await client(new FakeRoborock({ localKey: LOCAL_KEY, refuse: true })).rpc("get_status").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "RoborockError", code: "unreachable" });
  });

  test("a silent robot times out and the next call reconnects", async () => {
    let silent = true;
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, methods: { get_status: () => silent ? "silent" : { result: fakeStatus() } } });
    const session = client(robot, { timeoutMs: 50 });
    expect(await session.rpc("get_status").catch((caught: unknown) => caught)).toMatchObject({ code: "timeout" });
    silent = false;
    expect(await session.rpc("get_status")).toEqual(fakeStatus());
    expect(robot.connections).toBe(2);
    session.close();
  });

  test("no hello reply means no session", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, silentHello: true });
    expect(await client(robot, { timeoutMs: 50 }).rpc("get_status").catch((caught: unknown) => caught)).toMatchObject({ code: "timeout" });
    expect(robot.requests.map((request) => request.protocol)).toEqual([0]);
    expect(robot.closes).toBe(1);
  });

  test("replies under a different key fail as a local-key protocol error", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, replyKey: "ZyXwVuTs98765432", methods: { get_status: { result: fakeStatus() } } });
    const error = await client(robot).rpc("get_status").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "protocol" });
    expect(String((error as Error).message)).toContain("local key");
  });

  test("a hang-up fails the waiting call and the next call reconnects", async () => {
    let robot!: FakeRoborock;
    let first = true;
    robot = new FakeRoborock({ localKey: LOCAL_KEY, methods: { get_status: () => { if (first) { first = false; queueMicrotask(() => robot.hangUp()); return "silent"; } return { result: fakeStatus() }; } } });
    const session = client(robot);
    expect(await session.rpc("get_status").catch((caught: unknown) => caught)).toMatchObject({ code: "unreachable" });
    expect(await session.rpc("get_status")).toEqual(fakeStatus());
    expect(robot.connections).toBe(2);
    session.close();
  });

  test("pings while held and closes when idle", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, methods: { get_status: { result: fakeStatus() } } });
    const session = client(robot, { pingMs: 20, idleMs: 90 });
    await session.rpc("get_status");
    await Bun.sleep(150);
    expect(robot.requests.filter((request) => request.protocol === 2).length).toBeGreaterThanOrEqual(2);
    expect(robot.closes).toBe(1);
  });
});
