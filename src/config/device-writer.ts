import { isIPv4 } from "node:net";
import { isMap, isScalar, parseDocument } from "yaml";
/** Narrow, atomic edits to the site-owned device inventory. */
import { randomUUID } from "node:crypto";
import { chmod, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DeviceConfigEntry } from "./devices";
import { DevicesConfigError, parseDevicesConfig } from "./devices";
import { validators } from "../validation";
import type { DeviceGroupConfig, DeviceGroupSettings } from "../schemas";
import { validateWorkflow, type WorkflowDefinition } from "../workflows/runner";

export type DeviceConfigWriteErrorCode = "duplicate" | "invalid_layout" | "invalid_config";

export class DeviceConfigWriteError extends Error {
  constructor(message: string, readonly code: DeviceConfigWriteErrorCode) {
    super(message);
    this.name = "DeviceConfigWriteError";
  }
}

export interface DeviceConfigWriter {
  addGroup?(group: DeviceGroupConfig): Promise<void>;
  setGroupSettings?(id: string, settings: DeviceGroupSettings): Promise<void>;
  add(entry: DeviceConfigEntry): Promise<void>;
  addAll(entries: readonly DeviceConfigEntry[]): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  setRoom?(id: string, room: string | null): Promise<void>;
  /** Keep the device in the inventory but stop provisioning it (or resume). */
  setEnabled?(id: string, enabled: boolean): Promise<void>;
  setWorkflow?(id: string, workflow: WorkflowDefinition): Promise<void>;
  /** Update one device's host and MAC. `reserve` pins the address on the gateway first; leave it out to follow a device to wherever DHCP put it. */
  setNetwork?(id: string, address: string, mac: string, reserve?: () => Promise<() => Promise<void>>): Promise<void>;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
    }
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

function renderEntry(entry: DeviceConfigEntry): string {
  const config = entry.config as { onButton?: unknown; offButton?: unknown; initialState?: unknown };
  if (entry.model === "action-button") {
    const action = entry.config as { device?: unknown; savedCodeId?: unknown };
    if (typeof action.device !== "string" || typeof action.savedCodeId !== "string") {
      throw new DeviceConfigWriteError("A Broadlink command Button needs device and savedCodeId", "invalid_config");
    }
    return [
      `  - id: ${quoted(entry.id)}`,
      ...(entry.name ? [`    name: ${quoted(entry.name)}`] : []),
      ...(entry.room ? [`    room: ${quoted(entry.room)}`] : []),
      "    model: action-button",
      "    config:",
      `      device: ${quoted(action.device)}`,
      `      savedCodeId: ${quoted(action.savedCodeId)}`,
    ].join("\n");
  }
  if (entry.model === "workflow-button") {
    const workflow = (entry.config as { workflow?: unknown }).workflow;
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      throw new DeviceConfigWriteError("A Workflow Button needs a workflow", "invalid_config");
    }
    try { validateWorkflow(workflow as WorkflowDefinition); }
    catch (error) { throw new DeviceConfigWriteError(error instanceof Error ? error.message : String(error), "invalid_config"); }
    return [
      `  - id: ${quoted(entry.id)}`,
      ...(entry.name ? [`    name: ${quoted(entry.name)}`] : []),
      ...(entry.room ? [`    room: ${quoted(entry.room)}`] : []),
      "    model: workflow-button",
      "    config:",
      `      workflow: ${JSON.stringify(workflow)}`,
    ].join("\n");
  }
  if (entry.model === "aqara-door-window-sensor") {
    const contact = entry.config as { hub?: unknown; serialNumber?: unknown };
    if (typeof contact.hub !== "string" || typeof contact.serialNumber !== "string") {
      throw new DeviceConfigWriteError("An Aqara contact sensor needs hub and serialNumber", "invalid_config");
    }
    return [
      `  - id: ${quoted(entry.id)}`,
      ...(entry.name ? [`    name: ${quoted(entry.name)}`] : []),
      ...(entry.room ? [`    room: ${quoted(entry.room)}`] : []),
      "    model: aqara-door-window-sensor",
      "    config:",
      `      hub: ${quoted(contact.hub)}`,
      `      serialNumber: ${quoted(contact.serialNumber)}`,
    ].join("\n");
  }
  if (entry.model !== "optimistic-switch" || typeof config.onButton !== "string" || typeof config.offButton !== "string") {
    throw new DeviceConfigWriteError("The Switch builder can only add saved-command Buttons and optimistic switches", "invalid_config");
  }
  const lines = [
    `  - id: ${quoted(entry.id)}`,
    ...(entry.name ? [`    name: ${quoted(entry.name)}`] : []),
    ...(entry.room ? [`    room: ${quoted(entry.room)}`] : []),
    "    model: optimistic-switch",
    "    config:",
    `      onButton: ${quoted(config.onButton)}`,
    `      offButton: ${quoted(config.offButton)}`,
  ];
  if (config.initialState === "on" || config.initialState === "off") {
    lines.push(`      initialState: ${quoted(config.initialState)}`);
  }
  return lines.join("\n");
}

