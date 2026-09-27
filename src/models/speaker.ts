import type { Speaker as SpeakerDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, numberValue, type InvokeOptions } from "./capability";

export type SpeakerErrorCode = "invalid_host" | "unreachable" | "protocol" | "not_grouped";

export class SpeakerError extends Error {
  constructor(message: string, readonly code: SpeakerErrorCode) {
    super(message);
    this.name = "SpeakerError";
  }
}

export type PlaybackState = "playing" | "paused" | "stopped" | "transitioning" | "unknown";

export interface SpeakerTrack {
  title?: string;
  artist?: string;
  album?: string;
  uri?: string;
  durationSeconds?: number;
  positionSeconds?: number;
}

/** A speaker's place in a Sonos-style group: every speaker is in exactly one group, standalone or not. */
export interface SpeakerGroup {
  /** LAN host of the group's coordinator; this speaker's own host when standalone. */
  coordinatorHost: string;
  isCoordinator: boolean;
  /** Every member's host, including this one. Present only when the coordinator's full membership is known. */
  memberHosts?: string[];
}

/** The state a speaker reports back after being read or changed. */
export interface SpeakerState {
  playback: PlaybackState;
  volumePercent: number;
  muted: boolean;
  /** Absent when nothing is queued. */
  track?: SpeakerTrack;
  group: SpeakerGroup;
}

function booleanValue(controlId: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new SpeakerError(`${controlId} takes a boolean`, "protocol");
  }
  return value;
}

function nonEmptyStringValue(controlId: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SpeakerError(`${controlId} requires a non-empty string`, "protocol");
  }
  return value;
}

interface PlayUriValue {
  uri: string;
  title?: string;
}

function playUriValue(controlId: string, value: unknown): PlayUriValue {
  if (typeof value === "string") return { uri: nonEmptyStringValue(controlId, value) };
  if (value !== null && typeof value === "object" && "uri" in value) {
    const record = value as { uri: unknown; title?: unknown };
    const uri = nonEmptyStringValue(controlId, record.uri);
    const title = typeof record.title === "string" ? record.title : undefined;
    return { uri, ...(title !== undefined ? { title } : {}) };
  }
  throw new SpeakerError(`${controlId} requires a URI string or { uri, title? }`, "protocol");
}

/**
 * The speaker capability: a network audio player (e.g. Sonos) exposing
 * transport control, volume/mute, arbitrary URI playback, an optional `say`
 * shortcut for spoken/announcement clips, and Sonos-style group membership
 * for whole-home audio. Every implementation exposes the same controls;
 * `say` is only advertised when `supportsSay()` is true.
 */
export abstract class Speaker extends Capability<SpeakerDocument> {
  readonly kind = "speaker" as const;

  get controlIds(): readonly string[] {
    const base = ["play", "pause", "stop", "setVolume", "setMute", "playUri", "joinGroup", "leaveGroup", "getState"];
    return this.supportsSay() ? [...base, "say"] : base;
  }

  get methods(): readonly string[] {
    return this.controlIds;
  }

  abstract play(): Promise<void>;
  abstract pause(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract setVolume(percent: number): Promise<void>;
  abstract setMute(muted: boolean): Promise<void>;

  /** Queue and play an arbitrary URI (a stream, a HomeTruth-hosted clip, a saved track). */
  abstract playUri(uri: string, options?: { title?: string }): Promise<void>;

  /** Join the group led by the speaker at `coordinatorHost`, so both play the coordinator's audio in sync. */
  abstract joinGroup(coordinatorHost: string): Promise<void>;

  /** Leave whatever group this speaker is in and become its own standalone player. */
  abstract leaveGroup(): Promise<void>;

  /** Return the current state. */
  abstract getState(): Promise<SpeakerState>;

  /** Whether this speaker can speak text via `say()`. Defaults to no. */
  supportsSay(): boolean {
    return false;
  }

  /** Speak `text` through this speaker. Only called when `supportsSay()` is true. */
  async say(_text: string, _options?: { volumePercent?: number }): Promise<void> {
    throw new SpeakerError("This speaker has no say control", "protocol");
  }

  override async invoke(controlId: string, value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    switch (controlId) {
      case "play": return await this.play();
      case "pause": return await this.pause();
      case "stop": return await this.stop();
      case "setVolume": return await this.setVolume(numberValue(controlId, value));
      case "setMute": return await this.setMute(booleanValue(controlId, value));
      case "playUri": {
        const { uri, title } = playUriValue(controlId, value);
        return await this.playUri(uri, title !== undefined ? { title } : undefined);
      }
      case "say":
        if (!this.supportsSay()) return this.unknownControl(controlId);
        return await this.say(nonEmptyStringValue(controlId, value));
      case "joinGroup": return await this.joinGroup(nonEmptyStringValue(controlId, value));
      case "leaveGroup": return await this.leaveGroup();
      case "getState": return await this.getState();
      default: return this.unknownControl(controlId);
    }
  }

  /**
   * Snapshot this speaker as a validated Speaker document. A speaker that
   * cannot be read is reported as offline rather than guessed at.
   */
  override async describe(): Promise<SpeakerDocument> {
    const actions = {
      play: {},
      pause: {},
      stop: {},
      setVolume: { minimumPercent: 0, maximumPercent: 100 },
      setMute: {},
      playUri: {},
      ...(this.supportsSay() ? { say: { maxLength: 500 } } : {}),
      joinGroup: {},
      leaveGroup: {},
      getState: {},
    } as const;
    let candidate: unknown;
    try {
      const state = await this.getState();
      candidate = {
        id: this.id,
        state: {
          availability: "online",
          observedAt: new Date().toISOString(),
          playback: state.playback,
          volumePercent: state.volumePercent,
          muted: state.muted,
          ...(state.track ? { track: state.track } : {}),
          group: state.group,
        },
        actions,
      };
    } catch {
      candidate = { id: this.id, state: { availability: "offline" }, actions };
    }
    if (!validators.speaker(candidate)) {
      throw new Error(`Invalid speaker document: ${describeValidationErrors(validators.speaker.errors)}`);
    }
    return candidate;
  }
}
