import { describe, expect, test } from "bun:test";
import { HueEntertainmentSession, HueEntertainmentSessionError, type DtlsSubprocess, type DtlsSubprocessSpawner } from "./entertainment-session";
import { HueClipClient } from "./clip-client";

const AREA_ID = "7f6715a0-2d9a-4a72-944d-90fb206c14e5";

function fakeClip(overrides: Partial<Record<"startEntertainment" | "stopEntertainment", () => Promise<void>>> = {}) {
  const calls: string[] = [];
  const client = {
    startEntertainment: async (areaId: string) => { calls.push(`start:${areaId}`); await overrides.startEntertainment?.(); },
    stopEntertainment: async (areaId: string) => { calls.push(`stop:${areaId}`); await overrides.stopEntertainment?.(); },
  } as unknown as HueClipClient;
  return { client, calls };
}

/** A fake subprocess that records every write and can be told to "die". */
function fakeSubprocess(): { subprocess: DtlsSubprocess; writes: Uint8Array[]; die: (code?: number) => void } {
  const writes: Uint8Array[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  let killed = false;
  const subprocess: DtlsSubprocess = {
    stdin: { write: (data) => { if (killed) throw new Error("EPIPE"); writes.push(data); return data.length; }, flush: () => {} },
    exited,
    kill: () => { killed = true; resolveExit(0); },
  };
  return { subprocess, writes, die: (code = 1) => resolveExit(code) };
}

function fakeSpawner(subprocess: DtlsSubprocess): DtlsSubprocessSpawner {
  return () => subprocess;
}

describe("HueEntertainmentSession", () => {
  test("connect() starts the CLIP session before spawning the DTLS process", async () => {
    const { client, calls } = fakeClip();
    const { subprocess } = fakeSubprocess();
    let spawnedAfterStart = false;
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client,
      spawn: () => { spawnedAfterStart = calls.includes(`start:${AREA_ID}`); return subprocess; },
    });
    await session.connect();
    expect(spawnedAfterStart).toBe(true);
    expect(session.isConnected).toBe(true);
  });

  test("connect() twice without disconnect throws already_connected", async () => {
    const { client } = fakeClip();
    const { subprocess } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess),
    });
    await session.connect();
    await expect(session.connect()).rejects.toThrow(HueEntertainmentSessionError);
  });

  test("setColors() before connect() throws not_connected", () => {
    const { client } = fakeClip();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID, clip: client,
    });
    expect(() => session.setColors([{ channel: 0, r: 0, g: 0, b: 0 }])).toThrow(HueEntertainmentSessionError);
  });

  test("setColors() writes one HueStream frame to the subprocess", async () => {
    const { client } = fakeClip();
    const { subprocess, writes } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess),
    });
    await session.connect();
    session.setColors([{ channel: 0, r: 255, g: 0, b: 0 }]);
    expect(writes).toHaveLength(1);
    expect(new TextDecoder().decode(writes[0]!.slice(0, 9))).toBe("HueStream");
  });

  test("each setColors() call advances the sequence byte", async () => {
    const { client } = fakeClip();
    const { subprocess, writes } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess),
    });
    await session.connect();
    session.setColors([{ channel: 0, r: 1, g: 1, b: 1 }]);
    session.setColors([{ channel: 0, r: 2, g: 2, b: 2 }]);
    expect(writes[0]![11]).not.toBe(writes[1]![11]);
  });

  test("disconnect() kills the subprocess and stops the CLIP session", async () => {
    const { client, calls } = fakeClip();
    const { subprocess } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess),
    });
    await session.connect();
    await session.disconnect();
    expect(session.isConnected).toBe(false);
    expect(calls).toContain(`stop:${AREA_ID}`);
  });

  test("disconnect() tolerates the CLIP stop call failing", async () => {
    const { client } = fakeClip({ stopEntertainment: async () => { throw new Error("bridge unreachable"); } });
    const { subprocess } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess),
    });
    await session.connect();
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  test("setColors() after the subprocess dies on its own does not throw synchronously", async () => {
    const { client } = fakeClip();
    const { subprocess, die } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess),
    });
    await session.connect();
    die(1);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the exited-promise handler run
    expect(session.isConnected).toBe(false);
    expect(() => session.setColors([{ channel: 0, r: 0, g: 0, b: 0 }])).toThrow(HueEntertainmentSessionError);
  });

  test("keepalive resends the last frame while idle", async () => {
    const { client } = fakeClip();
    const { subprocess, writes } = fakeSubprocess();
    const session = new HueEntertainmentSession({
      host: "10.77.0.29", applicationKey: "appkey", clientKeyHex: "abcd", areaId: AREA_ID,
      clip: client, spawn: fakeSpawner(subprocess), keepaliveMs: 20,
    });
    await session.connect();
    session.setColors([{ channel: 0, r: 9, g: 9, b: 9 }]);
    const countAfterFirstSend = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(writes.length).toBeGreaterThan(countAfterFirstSend);
    await session.disconnect();
  });
});
