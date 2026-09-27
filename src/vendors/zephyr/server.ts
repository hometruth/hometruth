import { Aedes } from "aedes";
import { createSecureContext, createServer as createTlsServer, type TLSSocket } from "node:tls";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";
import { isObject, parseTopic, ShadowError } from "../../protocols/zephyr/shadow";
import { allowedResponse, ZephyrController } from "./controller";
import { privateAudit, readState, savePrivate, type ZephyrConfig } from "./files";

export function authorizedAdmin(header: string | undefined, expected: string): boolean {
  const actual = Buffer.from(header ?? "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export async function readCommandBody(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 4096) throw new ShadowError(413, "Command body is too large");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ShadowError(400, "Invalid JSON"); }
}

/** Explicit startup only. Importing this module never opens a listener. */
export async function startZephyrServer(directory: string, config: ZephyrConfig) {
  const [key, cert, state] = await Promise.all([readFile(join(directory, "server.key")), readFile(join(directory, "server.crt")), readState(directory)]);
  // Fail on invalid TLS material before creating the broker's timers.
  createSecureContext({ key, cert });
  const audit = privateAudit(directory);
  const broker = await Aedes.createBroker({ connectTimeout: 15_000, drainTimeout: 15_000, queueLimit: 10, maxClientsIdLength: 128, maxTopicLevels: 10 });
  const controller = new ZephyrController({ deviceIp: config.deviceIp, enrollFirstCertificate: config.enrollFirstCertificate, state,
    save: next => savePrivate(join(directory, "state.json"), next), audit,
    publish: async message => {
      audit("mqtt_response", { topic: message.topic, body: message.body });
      await new Promise<void>((resolve, reject) => broker.publish({ cmd: "publish", topic: message.topic, payload: Buffer.from(JSON.stringify(message.body)), qos: 1, retain: false, dup: false }, error => error ? reject(error) : resolve()));
    },
  });
  const sockets = new Set<Socket>();
  let lastTls: Record<string, unknown> | null = null;
  const noteTls = (event: string, data: Record<string, unknown>) => { lastTls = { event, at: new Date().toISOString(), ...data }; audit(event, data); };
  broker.authenticate = (client, _username, _password, done) => {
    const socket = client.conn as TLSSocket;
    void controller.authenticate(socket.remoteAddress, client.id, socket.getPeerCertificate()?.fingerprint256).then(() => done(null, true), error => {
      audit("mqtt_auth_rejected", { message: String(error) });
      done(Object.assign(new Error("Device authentication failed"), { returnCode: 5 }), false);
    });
  };
  broker.authorizeSubscribe = (_client, sub, done) => {
    void controller.subscribe(sub.topic).then(() => done(null, sub), error => {
      audit("subscription_rejected", { topic: sub.topic, message: String(error) });
      done(null, null);
    });
  };
  broker.authorizePublish = (client, packet, done) => {
    if (!client) { done(); return; }
    const bytes = Buffer.byteLength(packet.payload);
    if (packet.retain || packet.qos > 1 || bytes > 16_384) {
      audit("mqtt_request_rejected", { topic: packet.topic, qos: packet.qos, retain: packet.retain, bytes,
        ...(bytes <= 16_384 ? { payloadBase64: Buffer.from(packet.payload).toString("base64") } : {}) });
      done(new Error("Unsupported retained, QoS 2, or oversized request")); return;
    }
    // Process before PUBACK. Response publication is from the broker, so it
    // cannot recursively enter this device request handler.
    void controller.receive(packet.topic, Buffer.from(packet.payload)).then(() => done(), error => {
      audit("request_failed", { topic: packet.topic, message: String(error) });
      done(new Error("Shadow request failed"));
    });
  };
  broker.authorizeForward = (_client, packet) => allowedResponse(packet.topic) && parseTopic(packet.topic)?.thing === controller.snapshot().thing ? packet : null;
  const connectionKey = (client: { id: string; conn: unknown }) => `${client.id}:${(client.conn as TLSSocket).remotePort}`;
  broker.on("clientReady", client => controller.connection(connectionKey(client), true));
  broker.on("clientDisconnect", client => controller.connection(connectionKey(client), false));
  broker.on("clientError", (_client, error) => audit("mqtt_client_error", { message: error.message }));
  broker.on("connectionError", (_client, error) => audit("mqtt_connection_error", { message: error.message }));
  broker.on("ping", (_packet, client) => audit("mqtt_ping", { clientId: client.id }));

  const tls = createTlsServer({ key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", ecdhCurve: "prime256v1",
    ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-SHA256", honorCipherOrder: true,
    // Request the device certificate without assuming access to AWS's CA.
    // MQTT authentication pins the first certificate from the configured IP;
    // TLS still verifies proof of possession of its private key.
    requestCert: true, rejectUnauthorized: false, handshakeTimeout: 15_000,
  }, socket => {
    if (socket.remoteAddress !== config.deviceIp) { socket.destroy(); return; }
    noteTls("tls_established", { protocol: socket.getProtocol(), cipher: socket.getCipher().name, hasClientCertificate: Boolean(socket.getPeerCertificate()?.raw) });
    const client = broker.handle(socket);
    client.on("error", error => audit("mqtt_error", { message: error.message }));
  });
  tls.maxConnections = 4;
  tls.on("connection", socket => {
    if (socket.remoteAddress !== config.deviceIp) { socket.destroy(); return; }
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    noteTls("tcp_connected", {});
  });
  tls.on("tlsClientError", error => noteTls("tls_failed", { code: (error as NodeJS.ErrnoException).code ?? "TLS_ERROR", message: error.message }));

  const respond = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorizedAdmin(req.headers.authorization, config.adminToken)) { respond(res, 401, { error: "Unauthorized" }); return; }
    if (req.headers.origin) { respond(res, 403, { error: "Browser origins are not allowed" }); return; }
    if (req.method === "GET" && req.url === "/status") {
      respond(res, 200, { service: "zephyr-emulator", listening: tls.listening, deviceIp: config.deviceIp, listenIp: config.listenIp, mqttPort: config.mqttPort, lastTls, ...controller.snapshot() });
    } else if (req.method === "POST" && req.url === "/command") {
      const body = await readCommandBody(req);
      if (!isObject(body)) throw new ShadowError(400, "Supply a JSON control object");
      respond(res, 202, await controller.command(body));
    } else respond(res, 404, { error: "Not found" });
  };
  const admin = createHttpServer((req, res) => { void handler(req, res).catch(error => respond(res, error instanceof ShadowError ? error.code : 409, { error: error.message })); });
  admin.requestTimeout = 5000;
  admin.headersTimeout = 5000;
  admin.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    // Stop accepting first, then terminate idle TLS/HTTP peers and the broker.
    const closeTls = new Promise<void>(resolve => tls.close(() => resolve()));
    const closeAdmin = new Promise<void>(resolve => admin.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => broker.close(resolve));
    await Promise.all([closeTls, closeAdmin]);
    audit("stopped", {});
  })();
  try {
    await new Promise<void>((resolve, reject) => { tls.once("error", reject); tls.listen(config.mqttPort, config.listenIp, () => { tls.off("error", reject); resolve(); }); });
    await new Promise<void>((resolve, reject) => { admin.once("error", reject); admin.listen(config.adminPort, "127.0.0.1", () => { admin.off("error", reject); resolve(); }); });
    audit("started", { listenIp: config.listenIp, mqttPort: config.mqttPort, adminPort: config.adminPort });
    return { close, controller };
  } catch (error) { await close(); throw error; }
}
