import type { InfraredBlaster as InfraredBlasterDocument, RadioFrequencyBlaster as RadioFrequencyBlasterDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, CapabilityError, type InvokeOptions } from "./capability";

export type IrRfBlasterErrorCode = "invalid_host" | "unreachable" | "protocol" | "not_authenticated" | "learn_timeout";

export class IrRfBlasterError extends Error {
  constructor(message: string, readonly code: IrRfBlasterErrorCode) {
    super(message);
    this.name = "IrRfBlasterError";
  }
}

/** A previously captured or learned IR/RF signal, Broadlink-packet-encoded and base64'd. */
export type SignalCode = string;

export type SignalChannel = "infrared" | "radio-frequency";

export interface LearnRequest {
  channel: SignalChannel;
  /** Limit per phase; RF without a known carrier has a detect phase and a capture phase. */
  timeoutMs?: number;
  /** RF only: skip carrier detection and listen on this frequency. */
  frequencyHz?: number;
}

/** How a code is transmitted; omitted or zero `durationMs` sends the packet once, as learned. */
export interface SendOptions {
  /** Keep transmitting by repeating the code until at least this long has passed. */
  durationMs?: number;
}

/** Upper bound on one transmit request, matching the send-request and saved-code schemas. */
export const MAX_SEND_DURATION_MS = 60_000;

export interface LearnedSignal {
  code: SignalCode;
  /** The RF carrier used or detected; absent for infrared. */
  frequencyHz?: number;
}

/**
 * What a blaster product must provide for one channel. A dual-channel product
 * (Broadlink RM) implements this once and hands the same object to both
 * capabilities with a different channel.
 */
export interface SignalTransmitter {
  send(channel: SignalChannel, code: SignalCode, options?: SendOptions): Promise<void>;
  learn(request: LearnRequest): Promise<LearnedSignal>;
  /** Confirm the device is reachable and authenticated. */
  probe(): Promise<void>;
}

const SEND_ACTION = { send: { minRepeatCount: 1, maxRepeatCount: 20, maxDurationMs: MAX_SEND_DURATION_MS } } as const;
const RF_CENTER_FREQUENCY_HZ = 433_920_000;

function learnOptions(controlId: string, value: unknown): Omit<LearnRequest, "channel"> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new CapabilityError(`${controlId} takes an object with timeoutMs and frequencyHz`, "invalid_value");
  const { timeoutMs, frequencyHz } = value as { timeoutMs?: unknown; frequencyHz?: unknown };
  return {
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof frequencyHz === "number" ? { frequencyHz } : {}),
  };
}

function sendDuration(controlId: string, durationMs: unknown): SendOptions {
  if (durationMs === undefined) return {};
  if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_SEND_DURATION_MS) {
    throw new CapabilityError(`${controlId} durationMs must be a whole number of milliseconds from 0 to ${MAX_SEND_DURATION_MS}`, "invalid_value");
  }
  return durationMs > 0 ? { durationMs } : {};
}

/** `send` takes either the bare base64 code or `{ code, durationMs }` to hold the code for a while. */
function sendArguments(controlId: string, value: unknown): { code: SignalCode; options: SendOptions } {
  if (typeof value === "string" && value.length > 0) return { code: value, options: {} };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { code, durationMs } = value as { code?: unknown; durationMs?: unknown };
    if (typeof code === "string" && code.length > 0) return { code, options: sendDuration(controlId, durationMs) };
  }
  throw new CapabilityError(`${controlId} takes a signal code or { code, durationMs }`, "invalid_value");
}

/** Sends and learns infrared codes through a transmitter's infrared channel. */
export class InfraredBlaster extends Capability<InfraredBlasterDocument> {
  readonly kind = "infraredBlaster" as const;
  readonly controlIds = ["send", "learn"] as const;
  readonly methods = ["send", "learn"] as const;

  constructor(id: string, private readonly transmitter: SignalTransmitter) {
    super(id);
  }

  send(code: SignalCode, options: SendOptions = {}): Promise<void> {
    return this.transmitter.send("infrared", code, options);
  }

  learn(options: Omit<LearnRequest, "channel" | "frequencyHz"> = {}): Promise<LearnedSignal> {
    return this.transmitter.learn({ channel: "infrared", ...options });
  }

  override async invoke(controlId: string, value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    switch (controlId) {
      case "send": {
        const { code, options } = sendArguments(controlId, value);
        return await this.send(code, options);
      }
      case "learn": {
        const { timeoutMs } = learnOptions(controlId, value);
        return await this.learn(timeoutMs !== undefined ? { timeoutMs } : {});
      }
      default: return this.unknownControl(controlId);
    }
  }

  override async describe(): Promise<InfraredBlasterDocument> {
    const channels = [{ id: "ir", formats: ["broadlink-base64"] }];
    let candidate: unknown;
    try {
      await this.transmitter.probe();
      candidate = { id: this.id, state: { availability: "online", observedAt: new Date().toISOString() }, channels, actions: SEND_ACTION };
    } catch {
      candidate = { id: this.id, state: { availability: "offline" }, channels, actions: SEND_ACTION };
    }
    if (!validators.infraredBlaster(candidate)) {
      throw new Error(`Invalid infrared blaster document: ${describeValidationErrors(validators.infraredBlaster.errors)}`);
    }
    return candidate;
  }
}

/** Sends and learns radio-frequency codes through a transmitter's RF channel. */
export class RadioFrequencyBlaster extends Capability<RadioFrequencyBlasterDocument> {
  readonly kind = "radioFrequencyBlaster" as const;
  readonly controlIds = ["send", "learn"] as const;
  readonly methods = ["send", "learn"] as const;

  constructor(id: string, private readonly transmitter: SignalTransmitter) {
    super(id);
  }

  send(code: SignalCode, options: SendOptions = {}): Promise<void> {
    return this.transmitter.send("radio-frequency", code, options);
  }

  learn(options: Omit<LearnRequest, "channel"> = {}): Promise<LearnedSignal> {
    return this.transmitter.learn({ channel: "radio-frequency", ...options });
  }

  override async invoke(controlId: string, value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    switch (controlId) {
      case "send": {
        const { code, options } = sendArguments(controlId, value);
        return await this.send(code, options);
      }
      case "learn": return await this.learn(learnOptions(controlId, value));
      default: return this.unknownControl(controlId);
    }
  }

  override async describe(): Promise<RadioFrequencyBlasterDocument> {
    const channels = [{ id: "rf", centerFrequencyHz: RF_CENTER_FREQUENCY_HZ, formats: ["broadlink-base64"] }];
    let candidate: unknown;
    try {
      await this.transmitter.probe();
      candidate = { id: this.id, state: { availability: "online", observedAt: new Date().toISOString() }, channels, actions: SEND_ACTION };
    } catch {
      candidate = { id: this.id, state: { availability: "offline" }, channels, actions: SEND_ACTION };
    }
    if (!validators.radioFrequencyBlaster(candidate)) {
      throw new Error(`Invalid radio-frequency blaster document: ${describeValidationErrors(validators.radioFrequencyBlaster.errors)}`);
    }
    return candidate;
  }
}
