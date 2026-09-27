import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { buildDtls } from "./build-dtls";
import { DtlsEndpoint } from "./dtls";
import { buildHueStreamFrame } from "../../vendors/hue/entertainment-protocol";

let directory: string, helper: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "hue-dtls-test-")); helper = await buildDtls(join(directory, "dtls")); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
export async function freeUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}
test("native DTLS authenticates and preserves variable record boundaries in both directions", async () => {
  const received: Buffer[] = [], returned: Buffer[] = [];
  const config = { helperPath: helper, host: "127.0.0.1", port: await freeUdpPort(), identity: "hometruth-test", key: "11".repeat(16), closed() {} };
  const server = new DtlsEndpoint({ ...config, mode: "server", frame: frame => received.push(frame) });
  let client: DtlsEndpoint | undefined;
  try {
    await server.ready;
    client = new DtlsEndpoint({ ...config, mode: "client", frame: frame => returned.push(frame) });
    await Promise.all([server.connected, client.connected]);
    const area = "12345678-1234-1234-1234-123456789abc";
    const frames = [buildHueStreamFrame(area, 1, [{ channel: 1, r: 255, g: 0, b: 0 }]), buildHueStreamFrame(area, 2, [{ channel: 1, r: 0, g: 255, b: 0 }, { channel: 2, r: 0, g: 0, b: 255 }])];
    for (const frame of frames) client.send(frame);
    await waitUntil(() => received.length === 2);
    expect(received).toEqual(frames.map(frame => Buffer.from(frame)));
    server.send(Buffer.from("return record"));
    await waitUntil(() => returned.length === 1);
    expect(returned[0]!.toString()).toBe("return record");
  } finally { await Promise.all([server.stop(), client?.stop()]); }
}, 10000);

test("native DTLS rejects a wrong PSK without exposing any frame", async () => {
  let frames = 0;
  const config = { helperPath: helper, host: "127.0.0.1", port: await freeUdpPort(), identity: "hometruth-test", frame: () => { frames++; }, closed() {} };
  const server = new DtlsEndpoint({ ...config, mode: "server", key: "11".repeat(16) });
  let client: DtlsEndpoint | undefined;
  try {
    await server.ready;
    client = new DtlsEndpoint({ ...config, mode: "client", key: "22".repeat(16) });
    const connected = await Promise.race([client.connected.then(() => true, () => false), Bun.sleep(1200).then(() => false)]);
    expect(connected).toBe(false);
    expect(frames).toBe(0);
  } finally { await Promise.all([server.stop(), client?.stop()]); }
}, 10000);

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
