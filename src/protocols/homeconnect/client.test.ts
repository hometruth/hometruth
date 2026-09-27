import { expect, spyOn, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { HomeConnectCodec } from "./codec";
import { HomeConnectClient, homeConnectApplicationId, type HomeConnectMessage } from "./client";

const key = Buffer.alloc(32, 7), iv = Buffer.alloc(16, 9);
const credentials = { key: key.toString("base64url"), iv: iv.toString("base64url") };
const mac = (key: Buffer, input: string | Buffer) => createHmac("sha256", key).update(input).digest();

/** Device-side reference framing, entirely in memory; no sockets or listeners. */
class ApplianceCodec {
  enc = createCipheriv("aes-256-cbc", mac(key, "ENC"), iv).setAutoPadding(false);
  dec = createDecipheriv("aes-256-cbc", mac(key, "ENC"), iv).setAutoPadding(false);
  tx = Buffer.alloc(16); rx = Buffer.alloc(16);
  tag(direction: number, previous: Buffer, ciphertext: Buffer) { return mac(mac(key, "MAC"), Buffer.concat([iv, Buffer.from([direction]), previous, ciphertext])).subarray(0, 16); }
  encrypt(text: string): ArrayBuffer {
    const bytes = Buffer.from(text); let pad = 16 - bytes.length % 16; if (pad === 1) pad = 17;
    const padding = Buffer.alloc(pad); padding[pad - 1] = pad;
    const encrypted = this.enc.update(Buffer.concat([bytes, padding]));
    this.tx = Buffer.from(this.tag(0x43, this.tx, encrypted));
    return Uint8Array.from(Buffer.concat([encrypted, this.tx])).buffer;
  }
  decrypt(frame: Uint8Array): string {
    const data = Buffer.from(frame), encrypted = data.subarray(0, -16);
    expect(timingSafeEqual(this.tag(0x45, this.rx, encrypted), data.subarray(-16))).toBe(true);
    this.rx = Buffer.from(data.subarray(-16));
    const plain = this.dec.update(encrypted);
    expect(plain[plain.length - plain.at(-1)!]).toBe(0);
    return plain.subarray(0, -plain.at(-1)!).toString();
  }
}

test("AES framing preserves chained messages, UTF-8, and the 17-byte padding case", () => {
  const client = new HomeConnectCodec(credentials.key, credentials.iv), server = new ApplianceCodec();
  for (const text of ["x".repeat(15), "", "café 🍳", "x".repeat(32)]) {
    expect(server.decrypt(client.encrypt(text))).toBe(text);
    expect(client.decrypt(new Uint8Array(server.encrypt(text)))).toBe(text);
  }
});
test("rejects altered, replayed, and malformed authenticated frames", () => {
  const client = new HomeConnectCodec(credentials.key, credentials.iv), server = new ApplianceCodec();
  const frame = new Uint8Array(server.encrypt("observation"));
  const altered = frame.slice(); altered[0] = altered[0]! ^ 1;
  expect(() => client.decrypt(altered)).toThrow("authentication");
  expect(client.decrypt(frame)).toBe("observation");
  expect(() => client.decrypt(frame)).toThrow("authentication");
  expect(() => client.decrypt(new Uint8Array(17))).toThrow("length");
  expect(() => new HomeConnectCodec("bad", credentials.iv)).toThrow("length");
});

class ApplianceSocket {
  readyState: number = WebSocket.OPEN;
  binaryType = "arraybuffer";
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  codec = new ApplianceCodec();
  sent: HomeConnectMessage[] = [];
  values = new Map<number, unknown>([[0x020b, true], [0x020c, false], [0x0235, 0]]);
  descriptions: Record<string, unknown>[] = [];
  dropWrite = false;
  ignoreWrite = false;
  onIdentity?: (identity: string) => void;
  constructor() { queueMicrotask(() => this.emit({ sID: 123, msgID: 7, version: 2, resource: "/ei/initialValues", action: "POST", data: [{ edMsgID: 20 }] })); }
  emit(message: HomeConnectMessage) { this.onmessage?.({ data: this.codec.encrypt(JSON.stringify(message)) }); }
  send(frame: Uint8Array) {
    const m: HomeConnectMessage = JSON.parse(this.codec.decrypt(frame)); this.sent.push(m);
    if (m.resource === "/ei/initialValues" && m.action === "RESPONSE") this.onIdentity?.(String(m.data?.[0]?.deviceID));
    if (m.action === "RESPONSE" || m.action === "NOTIFY") return;
    let data: Record<string, unknown>[] = [];
    if (m.resource === "/ci/services") data = [{ service: "ci", version: 3 }, { service: "ei", version: 2 }, { service: "ro", version: 1 }];
    if (m.resource === "/ro/allDescriptionChanges") data = this.descriptions;
    if (m.resource === "/ro/allMandatoryValues") data = [...this.values].map(([uid, value]) => ({ uid, value }));
    if (m.action === "POST") {
      if (this.dropWrite) { queueMicrotask(() => this.onclose?.()); return; }
      for (const row of m.data ?? []) if (!this.ignoreWrite) this.values.set(row.uid as number, row.value);
    }
    queueMicrotask(() => this.emit({ ...m, action: "RESPONSE", data }));
  }
  close() { this.readyState = WebSocket.CLOSED; }
}
function setup(createSocket = () => new ApplianceSocket()) {
  const sockets: ApplianceSocket[] = [];
  const client = new HomeConnectClient({ host: "10.78.0.40", ...credentials, id: "test-cooktop", timeoutMs: 100,
    socketFactory: url => { expect(url).toBe("ws://10.78.0.40:80/homeconnect"); const socket = createSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
  });
  return { client, sockets };
}
test("shares reads, negotiates services, and verifies a child-lock write", async () => {
  const { client, sockets } = setup();
  try {
    const [a, b] = await Promise.all([client.read(), client.read()]);
    expect(a.values.get(0x020c)).toBe(false); expect(b.observedAt).toBe(a.observedAt);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.find(m => m.resource === "/ei/initialValues")?.data?.[0]?.deviceID)
      .toBe(homeConnectApplicationId("test-cooktop", hostname(), process.cwd()));
    expect(sockets[0]!.sent.filter(m => m.resource === "/ro/allMandatoryValues")).toHaveLength(1);
    await client.set(0x020c, true);
    expect((await client.read()).values.get(0x020c)).toBe(true);
    expect(sockets[0]!.sent.some(m => m.resource === "/ci/authentication")).toBe(false);
    expect(sockets[0]!.sent.find(m => m.resource === "/ei/deviceReady")?.version).toBe(2);
    const ids = sockets[0]!.sent.filter(m => m.action !== "RESPONSE").map(m => m.msgID);
    expect(new Set(ids).size).toBe(ids.length);
  } finally { client.close(); }
});
test("application identities separate development and production without changing on reconnect", () => {
  const identity = homeConnectApplicationId("hob", "home-server", "/installations/home");
  expect(identity).toMatch(/^[a-f0-9]{24}$/u);
  expect(homeConnectApplicationId("hob", "home-server", "/installations/home")).toBe(identity);
  expect(homeConnectApplicationId("hob", "dev-laptop", "/installations/home")).not.toBe(identity);
  expect(homeConnectApplicationId("hob", "home-server", "/installations/development")).not.toBe(identity);
  expect(homeConnectApplicationId("second-hob", "home-server", "/installations/home")).not.toBe(identity);
});
test("two installations with the same device ID do not evict each other's appliance sessions", async () => {
  const peers = new Map<string, ApplianceSocket>();
  const appliance = () => {
    const socket = new ApplianceSocket();
    socket.onIdentity = identity => {
      const previous = peers.get(identity);
      if (previous && previous !== socket) previous.onclose?.();
      peers.set(identity, socket);
    };
    return socket;
  };
  const cwd = spyOn(process, "cwd");
  let development: ReturnType<typeof setup>, production: ReturnType<typeof setup>;
  try {
    cwd.mockReturnValue("/installations/development");
    development = setup(appliance);
    cwd.mockReturnValue("/installations/production");
    production = setup(appliance);
  } finally { cwd.mockRestore(); }
  try {
    await development.client.read();
    await production.client.read();
    expect((await development.client.read()).values.get(0x020c)).toBe(false);
    expect((await production.client.read()).values.get(0x020c)).toBe(false);
    expect(development.sockets).toHaveLength(1);
    expect(production.sockets).toHaveLength(1);
    expect(development.sockets[0]!.readyState).toBe(WebSocket.OPEN);
    expect(production.sockets[0]!.readyState).toBe(WebSocket.OPEN);
    expect([...peers.values()].flatMap(peer => peer.sent).some(m => m.action === "POST")).toBe(false);
  } finally { development.client.close(); production.client.close(); }
});
test("forbids burner writes and honours remote-control and parent permissions", async () => {
  const { client, sockets } = setup();
  try {
    await expect(client.set(0x021b, 2)).rejects.toThrow("Unsupported");
    expect(sockets).toHaveLength(0);
    await client.read();
    sockets[0]!.emit({ sID: 123, msgID: 80, version: 1, action: "NOTIFY", resource: "/ro/descriptionChange", data: [{ uid: 0x0103, access: "READ" }] });
    await expect(client.set(0x020c, true)).rejects.toThrow("does not allow");
    expect(sockets[0]!.sent.some(m => m.action === "POST")).toBe(false);
  } finally { client.close(); }
});
test("does not report unconfirmed writes as success", async () => {
  const { client, sockets } = setup();
  try { await client.read(); sockets[0]!.ignoreWrite = true; await expect(client.set(0x020c, true)).rejects.toThrow("not confirmed"); }
  finally { client.close(); }
});
test("failed commands are never replayed; a later read can reconnect", async () => {
  const { client, sockets } = setup();
  try {
    await client.read(); sockets[0]!.dropWrite = true;
    await expect(client.set(0x020c, true)).rejects.toThrow("closed");
    expect((await client.read()).values.get(0x020c)).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent.find(m => m.resource === "/ei/initialValues")?.data?.[0]?.deviceID)
      .toBe(sockets[0]!.sent.find(m => m.resource === "/ei/initialValues")?.data?.[0]?.deviceID);
    expect(sockets[1]!.sent.some(m => m.action === "POST")).toBe(false);
  } finally { client.close(); }
  await expect(client.read()).rejects.toThrow("closed");
});
test("rejects public hosts before opening a connection", () => {
  expect(() => new HomeConnectClient({ host: "example.com", ...credentials, id: "test" })).toThrow("private LAN");
});