/**
 * Preserve the human-written YAML and its comments by inserting one block
 * into the top-level `devices` sequence. The compact `devices: [...]` form is
 * deliberately rejected instead of rewriting the whole file and losing its
 * comments.
 */
export function appendDeviceEntry(text: string, entry: DeviceConfigEntry, source = "devices.yml"): string {
  const current = parseDevicesConfig(text, source);
  if ((current.devices ?? []).some((candidate) => candidate.id === entry.id)) {
    throw new DeviceConfigWriteError(`A device with id "${entry.id}" already exists`, "duplicate");
  }
  const next = { ...current, devices: [...(current.devices ?? []), entry] };
  if (!validators.devicesConfig(next)) {
    throw new DeviceConfigWriteError("Adding this switch would make the device inventory invalid", "invalid_config");
  }

  const block = renderEntry(entry);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blockHeader = lines.findIndex((line) => /^devices:\s*(?:#.*)?$/u.test(line));
  const emptyHeader = lines.findIndex((line) => /^devices:\s*\[\s*\]\s*(?:#.*)?$/u.test(line));

  if (blockHeader >= 0) {
    let end = lines.length;
    for (let index = blockHeader + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^[A-Za-z][A-Za-z0-9_-]*\s*:/u.test(line)) { end = index; break; }
    }
    while (end > blockHeader + 1 && lines[end - 1]?.trim() === "") end -= 1;
    lines.splice(end, 0, block);
  } else if (emptyHeader >= 0) {
    const comment = lines[emptyHeader]!.match(/(#.*)$/u)?.[1];
    lines.splice(emptyHeader, 1, `devices:${comment ? ` ${comment}` : ""}`, block);
  } else if (current.devices === undefined) {
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    lines.push("devices:", block);
  } else {
    throw new DeviceConfigWriteError(
      "The Switch builder cannot safely edit a compact devices sequence; expand `devices: [...]` to a YAML block list first",
      "invalid_layout",
    );
  }

  const rendered = `${lines.join("\n").replace(/\n+$/u, "")}\n`;
  const reparsed = parseDevicesConfig(rendered, source);
  if (canonicalJson(reparsed) !== canonicalJson(next)) {
    throw new DeviceConfigWriteError("The edited device inventory did not round-trip exactly", "invalid_layout");
  }
  return rendered;
}

function inlineComment(line: string): string | undefined {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (doubleQuoted && character === "\\" && !escaped) { escaped = true; continue; }
    if (character === '"' && !singleQuoted && !escaped) doubleQuoted = !doubleQuoted;
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (character === "#" && !singleQuoted && !doubleQuoted && (index === 0 || /\s/u.test(line[index - 1]!))) return line.slice(index);
    escaped = false;
  }
  return undefined;
}

/** Change exactly one device name while leaving the rest of the YAML intact. */
export function renameDeviceEntry(text: string, id: string, name: string, source = "devices.yml"): string {
  return setInventoryMetadata(text, id, "name", name, source);
}

function setInventoryMetadata(text: string, id: string, field: "name" | "room" | "asSwitch" | "members" | "criteria" | "config" | "enabled", value: string | boolean | string[] | NonNullable<DeviceGroupConfig["criteria"]> | Record<string, unknown> | null, source: string, collection: "devices" | "deviceGroups" = "devices"): string {
  const current = parseDevicesConfig(text, source);
  const kind = collection === "devices" ? "device" : "group";
  const entries = current[collection] ?? [];
  const entryIndex = entries.findIndex((entry) => entry.id === id);
  if (entryIndex < 0) throw new DeviceConfigWriteError(`No ${kind} with id "${id}" exists`, "invalid_config");
  const next = {
    ...current,
    [collection]: entries.map((entry, index) => {
      if (index !== entryIndex) return entry;
      const edited: Record<string, unknown> = { ...entry };
      if (value === null) delete edited[field];
      else edited[field] = value;
      return edited;
    }),
  };
  if (!validators.devicesConfig(next)) throw new DeviceConfigWriteError(`The new ${kind} ${field} is invalid`, "invalid_config");

  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const header = lines.findIndex((line) => new RegExp(`^${collection}:\\s*(?:#.*)?$`).test(line));
  if (header < 0) throw new DeviceConfigWriteError(`The ${kind} list is not a YAML block sequence`, "invalid_layout");
  let blockEnd = lines.length;
  for (let index = header + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z][A-Za-z0-9_-]*\s*:/u.test(lines[index]!)) { blockEnd = index; break; }
  }
  const starts: number[] = [];
  for (let index = header + 1; index < blockEnd; index += 1) {
    if (/^  -(?:\s|$)/u.test(lines[index]!)) starts.push(index);
  }
  if (starts.length !== entries.length) {
    throw new DeviceConfigWriteError(`The ${kind} list layout cannot be edited without rewriting it`, "invalid_layout");
  }
  const start = starts[entryIndex]!;
  if (/^  -\s*\{/u.test(lines[start]!)) {
    throw new DeviceConfigWriteError(`Expand this ${kind} from a compact object to a YAML block before editing it`, "invalid_layout");
  }
  const end = starts[entryIndex + 1] ?? blockEnd;
  const fieldLine = lines.findIndex((line, index) => index > start && index < end && new RegExp(`^    ${field}\\s*:`).test(line));
  const replacement = value === null ? undefined : `    ${field}: ${JSON.stringify(value)}`;
  if (fieldLine >= 0) {
    const comment = inlineComment(lines[fieldLine]!);
    if (field === "members" || field === "criteria" || field === "config") {
      let fieldEnd = fieldLine + 1;
      while (fieldEnd < end && !/^    [A-Za-z][A-Za-z0-9_-]*\s*:/.test(lines[fieldEnd]!)) fieldEnd++;
      // Replace a block or flow sequence, retaining any comments within it.
      const comments = lines.slice(fieldLine + 1, fieldEnd).flatMap(line => {
        const comment = inlineComment(line);
        return comment ? [`    ${comment}`] : [];
      });
      lines.splice(fieldLine + 1, fieldEnd - fieldLine - 1, ...comments);
    }
    if (replacement === undefined) lines.splice(fieldLine, 1, ...(comment ? [`    ${comment}`] : []));
    else lines[fieldLine] = `${replacement}${comment ? ` ${comment}` : ""}`;
  } else if (replacement !== undefined) {
    lines.splice(start + 1, 0, replacement);
  }

  const rendered = `${lines.join("\n").replace(/\n+$/u, "")}\n`;
  const reparsed = parseDevicesConfig(rendered, source);
  if (canonicalJson(reparsed) !== canonicalJson(next)) {
    throw new DeviceConfigWriteError("The metadata edit did not round-trip exactly", "invalid_layout");
  }
  return rendered;
}

/** Assign a room and keep it in the room list even when its last device moves away. */
export function setDeviceRoomEntry(text: string, id: string, room: string | null, source = "devices.yml"): string {
  return rememberRooms(text, setInventoryMetadata(text, id, "room", room, source), room, source);
}

/** Disable a device without removing it from the inventory (or re-enable it). Enabled is the default, so `true` clears the field. */
export function setDeviceEnabledEntry(text: string, id: string, enabled: boolean, source = "devices.yml"): string {
  return setInventoryMetadata(text, id, "enabled", enabled ? null : false, source);
}

function rememberRooms(text: string, rendered: string, room: string | null, source: string): string {
  const current = parseDevicesConfig(rendered, source);
  // Include older assignments that have no explicit room-list entry yet.
  const previous = parseDevicesConfig(text, source);
  const rooms = [...new Set([...(current.rooms ?? []), ...[...(previous.devices ?? []), ...(previous.deviceGroups ?? [])].flatMap((entry) => entry.room ? [entry.room] : []), ...(room ? [room] : [])])];
  if (canonicalJson(rooms) === canonicalJson(current.rooms ?? [])) return rendered;
  const lines = rendered.split("\n");
  const header = lines.findIndex((line) => /^rooms\s*:/.test(line));
  if (header < 0) {
    lines.splice(lines.findIndex((line) => /^schemaVersion:/.test(line)) + 1, 0, `rooms: ${JSON.stringify(rooms)}`);
  } else if (/^rooms:\s*(?:#.*)?$/.test(lines[header]!)) {
    let end = header + 1;
    while (end < lines.length && !/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(lines[end]!)) end++;
    lines.splice(end, 0, ...rooms.filter((name) => !current.rooms?.includes(name)).map((name) => `  - ${quoted(name)}`));
  } else if (/^rooms:\s*\[.*\]\s*(?:#.*)?$/.test(lines[header]!)) {
    const comment = inlineComment(lines[header]!);
    lines[header] = `rooms: ${JSON.stringify(rooms)}${comment ? ` ${comment}` : ""}`;
  } else {
    throw new DeviceConfigWriteError("Expand the room list to a YAML block or a single-line array before editing it", "invalid_layout");
  }
  rendered = lines.join("\n");
  if (canonicalJson(parseDevicesConfig(rendered, source)) !== canonicalJson({ ...current, rooms })) {
    throw new DeviceConfigWriteError("The room edit did not round-trip exactly", "invalid_layout");
  }
  return rendered;
}

/** Edit group settings atomically, preserving unrelated configuration and YAML comments. */
export function setDeviceGroupSettings(text: string, id: string, settings: DeviceGroupSettings, source = "devices.yml"): string {
  let rendered = text;
  if (settings.asSwitch !== undefined) rendered = setInventoryMetadata(rendered, id, "asSwitch", settings.asSwitch, source, "deviceGroups");
  if (settings.criteria !== undefined) rendered = setInventoryMetadata(rendered, id, "criteria", settings.criteria, source, "deviceGroups");
  if (settings.members !== undefined) rendered = setInventoryMetadata(rendered, id, "members", settings.members, source, "deviceGroups");
  if (settings.room !== undefined) {
    rendered = setInventoryMetadata(rendered, id, "room", settings.room, source, "deviceGroups");
    rendered = rememberRooms(text, rendered, settings.room, source);
  }
  return rendered;
}

/** Preserve the inventory while updating one host and its stable MAC identity. */
export function setDeviceNetworkEntry(text: string, id: string, address: string, mac: string, source = "devices.yml"): string {
  if (!isIPv4(address) || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(mac)) throw new DeviceConfigWriteError("Invalid IP address or MAC", "invalid_config");
  const current = parseDevicesConfig(text, source);
  const index = current.devices?.findIndex((entry) => entry.id === id) ?? -1;
  const entry = current.devices?.[index];
  if (!entry || typeof entry.config.host !== "string") throw new DeviceConfigWriteError("This device has no editable host address", "invalid_config");
  if (entry.mac && entry.mac.toLowerCase() !== mac) throw new DeviceConfigWriteError("The MAC does not match this device's saved identity", "invalid_config");
  if (current.devices!.some((row, i) => i !== index && (row.config.host === address || row.mac?.toLowerCase() === mac))) {
    throw new DeviceConfigWriteError("This IP or MAC is already configured for another device", "invalid_config");
  }
  const next = { ...current, devices: current.devices!.map((row, i) => i === index ? { ...row, mac, config: { ...row.config, host: address } } : row) };
  // Source ranges let us edit both block and flow YAML without reformatting
  // other devices, comments, or nested model configuration.
  const document = parseDocument(text);
  const device = document.getIn(["devices", index]);
  const host = document.getIn(["devices", index, "config", "host"], true);
  const identity = document.getIn(["devices", index, "mac"], true);
  if (document.errors.length || !isMap(device) || !device.range || !isScalar(host) || !host.range) {
    throw new DeviceConfigWriteError("The device host must be a literal YAML value", "invalid_layout");
  }
  const edits = [{ start: host.range[0], end: host.range[1], value: quoted(address) }];
  if (identity !== undefined) {
    if (!isScalar(identity) || !identity.range) throw new DeviceConfigWriteError("The device MAC must be a literal YAML value", "invalid_layout");
    edits.push({ start: identity.range[0], end: identity.range[1], value: quoted(mac) });
  } else {
    const start = device.range[0];
    const indent = start - (text.lastIndexOf("\n", start - 1) + 1);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    edits.push(device.flow
      ? { start: start + 1, end: start + 1, value: `"mac": ${quoted(mac)}, ` }
      : { start, end: start, value: `mac: ${quoted(mac)}${newline}${" ".repeat(indent)}` });
  }
  let rendered = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    rendered = rendered.slice(0, edit.start) + edit.value + rendered.slice(edit.end);
  }
  if (canonicalJson(parseDevicesConfig(rendered, source)) !== canonicalJson(next)) throw new DeviceConfigWriteError("The network edit did not round-trip exactly", "invalid_layout");
  return rendered;
}

/** Add a group without rewriting devices, credentials, or comments. */
export function appendDeviceGroup(text: string, group: DeviceGroupConfig, source = "devices.yml"): string {
  const current = parseDevicesConfig(text, source);
  if (current.deviceGroups?.some((entry) => entry.id === group.id)) throw new DeviceConfigWriteError(`Group "${group.id}" already exists`, "duplicate");
  const next = { ...current, deviceGroups: [...(current.deviceGroups ?? []), group] };
  if (!validators.devicesConfig(next)) throw new DeviceConfigWriteError("Invalid device group", "invalid_config");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const header = lines.findIndex((line) => /^deviceGroups:/.test(line));
  const block = [`  - id: ${quoted(group.id)}`, `    name: ${quoted(group.name)}`, ...(group.criteria ? [`    criteria: ${JSON.stringify(group.criteria)}`] : [`    members: ${JSON.stringify(group.members)}`]),
    ...(group.room ? [`    room: ${quoted(group.room)}`] : []),
    ...(group.asSwitch !== undefined ? [`    asSwitch: ${group.asSwitch}`] : []),
  ].join("\n");
  if (header < 0) lines.push("deviceGroups:", block);
  else if (/^deviceGroups:\s*\[\s*\]\s*(?:#.*)?$/.test(lines[header]!)) {
    lines.splice(header, 1, `deviceGroups: ${inlineComment(lines[header]!) ?? ""}`.trimEnd(), block);
  } else if (/^deviceGroups:\s*(?:#.*)?$/.test(lines[header]!)) {
    let end = header + 1;
    while (end < lines.length && !/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(lines[end]!)) end++;
    lines.splice(end, 0, block);
  } else throw new DeviceConfigWriteError("Expand deviceGroups to a YAML block list before adding a group", "invalid_layout");
  const rendered = `${lines.join("\n").replace(/\n+$/u, "")}\n`;
  if (canonicalJson(parseDevicesConfig(rendered, source)) !== canonicalJson(next)) throw new DeviceConfigWriteError("The group edit did not round-trip exactly", "invalid_layout");
  return rendered;
}

export class FileDeviceConfigWriter implements DeviceConfigWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly afterWrite?: () => Promise<void>,
  ) {}

  add(entry: DeviceConfigEntry): Promise<void> {
    return this.addAll([entry]);
  }

  addGroup(group: DeviceGroupConfig): Promise<void> {
    const operation = this.queue.then(async () => {
      const { existing, mode } = await this.read();
      await this.write(appendDeviceGroup(existing, group, this.path), mode);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  setGroupSettings(id: string, settings: DeviceGroupSettings): Promise<void> {
    const operation = this.queue.then(async () => {
      const { existing, mode } = await this.read();
      await this.write(setDeviceGroupSettings(existing, id, settings, this.path), mode);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  addAll(entries: readonly DeviceConfigEntry[]): Promise<void> {
    const operation = this.queue.then(() => this.addAllNow(entries));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  rename(id: string, name: string): Promise<void> {
    const operation = this.queue.then(() => this.renameNow(id, name));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  setRoom(id: string, room: string | null): Promise<void> {
    const operation = this.queue.then(async () => {
      const { existing, mode } = await this.read();
      await this.write(setDeviceRoomEntry(existing, id, room, this.path), mode);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    const operation = this.queue.then(async () => {
      const { existing, mode } = await this.read();
      await this.write(setDeviceEnabledEntry(existing, id, enabled, this.path), mode);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  setWorkflow(id: string, workflow: WorkflowDefinition): Promise<void> {
    const operation = this.queue.then(async () => {
      try { validateWorkflow(workflow); }
      catch (error) { throw new DeviceConfigWriteError(error instanceof Error ? error.message : String(error), "invalid_config"); }
      const { existing, mode } = await this.read();
      const current = parseDevicesConfig(existing, this.path);
      const entry = current.devices?.find((candidate) => candidate.id === id);
      if (!entry || entry.model !== "workflow-button") throw new DeviceConfigWriteError(`No Workflow Button with id "${id}" exists`, "invalid_config");
      await this.write(setInventoryMetadata(existing, id, "config", { workflow }, this.path), mode);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  setNetwork(id: string, address: string, mac: string, reserve?: () => Promise<() => Promise<void>>): Promise<void> {
    const operation = this.queue.then(async () => {
      const { existing, mode } = await this.read();
      const rendered = setDeviceNetworkEntry(existing, id, address, mac, this.path);
      if (!reserve) {
        await this.write(rendered, mode, false);
        await this.afterWrite?.();
        return;
      }
      const undo = await reserve();
      try { await this.write(rendered, mode, false); }
      catch (error) {
        try { await undo(); }
        catch { throw new Error("The local save failed and the DHCP reservation could not be restored. Check both addresses before retrying."); }
        throw error;
      }
      await this.afterWrite?.();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async addAllNow(entries: readonly DeviceConfigEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const { existing, mode } = await this.read();
    const rendered = entries.reduce((text, entry) => appendDeviceEntry(text, entry, this.path), existing);
    await this.write(rendered, mode);
  }

  private async renameNow(id: string, name: string): Promise<void> {
    const { existing, mode } = await this.read();
    await this.write(renameDeviceEntry(existing, id, name, this.path), mode);
  }

  private async read(): Promise<{ existing: string; mode: number }> {
    let existing: string;
    let mode = 0o600;
    try {
      existing = await Bun.file(this.path).text();
      mode = (await stat(this.path)).mode & 0o777;
    } catch (error) {
      if (error instanceof DevicesConfigError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "ENOENT") throw error;
      existing = "schemaVersion: 2\n";
    }
    return { existing, mode };
  }

  private async write(rendered: string, mode: number, reload = true): Promise<void> {
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, rendered, { encoding: "utf8", flag: "wx", mode });
      await chmod(temporary, mode);
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    if (reload) await this.afterWrite?.();
  }
}
