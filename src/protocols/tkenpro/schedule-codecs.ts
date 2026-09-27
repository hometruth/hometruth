import type { IotValue } from "./types.ts";

export type MeariScheduleCodec =
  | "weekly-intervals"
  | "deployment-intervals"
  | "daily-window"
  | "patrol-times"
  | "feed-times"
  | "tease-times";

export type MeariWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface MeariScheduleEntryView {
  readonly enabled: boolean;
  readonly time?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly days?: readonly MeariWeekday[];
  readonly once?: boolean;
  readonly portions?: number;
  readonly sound?: boolean;
  readonly mode?: number;
  readonly auto?: boolean;
}

export interface MeariScheduleView {
  readonly mode: MeariScheduleCodec;
  readonly entries: readonly MeariScheduleEntryView[];
  readonly maxEntries: number;
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DAYS: readonly MeariWeekday[] = Object.freeze([
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
]);
const MAX_ENTRIES: Readonly<Record<MeariScheduleCodec, number>> = Object.freeze({
  "weekly-intervals": 20,
  "deployment-intervals": 3,
  "daily-window": 1,
  "patrol-times": 10,
  "feed-times": 10,
  "tease-times": 10,
});

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(value: IotValue | undefined): unknown {
  if (typeof value !== "string") return value;
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return fallback;
}

function finiteInteger(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(number) ? number : undefined;
}

function wireDays(value: unknown): MeariWeekday[] {
  if (!Array.isArray(value)) return [];
  const result: MeariWeekday[] = [];
  for (const item of value) {
    const wire = finiteInteger(item);
    if (wire === undefined || wire < 1 || wire > 7) continue;
    const day = DAYS[wire - 1];
    if (day && !result.includes(day)) result.push(day);
  }
  return result;
}

function textField(record: UnknownRecord, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && TIME_PATTERN.test(value)) return value;
  }
  return undefined;
}

function entriesFrom(value: IotValue | undefined): UnknownRecord[] {
  const candidate = parsed(value);
  const entries = Array.isArray(candidate) ? candidate : candidate === undefined ? [] : [candidate];
  return entries.filter(isRecord);
}

/** Decode the exact Android-app wire shapes into a UI-safe schedule model. */
export function decodeMeariSchedule(
  codec: MeariScheduleCodec,
  value: IotValue | undefined,
): MeariScheduleView {
  const records = entriesFrom(value);
  const entries = records.flatMap((record): MeariScheduleEntryView[] => {
    if (codec === "weekly-intervals") {
      const startTime = textField(record, "start_time", "startTime");
      const endTime = textField(record, "stop_time", "endTime");
      if (!startTime || !endTime) return [];
      return [{
        enabled: booleanValue(record.enable ?? record.enabled, true),
        startTime,
        endTime,
        days: wireDays(record.repeat),
      }];
    }
    if (codec === "deployment-intervals") {
      const startTime = textField(record, "start_time", "startTime");
      const endTime = textField(record, "stop_time", "endTime");
      return startTime && endTime ? [{ enabled: true, startTime, endTime }] : [];
    }
    if (codec === "daily-window") {
      const startTime = textField(record, "from", "startTime");
      const endTime = textField(record, "to", "endTime");
      return startTime && endTime ? [{
        enabled: booleanValue(record.enable ?? record.enabled),
        startTime,
        endTime,
      }] : [];
    }
    if (codec === "patrol-times") {
      const time = textField(record, "t", "time");
      return time ? [{ enabled: booleanValue(record.enable ?? record.enabled, true), time }] : [];
    }
    if (codec === "feed-times") {
      const time = textField(record, "time");
      if (!time) return [];
      const portions = finiteInteger(record.count ?? record.portions ?? record.parts) ?? 1;
      const once = finiteInteger(record.once) === 1;
      return [{
        enabled: booleanValue(record.enable ?? record.enabled, true),
        time,
        once,
        portions,
        sound: booleanValue(record.msg_enable ?? record.sound),
        days: once ? [] : wireDays(record.repeat),
      }];
    }
    const time = textField(record, "time");
    if (!time) return [];
    const once = finiteInteger(record.once) === 1;
    const mode = finiteInteger(record.mode) ?? 0;
    return [{
      enabled: booleanValue(record.enable ?? record.enabled, true),
      time,
      once,
      mode,
      sound: booleanValue(record.msg_enable ?? record.sound),
      auto: booleanValue(record.auto),
      days: once ? [] : wireDays(record.repeat),
    }];
  });
  return { mode: codec, entries, maxEntries: MAX_ENTRIES[codec] };
}

function inputEntries(codec: MeariScheduleCodec, value: unknown): UnknownRecord[] {
  const candidate = isRecord(value) && Array.isArray(value.entries)
    ? value.entries
    : Array.isArray(value)
      ? value
      : [value];
  if (!candidate.every(isRecord)) throw new TypeError(`${codec} schedule entries must be objects`);
  if (candidate.length > MAX_ENTRIES[codec]) {
    throw new RangeError(`${codec} supports at most ${MAX_ENTRIES[codec]} entries`);
  }
  if (codec === "daily-window" && candidate.length !== 1) {
    throw new RangeError("daily-window requires exactly one entry");
  }
  return candidate;
}

function requiredTime(record: UnknownRecord, index: number, ...keys: readonly string[]): string {
  const value = textField(record, ...keys);
  if (!value) throw new RangeError(`Schedule entry ${index + 1} needs a valid HH:MM time`);
  return value;
}

function enabled(record: UnknownRecord, index: number, fallback = true): boolean {
  const value = record.enabled ?? record.enable;
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  throw new TypeError(`Schedule entry ${index + 1} enabled must be true or false`);
}

