import { randomUUID } from "node:crypto";
import { emptyShadow, isObject, merge, parseTopic, ShadowError, shadowRequest, type ObjectValue, type ShadowMessage, type ShadowRecord } from "../../protocols/zephyr/shadow";

export interface Enrollment { fingerprint: string; clientId: string }
export interface EmulatorState {
  format: 1;
  enrollment: Enrollment | null;
  thing: string | null;
  shadow: ShadowRecord;
  deviceReported: ObjectValue;
  lastDeviceReportAt: number | null;
  lastCommand: { token: string; patch: ObjectValue; at: number; status: "published_unconfirmed" | "delivery_uncertain" } | null;
}
export const initialState = (): EmulatorState => ({ format: 1, enrollment: null, thing: null, shadow: emptyShadow(), deviceReported: {}, lastDeviceReportAt: null, lastCommand: null });
export interface ControllerOptions {
  deviceIp: string;
  enrollFirstCertificate: boolean;
  state: EmulatorState;
  save(state: EmulatorState): Promise<void>;
  publish(message: ShadowMessage): Promise<void>;
  audit(event: string, data: Record<string, unknown>): void;
  now?: () => number;
}
const requests = new Set(["get", "update", "delete"]);
const responses = new Set(["get/accepted", "get/rejected", "update/accepted", "update/rejected", "update/delta", "update/documents", "delete/accepted", "delete/rejected"]);
export function allowedSubscription(topic: string): boolean {
  const parsed = parseTopic(topic);
  return Boolean(parsed && (responses.has(parsed.suffix) || ["#", "+/+", "get/+", "update/+", "delete/+"].includes(parsed.suffix)));
}
export function allowedResponse(topic: string): boolean { const parsed = parseTopic(topic); return Boolean(parsed && responses.has(parsed.suffix)); }

/** Queues mutations, persists before responses, and keeps device reports separate
 * from commands (Zephyr's app writes commands into reported, not desired).
 * No sockets, timers, TLS or broker creation here.
 */
export class ZephyrController {
  private state: EmulatorState;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private connected = new Set<string>();
  constructor(private readonly options: ControllerOptions) { this.state = structuredClone(options.state); }
  private now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }
  snapshot() { return { ...structuredClone(this.state), connected: this.connected.size > 0 }; }
  connection(clientId: string, online: boolean): void {
    if (online) this.connected.add(clientId); else this.connected.delete(clientId);
    this.options.audit(online ? "mqtt_connected" : "mqtt_disconnected", { clientId });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 10) return Promise.reject(new ShadowError(429, "Too many in-flight requests"));
    this.pending++;
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined).finally(() => { this.pending--; });
    return next;
  }
  private async commit(next: EmulatorState): Promise<void> {
    await this.options.save(next);
    this.state = next;
  }
  authenticate(ip: string | undefined, clientId: string, fingerprint: string | undefined): Promise<void> {
    return this.serial(async () => {
      if (ip !== this.options.deviceIp) throw new Error("Unexpected device IP");
      if (!fingerprint || !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(fingerprint)) throw new Error("Device did not present an X.509 certificate");
      if (!clientId || Buffer.byteLength(clientId) > 128) throw new Error("Invalid MQTT client ID");
      const normalized = fingerprint.toUpperCase();
      const pin = this.state.enrollment;
      if (pin && (pin.fingerprint !== normalized || pin.clientId !== clientId)) throw new Error("Device certificate or client ID does not match enrollment");
      if (!pin) {
        if (!this.options.enrollFirstCertificate) throw new Error("Certificate enrollment is disabled");
        await this.commit({ ...this.state, enrollment: { fingerprint: normalized, clientId } });
        this.options.audit("certificate_enrolled", { clientId, fingerprint: normalized });
      }
    });
  }
  private async bind(topic: string): Promise<void> {
    const parsed = parseTopic(topic);
    if (!parsed) throw new Error("Unsupported topic");
    if (this.state.thing && this.state.thing !== parsed.thing) throw new Error("Topic is for a different thing");
    if (!this.state.thing) {
      await this.commit({ ...this.state, thing: parsed.thing });
      this.options.audit("thing_learned", { thing: parsed.thing });
    }
  }
  subscribe(topic: string): Promise<void> {
    return this.serial(async () => {
      this.options.audit("mqtt_subscribe", { topic });
      if (!allowedSubscription(topic)) throw new Error("Unsupported subscription (retained in the private journal)");
      await this.bind(topic);
    });
  }
  receive(topic: string, payload: Uint8Array): Promise<void> {
    return this.serial(async () => {
      this.options.audit("mqtt_request", { topic, bytes: payload.byteLength, payloadBase64: Buffer.from(payload).toString("base64") });
      const parsed = parseTopic(topic);
      if (!parsed || !requests.has(parsed.suffix)) throw new Error("Unsupported publish topic (retained in the private journal)");
      await this.bind(topic);
      const now = this.now();
      const result = shadowRequest(this.state.shadow, topic, payload, now);
      if (result.accepted && parsed.suffix !== "get") {
        const next = { ...this.state, shadow: result.record };
        if (parsed.suffix === "update") {
          const accepted = result.messages[0]!.body.state;
          if (isObject(accepted) && "reported" in accepted) {
            next.deviceReported = accepted.reported === null ? {} : merge(next.deviceReported, accepted.reported as ObjectValue);
            next.lastDeviceReportAt = now;
          }
        }
        // A failed save produces no /accepted response and leaves the old state.
        await this.commit(next);
      }
      for (const message of result.messages) await this.options.publish(message);
    });
  }
  command(patch: ObjectValue): Promise<{ token: string; status: "published_unconfirmed" }> {
    return this.serial(async () => {
      if (!this.connected.size || !this.state.thing || !this.state.lastDeviceReportAt) throw new Error("Wait for a connected hood to report its state before sending commands");
      const fields = Object.entries(patch);
      if (!fields.length || fields.some(([key, value]) => !["power", "fan", "light", "truhuelevel", "setdelaytimer", "setrecirculating", "setcleanairfunction"].includes(key)
        || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255
        || (["power", "setrecirculating", "setcleanairfunction"].includes(key) && value > 1))) throw new Error("Supply supported controls as nonnegative integers; boolean controls use 0 or 1. Model-specific limits remain unverified.");
      const token = randomUUID();
      const at = this.now();
      const topic = `$aws/things/${this.state.thing}/shadow/update`;
      const result = shadowRequest(this.state.shadow, topic, Buffer.from(JSON.stringify({ state: { reported: patch }, clientToken: token })), at);
      if (!result.accepted) throw new Error("Command rejected by shadow validation");
      // Before delivery we cannot promise even the broker accepted the command.
      await this.commit({ ...this.state, shadow: result.record, lastCommand: { token, patch, at, status: "delivery_uncertain" } });
      this.options.audit("command_requested", { token, patch });
      for (const message of result.messages) await this.options.publish(message);
      await this.commit({ ...this.state, lastCommand: { token, patch, at, status: "published_unconfirmed" } });
      return { token, status: "published_unconfirmed" };
    });
  }
}