function repeatedDays(record: UnknownRecord, index: number, required: boolean): number[] {
  if (record.repeat !== undefined) {
    if (!Array.isArray(record.repeat)) throw new TypeError(`Schedule entry ${index + 1} repeat must be a list`);
    const result = record.repeat.map((day) => {
      const wire = finiteInteger(day);
      if (wire === undefined || wire < 1 || wire > 7) {
        throw new RangeError(`Schedule entry ${index + 1} repeat values must be 1 through 7`);
      }
      return wire;
    });
    if (new Set(result).size !== result.length) throw new RangeError(`Schedule entry ${index + 1} repeats a day`);
    if (required && result.length === 0) throw new RangeError(`Schedule entry ${index + 1} needs at least one day`);
    return result;
  }
  const days = record.days;
  if (days === undefined) {
    if (required) throw new RangeError(`Schedule entry ${index + 1} needs at least one day`);
    return [];
  }
  if (!Array.isArray(days)) throw new TypeError(`Schedule entry ${index + 1} days must be a list`);
  const result = days.map((day) => {
    if (typeof day === "string") {
      const wire = DAYS.indexOf(day as MeariWeekday) + 1;
      if (wire > 0) return wire;
    }
    // Public library callers historically use 0=Sunday, 1=Monday, ... 6=Saturday.
    const numeric = finiteInteger(day);
    if (numeric !== undefined && numeric >= 0 && numeric <= 6) return numeric === 0 ? 7 : numeric;
    throw new RangeError(`Schedule entry ${index + 1} has an invalid day`);
  });
  if (new Set(result).size !== result.length) throw new RangeError(`Schedule entry ${index + 1} repeats a day`);
  if (required && result.length === 0) throw new RangeError(`Schedule entry ${index + 1} needs at least one day`);
  return result;
}

function booleanField(record: UnknownRecord, index: number, keys: readonly string[], fallback = false): boolean {
  for (const key of keys) {
    if (record[key] === undefined) continue;
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return value === 1;
    throw new TypeError(`Schedule entry ${index + 1} ${key} must be true or false`);
  }
  return fallback;
}

/** Encode friendly schedule entries into the exact camera data-point payload. */
export function encodeMeariSchedule(codec: MeariScheduleCodec, value: unknown): IotValue {
  const entries = inputEntries(codec, value);
  if (codec === "weekly-intervals") {
    return entries.map((entry, index) => {
      const start = requiredTime(entry, index, "startTime", "start_time");
      const stop = requiredTime(entry, index, "endTime", "stop_time");
      if (start === stop) throw new RangeError(`Schedule entry ${index + 1} start and end must differ`);
      return {
        enable: enabled(entry, index),
        start_time: start,
        stop_time: stop,
        repeat: repeatedDays(entry, index, true),
      };
    });
  }
  if (codec === "deployment-intervals") {
    return entries.map((entry, index) => {
      const start = requiredTime(entry, index, "startTime", "start_time");
      const stop = requiredTime(entry, index, "endTime", "stop_time");
      if (start === stop) throw new RangeError(`Schedule entry ${index + 1} start and end must differ`);
      return { start_time: start, stop_time: stop };
    });
  }
  if (codec === "daily-window") {
    const entry = entries[0]!;
    const start = requiredTime(entry, 0, "startTime", "from");
    const stop = requiredTime(entry, 0, "endTime", "to");
    if (start === stop) throw new RangeError("Schedule start and end must differ");
    return { enable: enabled(entry, 0) ? 1 : 0, from: start, to: stop };
  }
  if (codec === "patrol-times") {
    return entries.map((entry, index) => ({
      enable: enabled(entry, index) ? 1 : 0,
      t: requiredTime(entry, index, "time", "t"),
    })).sort((left, right) => left.t.localeCompare(right.t));
  }
  if (codec === "feed-times") {
    return entries.map((entry, index) => {
      const portions = finiteInteger(entry.portions ?? entry.parts ?? entry.count) ?? 1;
      if (portions < 1 || portions > 10) throw new RangeError(`Schedule entry ${index + 1} needs 1 to 10 portions`);
      const explicitOnce = entry.once === undefined ? undefined : booleanField(entry, index, ["once"]);
      const days = repeatedDays(entry, index, false);
      const once = explicitOnce ?? days.length === 0;
      if (!once && days.length === 0) throw new RangeError(`Schedule entry ${index + 1} needs at least one day`);
      return {
        enable: enabled(entry, index),
        time: requiredTime(entry, index, "time"),
        ...(once ? { once: 1 } : { repeat: days }),
        count: portions,
        msg_enable: booleanField(entry, index, ["sound", "msgEnabled", "msg_enable"]),
      };
    });
  }
  return entries.map((entry, index) => {
    const mode = finiteInteger(entry.mode ?? entry.count) ?? 0;
    if (mode < 0 || mode > 10) throw new RangeError(`Schedule entry ${index + 1} mode must be from 0 to 10`);
    const explicitOnce = entry.once === undefined ? undefined : booleanField(entry, index, ["once"]);
    const days = repeatedDays(entry, index, false);
    const once = explicitOnce ?? days.length === 0;
    if (!once && days.length === 0) throw new RangeError(`Schedule entry ${index + 1} needs at least one day`);
    return {
      enable: enabled(entry, index),
      time: requiredTime(entry, index, "time"),
      ...(once ? { once: 1 } : { repeat: days }),
      mode,
      msg_enable: booleanField(entry, index, ["sound", "msgEnabled", "msg_enable"]),
      ...(entry.auto === undefined ? {} : { auto: booleanField(entry, index, ["auto"]) }),
    };
  });
}
