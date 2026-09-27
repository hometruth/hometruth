import type { RegisteredDevice } from "../site";
import { EVENT_LOG_MESSAGES, EVENT_LOG_SCRIPT, eventViewData, renderEventFilters, renderEventList, renderLiveIndicator } from "./services-page";
import { escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";

export type CameraAppProfile = "tkenpro" | "cloudedge";

export type CameraConnectionStatus = "online" | "offline" | "connecting" | "unknown";
export type CameraFeatureAvailability = "available" | "unavailable" | "unknown";
export type CameraDiscoveryStatus = "idle" | "searching" | "ready" | "error";
export type CameraCapabilityCategory =
  | "video"
  | "privacy"
  | "audio"
  | "detection"
  | "storage"
  | "feeding"
  | "movement"
  | "onvif"
  | "advanced";
export type CameraCapabilityKind =
  | "toggle"
  | "select"
  | "range"
  | "text"
  | "color"
  | "action"
  | "momentary"
  | "status"
  | "json"
  | "ptz"
  | "treat"
  | "schedule"
  | "region"
  | "polygon-region"
  | "presets";

export interface CameraCapabilityOption {
  value: string;
  label: string;
}

export interface CameraPresetView {
  id: string;
  label: string;
}

export interface CameraFeedScheduleView {
  mode:
    | "weekly-intervals"
    | "deployment-intervals"
    | "daily-window"
    | "patrol-times"
    | "feed-times"
    | "tease-times";
  entries: CameraScheduleEntryView[];
  maxEntries: number;
}

export interface CameraScheduleEntryView {
  enabled: boolean;
  time?: string;
  startTime?: string;
  endTime?: string;
  days?: string[];
  once?: boolean;
  portions?: number;
  sound?: boolean;
  mode?: number;
  auto?: boolean;
}

export interface CameraRegionView {
  width: 16;
  height: 9;
  selectedCells: number[];
}

export interface CameraPolygonPointView {
  x: number;
  y: number;
}

export interface CameraPolygonView {
  type: 1 | 2 | 3;
  points: CameraPolygonPointView[];
  vId?: number;
  aiTypes?: number[];
}

export interface CameraPolygonRegionView {
  maxPolygons: 6;
  pointCount: 8;
  polygons: CameraPolygonView[];
}

/**
 * The server owns this descriptor. The browser renders only the controls that
 * the descriptor permits and never infers support from a model name.
 */
export interface CameraCapabilityDescriptor {
  id: string;
  category: CameraCapabilityCategory;
  label: string;
  description?: string;
  kind: CameraCapabilityKind;
  availability: CameraFeatureAvailability;
  value?: boolean | string | number | null;
  options?: CameraCapabilityOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  readOnly?: boolean;
  confirmation?: "none" | "confirm" | "type-device-name";
  dangerous?: boolean;
  presets?: CameraPresetView[];
  schedule?: CameraFeedScheduleView;
  region?: CameraRegionView;
  polygonRegion?: CameraPolygonRegionView;
}

export interface CameraDeviceView {
  id: string;
  name: string;
  /** The LAN address the camera was reached at, when known. */
  host?: string;
  model?: string;
  firmware?: string;
  status: CameraConnectionStatus;
  stream: CameraFeatureAvailability;
  snapshot: CameraFeatureAvailability;
  capabilities: CameraCapabilityDescriptor[];
  /** How this camera is reached right now and anything standing in the way. */
  connection?: CameraConnectionView;
}

export interface CameraConnectionView {
  via: "local" | "onvif" | "cloud" | "none";
  onvif?: { state: "connected" | "unavailable"; detail?: string };
  local?: { state: "connected" | "waiting" | "unavailable"; detail?: string };
  cloud?: { state: "online" | "offline" | "unknown" | "unavailable"; detail?: string };
  problems: string[];
}

export interface CameraNetworkStatusView {
  mode: "local" | "cloud" | "unknown";
  dnsOverride: "on" | "off" | "missing" | "unavailable";
  domain: string;
  overrideIp: string;
  resolvedTo?: string;
  detail?: string;
  checkedAt: string;
  canToggle: boolean;
  /** Present when this is one camera's own isolation state (see src/network/isolation.ts). */
  deviceId?: string;
  isolated?: boolean;
  internetBlock?: "on" | "off" | "missing" | "unavailable";
  capture?: "running" | "stopped" | "unavailable";
  hostnames?: string[];
}

/** Where this camera's own events can be read, and what the log needs to render them. */
export interface CameraEventLogView {
  /** The service that records this camera's events (the emulator that stands in for its cloud). */
  serviceId: string;
  serviceTitle: string;
  servicePage?: string | undefined;
  /** The device id its events are tagged with. */
  subject: string;
  types: readonly { id: string; label: string; description: string; level: "info" | "warn" | "error"; view: "plain" | "thumbnail" | "properties" | "request" | "network" }[];
}

export interface CameraDashboardModel {
  /** Shared DNS-override state (local emulator vs vendor cloud); absent when unchecked. */
  network?: CameraNetworkStatusView;
  /** This camera's own event log, when a service records events about it. */
  eventLog?: CameraEventLogView;
  setup: {
    configured: boolean;
    profile: CameraAppProfile | null;
    /** A masked value such as r•••@example.com. Never pass a raw account or password. */
    accountHint?: string;
  };
  discovery: {
    status: CameraDiscoveryStatus;
    message?: string;
  };
  devices: CameraDeviceView[];
  selectedDeviceId: string | null;
}

export interface CameraDashboardPageOptions {
  ctx: PageContext;
  model: CameraDashboardModel;
  /** The configured device this page is for; gives the page its tabs. */
  device?: RegisteredDevice;
}

/** The same-origin routes used by the browser asset in this page. */
export const CAMERA_DASHBOARD_API = {
  state: "/api/camera/state",
  setup: "/api/camera/setup",
  disconnect: "/api/camera/disconnect",
  discover: "/api/camera/discover",
  select: "/api/camera/select",
  control: "/api/camera/control",
  ptz: "/api/camera/ptz",
  network: "/api/camera/network/dns-override",
  reconnect: "/api/camera/network/reconnect",
  reboot: "/api/camera/reboot",
  stream: "/api/camera/devices/:id/stream.mjpeg",
  snapshot: "/api/camera/devices/:id/snapshot",
  playback: "/api/camera/devices/:id/playback.mjpeg",
} as const;

const CATEGORY_ORDER: readonly CameraCapabilityCategory[] = ["video", "privacy", "audio", "detection", "storage", "feeding", "movement", "onvif", "advanced"];

function unknownCapability(
  id: string,
  category: CameraCapabilityCategory,
  label: string,
  description: string,
  kind: CameraCapabilityKind,
  extra: Partial<CameraCapabilityDescriptor> = {},
): CameraCapabilityDescriptor {
  return { id, category, label, description, kind, availability: "unknown", ...extra };
}

/**
 * A complete visible control inventory. Device descriptors override entries by
 * id; absent entries remain visible as "support unknown" instead of vanishing.
 * Labels here are the API's English; the page localizes by id (`cam.cap.<id>`).
 */
export const DEFAULT_CAMERA_CAPABILITIES: readonly CameraCapabilityDescriptor[] = [
  unknownCapability("video.quality", "video", "Picture quality", "Choose bandwidth or detail.", "select", {
    options: [
      { value: "auto", label: "Auto" },
      { value: "sd", label: "Data saver" },
      { value: "hd", label: "High definition" },
    ],
  }),
  unknownCapability("video.nightVision", "video", "Night vision", "Switch infrared night vision automatically or manually.", "select", {
    options: [
      { value: "auto", label: "Automatic" },
      { value: "on", label: "Always on" },
      { value: "off", label: "Off" },
    ],
  }),
  unknownCapability("video.flip", "video", "Flip picture", "Rotate an upside-down mounted camera.", "toggle"),
  unknownCapability("device.statusLed", "privacy", "Status light", "Show the camera’s status light.", "toggle"),
  unknownCapability("device.privacy", "privacy", "Privacy mode", "Pause camera viewing and recording.", "toggle", { confirmation: "confirm" }),
  unknownCapability("audio.listen", "audio", "Listen", "Listen to camera sound from the live viewer.", "status", { readOnly: true }),
  unknownCapability("audio.microphone", "audio", "Camera microphone", "Include microphone audio in camera streams and recordings.", "toggle"),
  unknownCapability("audio.volume", "audio", "Speaker volume", "Set the camera speaker level.", "range", { min: 0, max: 100, step: 5, unit: "%" }),
  unknownCapability("audio.talk", "audio", "Talk", "Speak through the camera; click to start and stop.", "momentary"),
  unknownCapability("detection.motion", "detection", "Motion alerts", "Notify when movement is detected.", "toggle"),
  unknownCapability("detection.motionSensitivity", "detection", "Motion sensitivity", "Adjust how readily movement triggers an alert.", "range", { min: 1, max: 10, step: 1 }),
  unknownCapability("detection.tracking", "detection", "Motion tracking", "Follow moving subjects with the camera.", "toggle"),
  unknownCapability("detection.sound", "detection", "Sound alerts", "Notify when sound is detected.", "toggle"),
  unknownCapability("detection.soundSensitivity", "detection", "Sound sensitivity", "Adjust how readily sound triggers an alert.", "range", { min: 1, max: 10, step: 1 }),
  unknownCapability("detection.bark", "detection", "Bark detection", "Notify when the camera recognizes barking.", "toggle"),
  unknownCapability("detection.pet", "detection", "Pet detection", "Prioritize alerts that appear to include a pet.", "toggle"),
  unknownCapability("storage.recording", "storage", "SD recording", "Record video to the camera’s SD card.", "toggle"),
  unknownCapability("storage.mode", "storage", "Recording mode", "Choose continuous or event-only recording.", "select", {
    options: [
      { value: "events", label: "Events only" },
      { value: "continuous", label: "Continuous" },
    ],
  }),
  unknownCapability("storage.summary", "storage", "SD card", "Capacity and free space reported by the camera.", "status", { readOnly: true }),
  unknownCapability("storage.playback", "storage", "Local recordings", "Play the camera's SD-card timeline directly over the local network.", "status", { readOnly: true }),
  unknownCapability("storage.format", "storage", "Erase SD card", "Permanently remove recordings and prepare the card for this camera.", "action", {
    confirmation: "type-device-name",
    dangerous: true,
  }),
  unknownCapability("feed.portions", "feeding", "Dispense a treat", "Release one treat; press again for another.", "treat", { min: 1, max: 1, step: 1 }),
  unknownCapability("feed.schedule", "feeding", "Feed schedule", "Choose a time and days for automatic feeding.", "schedule"),
  unknownCapability("feed.sound", "feeding", "Feeding sound", "Play the camera’s feeding cue before dispensing.", "toggle"),
  unknownCapability("camera.ptz", "movement", "Move camera", "Press and hold an arrow to pan.", "ptz"),
  unknownCapability("camera.presets", "movement", "Saved views", "Return quickly to favorite camera positions.", "presets"),
  unknownCapability("camera.patrol", "movement", "Patrol", "Move between saved views automatically.", "toggle"),
  unknownCapability("camera.calibrate", "movement", "Calibrate movement", "Relearn the camera’s pan and tilt limits.", "action", { confirmation: "confirm" }),
  unknownCapability("onvif.enabled", "onvif", "Local ONVIF access", "Allow compatible apps on your local network to connect.", "toggle", { confirmation: "confirm" }),
  unknownCapability("device.wake", "advanced", "Wake camera", "Ask a sleeping camera to reconnect.", "action"),
  unknownCapability("device.restart", "advanced", "Restart camera", "Temporarily take the camera offline while it restarts.", "action", { confirmation: "confirm" }),
  unknownCapability("device.factoryReset", "advanced", "Factory reset", "Erase camera settings and return it to factory defaults.", "action", {
    confirmation: "type-device-name",
    dangerous: true,
  }),
];

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** A capability's label in the page's language when the catalog knows the id; the descriptor's own label otherwise. */
function capabilityLabel(ctx: PageContext, capability: CameraCapabilityDescriptor): string {
  return ctx.i18n.lookup(`cam.cap.${capability.id}`) ?? capability.label;
}

function optionLabel(ctx: PageContext, option: CameraCapabilityOption): string {
  return ctx.i18n.lookup(`cam.option.${option.value}`) ?? option.label;
}

function statusLabel(ctx: PageContext, value: CameraConnectionStatus): string {
  return ctx.i18n.t(`status.${value}`);
}

/** This camera's own slice of its cloud emulator's log, as a tab beside the controls. */
function renderEventPanel(ctx: PageContext, log: CameraEventLogView): string {
  const { t } = ctx.i18n;
  return `<div id="panel-events" role="tabpanel" aria-labelledby="tab-events" hidden
       data-service-page data-service-id="${escapeHtml(log.serviceId)}" data-subject="${escapeHtml(log.subject)}"
       ${eventViewData([], log.types)}>
    <p class="note">${escapeHtml(t("cam.recordedBy", { service: "" })).trim()} <a href="${escapeHtml(log.servicePage ?? `/services/${encodeURIComponent(log.serviceId)}`)}">${escapeHtml(log.serviceTitle)}</a> ${renderLiveIndicator(ctx)}</p>
    ${renderEventFilters(ctx, [], log.types, { omitSubject: true })}
    ${renderEventList(ctx)}
  </div>`;
}

function statusLineBase(ctx: PageContext, device: CameraDeviceView | undefined, network: CameraNetworkStatusView | undefined): string {
  const { t } = ctx.i18n;
  const parts = [statusLabel(ctx, device?.status ?? "unknown")];
  const via = device?.connection?.via;
  if (via === "local" || via === "onvif" || via === "cloud") parts.push(t(`cam.via.${via}`));
  if (network?.deviceId) {
    parts.push(network.isolated
      ? t("cam.isolated", { block: network.internetBlock ?? "unknown", capture: network.capture ?? "unavailable" })
      : t("cam.notIsolated"));
  } else if (network) {
    parts.push(t(network.mode === "local" ? "cam.dns.on" : network.mode === "cloud" ? "cam.dns.off" : "cam.dns.unknown"));
  }
  return parts.join(" · ");
}

function statusProblems(device: CameraDeviceView | undefined, network: CameraNetworkStatusView | undefined): string[] {
  return [...(device?.connection?.problems ?? []), ...(network?.detail ? [network.detail] : [])];
}

function renderNetworkToggle(ctx: PageContext, network: CameraNetworkStatusView | undefined): string {
  const { t } = ctx.i18n;
  if (!network || !network.canToggle) return "";
  const next = network.mode === "local" ? "off" : "on";
  const perDevice = Boolean(network.deviceId);
  const label = perDevice
    ? (network.isolated ? t("isolation.release") : t("isolation.isolate"))
    : (network.mode === "local" ? t("cam.network.toCloud") : t("cam.network.toLocal"));
  const hosts = (network.hostnames ?? []).join(", ") || network.domain;
  const title = perDevice
    ? (network.isolated
      ? t("cam.network.titleIsolated", { hosts, ip: network.overrideIp, block: network.internetBlock ?? "unknown" })
      : t("cam.network.titleOpen", { hosts, ip: network.overrideIp }))
    : t("cam.network.titleRecord", { domain: network.domain, resolved: network.resolvedTo ?? t("cam.network.unresolved"), ip: network.overrideIp, record: network.dnsOverride });
  return `<button type="button" class="btn btn-small" id="network-mode-button" data-network-mode="${network.mode}" data-next-action="${next}"${perDevice ? ` data-isolation-device="${escapeHtml(network.deviceId ?? "")}"` : ""} title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
}

/** Offered when the gateway can kick Wi-Fi and the camera is on the wrong side; the one-click fix for "not registered with the local emulator yet". */
function renderReconnectButton(ctx: PageContext, device: CameraDeviceView | undefined, network: CameraNetworkStatusView | undefined): string {
  const { t } = ctx.i18n;
  if (!device?.host || !network || !network.canToggle) return "";
  const registeredLocally = device.connection?.local?.state === "connected";
  if (network.mode === "cloud" ? !registeredLocally : registeredLocally) return "";
  const target = network.mode === "cloud" ? t("cam.network.targetCloud") : t("cam.network.targetLocal");
  return `<button type="button" class="btn btn-small" id="network-reconnect-button" title="${escapeHtml(t("cam.reconnect.title", { host: device.host, target }))}">${escapeHtml(t("cam.reconnect.button"))}</button>`;
}

/** Always offered for a camera with a known address: the fix for a camera that shows a steady blue light but is unknown here (it failed over to its backup Wi-Fi). */
function renderRebootButton(ctx: PageContext, device: CameraDeviceView | undefined): string {
  const { t } = ctx.i18n;
  if (!device?.host) return "";
  return `<button type="button" class="btn btn-small" id="camera-reboot-button" title="${escapeHtml(t("cam.reboot.title", { host: device.host }))}">${escapeHtml(t("cam.reboot.button"))}</button>`;
}

function mergeCapabilities(device: CameraDeviceView | undefined): CameraCapabilityDescriptor[] {
  const provided = new Map((device?.capabilities ?? []).map((capability) => [capability.id, capability]));
  // Pet cameras expose a vendor-specific dispense-sound switch; the generic fallback beside it made a working control look disabled.
  const deviceSpecificDispenseSound = provided.has("meari.dispenseSound");
  const merged = DEFAULT_CAMERA_CAPABILITIES
    .filter((fallback) => !(deviceSpecificDispenseSound && fallback.id === "feed.sound"))
    .map((fallback) => provided.get(fallback.id) ?? fallback);
  const standardIds = new Set(DEFAULT_CAMERA_CAPABILITIES.map((capability) => capability.id));
  return [...merged, ...(device?.capabilities ?? []).filter((capability) => !standardIds.has(capability.id))];
}

const SCHEDULE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function defaultScheduleEntry(mode: CameraFeedScheduleView["mode"]): CameraScheduleEntryView {
  if (mode === "weekly-intervals") return { enabled: true, startTime: "22:00", endTime: "07:00", days: [...SCHEDULE_DAYS] };
  if (mode === "deployment-intervals") return { enabled: true, startTime: "00:00", endTime: "23:59" };
  if (mode === "daily-window") return { enabled: false, startTime: "18:00", endTime: "06:00" };
  if (mode === "patrol-times") return { enabled: true, time: "09:00" };
  if (mode === "feed-times") return { enabled: true, time: "09:00", days: [...SCHEDULE_DAYS], once: false, portions: 1, sound: true };
  return { enabled: true, time: "09:00", days: [...SCHEDULE_DAYS], once: false, mode: 0, sound: false, auto: false };
}

function renderWeekdayPicker(ctx: PageContext, entry: CameraScheduleEntryView, disabledAttribute: string): string {
  const { t } = ctx.i18n;
  const selected = entry.days ?? [];
  return `<fieldset class="weekdays"><legend>${escapeHtml(t("cam.schedule.days"))}</legend>${SCHEDULE_DAYS.map((day) => `<label title="${day}"><input type="checkbox" value="${day}" data-schedule-day${selected.includes(day) ? " checked" : ""}${disabledAttribute}><span>${escapeHtml(t(`cam.day.${day}`))}</span></label>`).join("")}</fieldset>`;
}

function renderScheduleEntry(ctx: PageContext, mode: CameraFeedScheduleView["mode"], entry: CameraScheduleEntryView, disabledAttribute: string): string {
  const { t } = ctx.i18n;
  const field = (label: string, control: string) => `<label class="schedule-field"><span>${escapeHtml(label)}</span>${control}</label>`;
  const enabledControl = mode === "deployment-intervals" ? "" : field(t("cam.schedule.enabled"), `<input type="checkbox" data-schedule-enabled${entry.enabled ? " checked" : ""}${disabledAttribute}>`);
  const remove = mode === "daily-window" ? "" : `<button type="button" class="btn-link schedule-remove" data-schedule-remove${disabledAttribute}>${escapeHtml(t("cam.schedule.remove"))}</button>`;
  const time = (name: string, value: string, attribute: string) => field(name, `<input type="time" value="${escapeHtml(value)}" ${attribute}${disabledAttribute}>`);
  if (mode === "weekly-intervals" || mode === "deployment-intervals" || mode === "daily-window") {
    const start = time(t("cam.schedule.starts"), entry.startTime ?? (mode === "weekly-intervals" ? "22:00" : mode === "daily-window" ? "18:00" : "00:00"), "data-schedule-start");
    const end = time(t("cam.schedule.ends"), entry.endTime ?? (mode === "weekly-intervals" ? "07:00" : mode === "daily-window" ? "06:00" : "23:59"), "data-schedule-end");
    return `<div class="schedule-entry" data-schedule-entry>${remove}<div class="schedule-row">${enabledControl}${start}${end}</div>${mode === "weekly-intervals" ? renderWeekdayPicker(ctx, entry, disabledAttribute) : ""}</div>`;
  }
  if (mode === "patrol-times") {
    return `<div class="schedule-entry" data-schedule-entry>${remove}<div class="schedule-row">${enabledControl}${time(t("cam.schedule.time"), entry.time ?? "09:00", "data-schedule-time")}</div></div>`;
  }
  const extra = mode === "feed-times"
    ? field(t("cam.schedule.portions"), `<input type="number" min="1" max="10" step="1" value="${entry.portions ?? 1}" data-schedule-portions${disabledAttribute}>`)
    : field(t("cam.schedule.playMode"), `<input type="number" min="0" max="10" step="1" value="${entry.mode ?? 0}" data-schedule-mode-value${disabledAttribute}>`) + field(t("cam.schedule.auto"), `<input type="checkbox" data-schedule-auto${entry.auto ? " checked" : ""}${disabledAttribute}>`);
  return `<div class="schedule-entry" data-schedule-entry>${remove}<div class="schedule-row">${enabledControl}${time(t("cam.schedule.time"), entry.time ?? "09:00", "data-schedule-time")}${extra}${field(t("cam.schedule.once"), `<input type="checkbox" data-schedule-once${entry.once ? " checked" : ""}${disabledAttribute}>`)}${field(t("cam.schedule.cue"), `<input type="checkbox" data-schedule-sound${entry.sound ? " checked" : ""}${disabledAttribute}>`)}</div>${renderWeekdayPicker(ctx, entry, disabledAttribute)}</div>`;
}

function renderPolygonGroup(ctx: PageContext, polygon: CameraPolygonView, index: number): string {
  const { t } = ctx.i18n;
  const points = polygon.points.map((point) => `${point.x},${point.y}`).join(" ");
  const handles = polygon.points.map((point, pointIndex) => `<circle class="polygon-point" cx="${point.x}" cy="${point.y}" r="2.4" tabindex="0" role="slider" aria-label="${escapeHtml(t("cam.area.point", { area: index + 1, point: pointIndex + 1 }))}" aria-valuetext="${escapeHtml(t("cam.area.valuetext", { x: point.x, y: point.y }))}" data-polygon-point="${pointIndex}"></circle>`).join("");
  return `<g data-polygon="${index}" data-polygon-type="${polygon.type}" data-polygon-v-id="${polygon.vId ?? ""}" data-polygon-ai-types="${escapeHtml(JSON.stringify(polygon.aiTypes ?? []))}" data-polygon-selected="${index === 0 ? "true" : "false"}">
    <polygon class="polygon-shape" points="${points}" data-polygon-shape></polygon>${handles}
  </g>`;
}

function renderControlInput(ctx: PageContext, capability: CameraCapabilityDescriptor): string {
  const { t } = ctx.i18n;
  const label = capabilityLabel(ctx, capability);
  const controlId = `control-${safeId(capability.id)}`;
  const disabled = capability.availability !== "available" || capability.readOnly === true || capability.dangerous === true;
  const disabledAttribute = disabled ? " disabled" : "";
  const baseDisabled = capability.availability !== "available" || capability.readOnly === true ? "true" : "false";
  const common = ` data-capability-id="${escapeHtml(capability.id)}" data-base-disabled="${baseDisabled}" data-confirmation="${capability.confirmation ?? "none"}"${capability.dangerous ? ' data-dangerous="true"' : ""}`;

  if (capability.kind === "toggle") {
    return `<label class="switch" for="${controlId}">
      <input id="${controlId}" type="checkbox" role="switch" data-control-input data-value-kind="boolean" data-current-value="${capability.value === true ? "true" : "false"}"${common}${capability.value === true ? " checked" : ""}${disabledAttribute}>
      <span class="switch-track" aria-hidden="true"><span></span></span>
      <span class="sr-only">${escapeHtml(label)}</span>
    </label>`;
  }
  if (capability.kind === "select") {
    const selectedValue = typeof capability.value === "string" ? capability.value : "";
    return `<select id="${controlId}" aria-label="${escapeHtml(label)}" data-control-input data-value-kind="string" data-current-value="${escapeHtml(selectedValue)}"${common}${disabledAttribute}>
      ${selectedValue === "" ? `<option value="" selected>${escapeHtml(t("cam.choose"))}</option>` : ""}
      ${(capability.options ?? []).map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selectedValue ? " selected" : ""}>${escapeHtml(optionLabel(ctx, option))}</option>`).join("")}
    </select>`;
  }
  if (capability.kind === "range") {
    const minimum = Number.isFinite(capability.min) ? Number(capability.min) : 0;
    const maximum = Number.isFinite(capability.max) ? Number(capability.max) : 100;
    const step = Number.isFinite(capability.step) && Number(capability.step) > 0 ? Number(capability.step) : 1;
    const value = Math.min(maximum, Math.max(minimum, typeof capability.value === "number" ? capability.value : minimum));
    return `<div class="range">
      <input id="${controlId}" type="range" min="${minimum}" max="${maximum}" step="${step}" value="${value}" aria-label="${escapeHtml(label)}" data-control-input data-value-kind="number" data-current-value="${value}" data-unit="${escapeHtml(capability.unit ?? "")}"${common}${disabledAttribute}>
      <output for="${controlId}" class="num" data-range-output>${value}${escapeHtml(capability.unit ?? "")}</output>
    </div>`;
  }
  if (capability.kind === "text") {
    const value = typeof capability.value === "string" ? capability.value : "";
    return `<input id="${controlId}" type="url" inputmode="url" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" data-control-input data-value-kind="string" data-current-value="${escapeHtml(value)}"${common}${disabledAttribute}>`;
  }
  if (capability.kind === "color") {
    const value = typeof capability.value === "string" && /^#[0-9a-f]{6}$/iu.test(capability.value) ? capability.value : "#ffffff";
    return `<input id="${controlId}" type="color" value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" data-control-input data-value-kind="string" data-current-value="${escapeHtml(value)}"${common}${disabledAttribute}>`;
  }
  if (capability.kind === "status") {
    const value = capability.value === null || capability.value === undefined ? t("cam.notReported") : String(capability.value);
    return `<output class="reported num" data-reported-value>${escapeHtml(value)}${typeof capability.value === "number" ? escapeHtml(capability.unit ?? "") : ""}</output>`;
  }
  if (capability.kind === "json") {
    const rawValue = typeof capability.value === "string" ? capability.value : "{}";
    return `<div class="json-control">
      <textarea id="${controlId}" class="mono" rows="4" spellcheck="false" aria-label="${escapeHtml(t("cam.json.label"))}" data-json-input${disabledAttribute}>${escapeHtml(rawValue)}</textarea>
      <button type="button" class="btn" data-json-button${common}${disabledAttribute}>${escapeHtml(t("cam.json.apply"))}</button>
    </div>`;
  }
  if (capability.kind === "action" || capability.kind === "momentary") {
    const actionLabel = capability.kind === "momentary" && capability.id !== "audio.talk" ? t("cam.holdTo", { label: label.toLowerCase() }) : label;
    const actionAttribute = capability.kind === "momentary"
      ? capability.id === "audio.talk" ? 'data-talk-button aria-pressed="false"' : "data-momentary-button"
      : "data-control-button";
    const button = `<button type="button" class="btn${capability.dangerous ? " btn-danger" : ""}" ${actionAttribute}${common}${disabledAttribute}>${escapeHtml(actionLabel)}</button>`;
    return capability.dangerous ? `<div class="danger-control">${button}<small class="muted">${escapeHtml(t("cam.unlockNote"))}</small></div>` : button;
  }
  if (capability.kind === "treat") {
    return `<button type="button" class="btn btn-primary" data-treat-button${common}${disabledAttribute}>${escapeHtml(t("cam.treat.dispense"))}</button>`;
  }
  if (capability.kind === "schedule") {
    const schedule = capability.schedule ?? { mode: "feed-times", entries: [], maxEntries: 10 };
    const displayed = schedule.entries.length > 0 ? schedule.entries : [defaultScheduleEntry(schedule.mode)];
    return `<div class="schedule" data-schedule-mode="${schedule.mode}" data-schedule-max="${schedule.maxEntries}">
      <div class="schedule-list" data-schedule-list>${displayed.map((entry) => renderScheduleEntry(ctx, schedule.mode, entry, disabledAttribute)).join("")}</div>
      <template data-schedule-template>${renderScheduleEntry(ctx, schedule.mode, defaultScheduleEntry(schedule.mode), disabledAttribute)}</template>
      <div class="bar">${schedule.mode === "daily-window" ? "" : `<button type="button" class="btn" data-schedule-add${disabledAttribute}>${escapeHtml(t("cam.schedule.add"))}</button>`}<button type="button" class="btn btn-primary" data-schedule-button${common}${disabledAttribute}>${escapeHtml(t("cam.schedule.save"))}</button></div>
    </div>`;
  }
  if (capability.kind === "region") {
    const width = 16;
    const height = 9;
    const selected = new Set(capability.region?.selectedCells ?? []);
    const cells = Array.from({ length: width * height }, (_, index) => {
      const row = Math.floor(index / width) + 1;
      const column = (index % width) + 1;
      return `<button type="button" class="region-cell" aria-label="${escapeHtml(t("cam.region.cell", { row, column }))}" aria-pressed="${selected.has(index) ? "true" : "false"}" data-region-cell="${index}"${disabledAttribute}></button>`;
    }).join("");
    return `<div class="region" data-region-control data-region-width="${width}" data-region-height="${height}">
      <div class="region-toolbar"><span class="muted small"><output data-region-count>${selected.size}</output> / ${width * height}</span><span><button type="button" class="btn" data-region-fill${disabledAttribute}>${escapeHtml(t("cam.region.all"))}</button> <button type="button" class="btn" data-region-clear${disabledAttribute}>${escapeHtml(t("action.clear"))}</button></span></div>
      <div class="region-grid" role="group" aria-label="${escapeHtml(t("cam.region.label"))}" style="--region-columns:${width}">${cells}</div>
      <div class="bar"><button type="button" class="btn btn-primary" data-region-save${common}${disabledAttribute}>${escapeHtml(t("cam.region.save"))}</button></div>
    </div>`;
  }
  if (capability.kind === "polygon-region") {
    const view = capability.polygonRegion ?? { maxPolygons: 6, pointCount: 8, polygons: [] };
    return `<div class="polygon" data-polygon-control data-polygon-max="${view.maxPolygons}" data-polygon-point-count="${view.pointCount}">
      <div class="region-toolbar"><span class="muted small"><output data-polygon-count>${view.polygons.length}</output> / ${view.maxPolygons}</span><span class="muted small" data-polygon-selected-label>${escapeHtml(view.polygons.length ? t("cam.area.selected", { area: 1 }) : t("cam.area.none"))}</span></div>
      <svg class="polygon-canvas" viewBox="0 0 100 100" preserveAspectRatio="none" role="group" aria-label="${escapeHtml(t("cam.polygon.label"))}" data-polygon-canvas>${view.polygons.map((polygon, index) => renderPolygonGroup(ctx, polygon, index)).join("")}</svg>
      <p class="note">${escapeHtml(t("cam.polygon.help"))}</p>
      <div class="bar"><button type="button" class="btn" data-polygon-add${disabledAttribute}>${escapeHtml(t("cam.polygon.add"))}</button><button type="button" class="btn" data-polygon-remove${disabledAttribute}${view.polygons.length ? "" : " disabled"}>${escapeHtml(t("cam.polygon.remove"))}</button><button type="button" class="btn btn-primary" data-polygon-save${common}${disabledAttribute}>${escapeHtml(t("cam.polygon.save"))}</button></div>
    </div>`;
  }
  if (capability.kind === "presets") {
    const presets = capability.presets ?? [];
    return `<div class="presets">
      <div class="chips">${presets.length > 0 ? presets.map((preset) => `<span class="chip"><button type="button" class="btn" data-preset-recall="${escapeHtml(preset.id)}" data-preset-label="${escapeHtml(preset.label)}"${common}${disabledAttribute}>${escapeHtml(preset.label)}</button><button type="button" class="btn btn-danger" aria-label="${escapeHtml(t("cam.preset.delete", { label: preset.label }))}" data-preset-delete="${escapeHtml(preset.id)}" data-preset-label="${escapeHtml(preset.label)}"${common}${disabledAttribute}>×</button></span>`).join("") : `<span class="muted small">${escapeHtml(t("cam.preset.none"))}</span>`}</div>
      <div class="field-row"><input type="text" maxlength="40" placeholder="${escapeHtml(t("cam.preset.name"))}" aria-label="${escapeHtml(t("cam.preset.name"))}" data-preset-name${disabledAttribute}><button type="button" class="btn" data-preset-save${common}${disabledAttribute}>${escapeHtml(t("cam.preset.save"))}</button></div>
    </div>`;
  }
  if (capability.kind === "ptz") {
    return `<div class="ptz" role="group" aria-label="${escapeHtml(t("cam.ptz.label"))}">
      <button type="button" class="btn btn-icon" data-icon="left" data-ptz-direction="left"${common}${disabledAttribute} aria-label="${escapeHtml(t("cam.ptz.left"))}">${escapeHtml(t("cam.ptz.left"))}</button>
      <button type="button" class="btn btn-icon" data-icon="right" data-ptz-direction="right"${common}${disabledAttribute} aria-label="${escapeHtml(t("cam.ptz.right"))}">${escapeHtml(t("cam.ptz.right"))}</button>
      <span class="note">${escapeHtml(t("cam.ptz.help"))}</span>
    </div>`;
  }
  return "";
}

/** Controls confirmed working against the real camera through the local stack. Anything else renders under "Unverified". */
const VERIFIED_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "video.quality", "video.nightVision", "video.flip",
  "device.statusLed", "device.privacy",
  "audio.listen", "audio.microphone", "audio.volume",
  "detection.motion", "detection.motionSensitivity", "detection.sound", "detection.soundSensitivity",
  "detection.tracking", "detection.bark", "detection.pet",
  "feed.portions", "feed.schedule", "feed.sound", "meari.dispenseSound", "meari.feedCall",
  "camera.ptz", "camera.presets", "camera.calibrate",
  "onvif.enabled",
  "device.wake",
]);

const PLACEHOLDER_CAPABILITIES: ReadonlySet<CameraCapabilityDescriptor> = new Set(DEFAULT_CAMERA_CAPABILITIES);

/** Verified means the camera reported the control; a placeholder belongs under Unverified even when its id is on the list. */
function isVerifiedCapability(capability: CameraCapabilityDescriptor): boolean {
  return VERIFIED_CAPABILITY_IDS.has(capability.id) && !PLACEHOLDER_CAPABILITIES.has(capability);
}

/** One row: label · availability mark · reported value · control. */
function renderCapability(ctx: PageContext, capability: CameraCapabilityDescriptor): string {
  const { t } = ctx.i18n;
  const wide = ["ptz", "treat", "schedule", "region", "polygon-region", "presets", "json"].includes(capability.kind);
  const statusValue = capability.kind !== "status" && capability.readOnly === true && capability.value != null
    ? String(capability.value) + (typeof capability.value === "number" ? (capability.unit ?? "") : "")
    : "";
  const mark = capability.availability === "available" ? "" : `<span class="mark" data-availability="${capability.availability}" title="${escapeHtml(t(`cam.avail.${capability.availability}`))}"></span>`;
  return `<div class="cap${wide ? " cap-wide" : ""}${capability.dangerous ? " cap-danger" : ""}" data-capability-card="${escapeHtml(capability.id)}" data-availability-state="${capability.availability}">
    <span class="cap-label">${escapeHtml(capabilityLabel(ctx, capability))}${mark}${statusValue ? `<span class="cap-status num">${escapeHtml(statusValue)}</span>` : ""}</span>
    <span class="cap-control">${renderControlInput(ctx, capability)}</span>
  </div>`;
}

function renderCategory(ctx: PageContext, category: CameraCapabilityCategory, capabilities: CameraCapabilityDescriptor[], heading: "h2" | "h3"): string {
  const inCategory = capabilities.filter((capability) => capability.category === category);
  if (inCategory.length === 0) return "";
  // Only verified groups are addressable by category; unverified ones live inside the one "unverified" block.
  const tag = heading === "h2" ? ` data-category="${category}"` : "";
  return `<section class="cap-group"${tag}><${heading}>${escapeHtml(ctx.i18n.t(`cam.category.${category}`))}</${heading}><div class="cap-list">${inCategory.map((capability) => renderCapability(ctx, capability)).join("")}</div></section>`;
}

/** Every control, verified categories first, then one collapsed block for controls not confirmed on real hardware. */
function renderDeviceControls(ctx: PageContext, capabilities: CameraCapabilityDescriptor[]): string {
  const { t } = ctx.i18n;
  const verified = capabilities.filter(isVerifiedCapability);
  const unverified = capabilities.filter((capability) => !isVerifiedCapability(capability));
  const verifiedHtml = CATEGORY_ORDER.map((category) => renderCategory(ctx, category, verified, "h2")).join("");
  if (unverified.length === 0) return verifiedHtml;
  const dangerous = unverified.some((capability) => capability.dangerous);
  return `${verifiedHtml}<details class="unverified" data-category="unverified">
    <summary><span class="unverified-title">${escapeHtml(t("cam.unverified"))}</span> <span class="muted small">${escapeHtml(t("cam.unverifiedNote"))}</span></summary>
    ${dangerous ? `<label class="checks unlock"><input type="checkbox" id="safety-unlock"> ${escapeHtml(t("cam.unlock"))}</label>` : ""}
    ${CATEGORY_ORDER.map((category) => renderCategory(ctx, category, unverified, "h3")).join("")}
  </details>`;
}

function renderConnectionGuide(ctx: PageContext, model: CameraDashboardModel): string {
  const { t } = ctx.i18n;
  const camera = model.devices.find((device) => device.capabilities.some((capability) => capability.id === "local.discovery" && capability.availability === "available"));
  if (!camera) return "";
  const onvif = camera.capabilities.find((capability) => capability.id === "onvif.enabled");
  if (onvif?.availability === "available") return "";
  const discovery = camera.capabilities.find((capability) => capability.id === "local.discovery");
  const address = typeof discovery?.value === "string" ? discovery.value : camera.host ?? "";
  const key = onvif?.value === "Enabled; password required" ? "cam.setup.guide.password" : "cam.setup.guide.enable";
  return `<p class="note">${escapeHtml(t(key, { name: camera.name, address }))}</p>`;
}

function renderSetup(ctx: PageContext, model: CameraDashboardModel): string {
  const { t } = ctx.i18n;
  const profile = model.setup.profile;
  const localControlReady = model.devices.some((device) => device.capabilities.some((capability) => capability.id === "local.nativeControl" && capability.availability === "available"));
  const showDiscoveryHelp = model.discovery.status === "error" || (model.discovery.status === "ready" && model.devices.length === 0);
  const discoveryMessage = model.discovery.message ?? (model.discovery.status === "ready" ? t("cam.discover.finished") : t("cam.discover.ready"));
  const optional = localControlReady ? t("cam.setup.optionalLocal") : t("cam.setup.requiredCloud");
  const keep = model.setup.configured ? ` placeholder="${escapeHtml(t("cam.setup.keep"))}"` : "";
  return `<section class="setup" aria-labelledby="setup-title">
    <h2 id="setup-title">${escapeHtml(t("cam.setup.title"))}</h2>
    <p class="note">${escapeHtml(t("cam.setup.intro"))}</p>
    ${renderConnectionGuide(ctx, model)}
    <form id="discovery-form">
      <div class="bar"><button type="submit" class="btn btn-primary" id="discover-button" data-discover-submit${model.discovery.status === "searching" ? " disabled" : ""}>${escapeHtml(model.discovery.status === "searching" ? t("cam.discover.looking") : t("cam.discover.button"))}</button></div>
      <p class="feedback" id="discovery-message" role="status" aria-live="polite" aria-atomic="true"${model.discovery.status === "error" ? ' data-tone="bad"' : ""}>${escapeHtml(discoveryMessage)}</p>
      <details class="discovery-help"${showDiscoveryHelp ? " open" : ""}>
        <summary>${escapeHtml(t("cam.discover.byAddress"))}</summary>
        <label class="field"><span>${escapeHtml(t("cam.discover.hosts"))}</span><input id="discovery-hosts" name="hosts" class="mono" inputmode="url" autocomplete="off" placeholder="10.77.0.42"><small class="muted">${escapeHtml(t("cam.discover.hostsHint"))}</small></label>
        <label class="field"><span>${escapeHtml(t("cam.discover.cidrs"))}</span><input id="discovery-cidrs" name="cidrs" class="mono" inputmode="url" autocomplete="off" placeholder="10.77.0.0/24"><small class="muted">${escapeHtml(t("cam.discover.cidrsHint"))}</small></label>
        <div class="bar"><button type="submit" class="btn" data-discover-submit>${escapeHtml(t("cam.discover.scanAddress"))}</button></div>
      </details>
    </form>
    <details class="connection-details"${model.setup.configured ? "" : " open"}>
      <summary>${escapeHtml(model.setup.configured ? t("cam.setup.update") : t("cam.setup.connect"))}${model.setup.accountHint ? ` <span class="muted">${escapeHtml(model.setup.accountHint)}</span>` : ""}</summary>
      <form id="setup-form" autocomplete="on">
        <fieldset>
          <legend>${escapeHtml(t("cam.setup.app"))}</legend>
          <label class="field"><span>${escapeHtml(t("cam.setup.profile"))}</span><select id="profile" name="profile"><option value="tkenpro"${profile === "tkenpro" ? " selected" : ""}>TkenPro</option><option value="cloudedge"${profile === "cloudedge" ? " selected" : ""}>CloudEdge</option></select></label>
          <div class="fields">
            <label class="field"><span>${escapeHtml(t("cam.setup.country"))}</span><input id="country" name="countryCode" autocomplete="country" autocapitalize="characters" placeholder="US" minlength="2" maxlength="2" pattern="[A-Za-z]{2}"><small class="muted">${escapeHtml(t("cam.setup.countryHint"))}</small></label>
            <label class="field"><span>${escapeHtml(t("cam.setup.phoneCode"))}</span><input id="phone-code" name="phoneCode" autocomplete="tel-country-code" inputmode="tel" maxlength="8"><small class="muted">${escapeHtml(t("cam.setup.phoneCodeHint"))}</small></label>
          </div>
          <label class="field"><span>${escapeHtml(t("cam.setup.email"))} <span class="muted">(${escapeHtml(optional)})</span></span><input id="email" name="email" type="text" autocomplete="username"${model.setup.accountHint ? ` placeholder="${escapeHtml(model.setup.accountHint)}"` : ""}></label>
          <label class="field"><span>${escapeHtml(t("cam.setup.password"))} <span class="muted">(${escapeHtml(optional)})</span></span><input id="password" name="password" type="password" autocomplete="current-password"${keep}></label>
        </fieldset>
        <fieldset>
          <legend>${escapeHtml(t("cam.setup.onvif"))}</legend>
          <div class="fields">
            <label class="field"><span>${escapeHtml(t("cam.setup.onvifUser"))}</span><input id="onvif-username" name="onvifUsername" autocomplete="off" value="admin"></label>
            <label class="field"><span>${escapeHtml(t("cam.setup.onvifPassword"))}</span><input id="onvif-password" name="onvifPassword" type="password" autocomplete="new-password" maxlength="16"${keep}></label>
          </div>
          <label class="checks"><input id="activate-onvif" name="activateOnvif" type="checkbox"><span>${escapeHtml(t("cam.setup.activate"))} <span class="muted">${escapeHtml(t("cam.setup.activateHint"))}</span></span></label>
        </fieldset>
        <p class="note">${escapeHtml(t("cam.setup.privacy"))}</p>
        <div class="bar"><button class="btn btn-primary" type="submit">${escapeHtml(t("cam.setup.save"))}</button>${model.setup.configured ? `<button class="btn" type="button" id="disconnect-button">${escapeHtml(t("cam.setup.forget"))}</button>` : ""}</div>
        <p class="feedback" id="setup-feedback" role="status" aria-live="polite" aria-atomic="true"></p>
      </form>
    </details>
  </section>`;
}

/** Flat single-colour glyphs for the icon bar; painted via CSS mask so they follow the button's text colour. */
const ICON_SHAPES: Readonly<Record<string, string>> = {
  play: "<polygon points='7,4 20,12 7,20'/>",
  pause: "<rect x='5' y='4' width='5' height='16'/><rect x='14' y='4' width='5' height='16'/>",
  camera: "<path fill-rule='evenodd' d='M4 8h3.2l1.8-3h6l1.8 3H20v11H4z M12 10a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4z'/>",
  record: "<circle cx='12' cy='12' r='7'/>",
  speaker: "<path d='M4 9v6h4l5 4V5L8 9z'/><path d='M16.5 8.5a5 5 0 0 1 0 7' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/>",
  mic: "<rect x='9' y='3' width='6' height='11' rx='3'/><path d='M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/>",
  treat: "<rect x='6' y='10.5' width='12' height='3'/><circle cx='5.5' cy='9.5' r='2.5'/><circle cx='5.5' cy='14.5' r='2.5'/><circle cx='18.5' cy='9.5' r='2.5'/><circle cx='18.5' cy='14.5' r='2.5'/>",
  left: "<path d='M15 5l-7 7 7 7' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/>",
  right: "<path d='M9 5l7 7-7 7' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/>",
};

function iconDataUri(shape: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${shape}</svg>`;
  return `data:image/svg+xml;utf8,${svg.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("#", "%23")}`;
}

const ICON_CSS = Object.entries(ICON_SHAPES)
  .map(([name, shape]) => `  .btn-icon[data-icon="${name}"]::before { -webkit-mask-image: url("${iconDataUri(shape)}"); mask-image: url("${iconDataUri(shape)}"); }`)
  .join("\n");

const DASHBOARD_CSS = String.raw`
  .statusline { display: flex; align-items: start; gap: var(--s3); flex-wrap: wrap; padding-block: var(--s2); border-block: var(--rule-w) solid var(--rule); font-size: .9375rem; }
  .statusline > .mark { margin-block-start: calc((1.5em - var(--mark)) / 2); }
  .statusline > .btn { align-self: center; }
  #status-bar-text { flex: 1 1 14rem; min-width: 0; }
  .stage-frame .placeholder p:empty { display: none; }
  .unverified:first-child { margin-block-start: 0; border-block-start: 0; padding-block-start: 0; }
  .statusline[data-kind="warn"] #status-bar-text { color: var(--warn); }
  .statusline[data-kind="error"] #status-bar-text { color: var(--bad); }
  .statusline[data-kind="busy"] .mark { animation: ht-pulse 1.2s infinite; }
  .workspace { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(19rem, .8fr); gap: var(--s5); align-items: start; margin-block-start: var(--s4); }
  .viewer { position: sticky; top: var(--s3); }
  .stage-frame { --stage-aspect: var(--viewer-aspect, 4 / 3); }
  .stage-frame .placeholder h2 { border: 0; margin: 0 0 var(--s2); color: inherit; font-size: 1.25rem; }
  .live-pill { position: absolute; z-index: 2; inset-block-start: var(--s3); inset-inline-start: var(--s3); display: inline-flex; align-items: center; gap: var(--s2); padding: .2rem .55rem; color: var(--stage-fg); background: color-mix(in srgb, var(--stage) 70%, transparent); font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
  .live-pill::before { width: .45rem; height: .45rem; border-radius: var(--mark-radius); background: var(--bad); content: ""; }
  .icon-bar { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; padding-block: var(--s2); border-block-end: 1px solid var(--hair); }
  .icon-bar-gap { width: var(--s3); }
${ICON_CSS}
  .playback { display: flex; align-items: end; gap: var(--s2); flex-wrap: wrap; padding-block: var(--s2); }
  .playback .field { flex: 1 1 14rem; margin: 0; }
  .playback .bar { margin: 0; }
  .viewer-meta { color: var(--fg-2); font-size: .8125rem; padding-block: var(--s2); }
  .controls-tabs { margin-block-end: var(--s4); }
  .cap-list { border-block-start: 1px solid var(--hair); }
  .cap { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding-block: var(--s2); border-block-end: 1px solid var(--hair); min-width: 0; }
  .cap-wide { flex-direction: column; align-items: stretch; }
  .cap-label { display: inline-flex; align-items: center; gap: var(--s2); min-width: 0; font-size: .9375rem; }
  .cap .mark { --mark: .45rem; }
  .cap-danger .cap-label { color: var(--bad); }
  .cap-control { flex: 0 0 auto; }
  .cap-wide .cap-control { width: 100%; }
  .cap-status { color: var(--fg-2); font-size: .8125rem; }
  .cap select, .cap input[type="text"], .cap input[type="url"], .cap input[type="number"], .cap input[type="time"] { min-height: 2rem; padding-block: .2rem; font-size: .875rem; }
  .cap-wide select, .cap-wide input[type="text"], .cap-wide input[type="url"] { width: 100%; }
  .cap h2, .cap-group h3 { margin-block-start: var(--s5); }
  .unverified { margin-block-start: var(--s5); border-block-start: var(--rule-w) solid var(--rule); padding-block-start: var(--s3); }
  .unverified > summary { display: flex; align-items: baseline; gap: var(--s2); }
  .unverified-title { color: var(--fg); font-size: 1rem; }
  .unlock { margin-block: var(--s3); color: var(--bad); }
  .switch { position: relative; display: inline-flex; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .switch-track { display: block; width: 2.75rem; height: 1.5rem; padding: .15rem; border: var(--rule-w) solid var(--rule); background: transparent; transition: background var(--motion), border-color var(--motion); }
  .switch-track span { display: block; width: 1.05rem; height: 1.05rem; background: var(--fg-2); transition: transform var(--motion), background var(--motion); }
  .switch input:checked + .switch-track { background: var(--fg); border-color: var(--fg); }
  .switch input:checked + .switch-track span { transform: translateX(1.25rem); background: var(--bg); }
  .switch input:disabled + .switch-track { opacity: .5; cursor: not-allowed; }
  .switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .range { display: flex; align-items: center; gap: var(--s2); min-width: 11rem; }
  .range output { min-width: 3ch; text-align: end; }
  .reported { display: block; max-width: 14rem; overflow-wrap: anywhere; text-align: end; }
  .danger-control { display: grid; justify-items: end; gap: var(--s1); }
  .danger-control small { max-width: 12rem; text-align: end; font-size: .75rem; }
  .json-control { display: grid; gap: var(--s2); }
  .json-control textarea { width: 100%; font-size: .8125rem; }
  .region, .polygon, .schedule, .presets { display: grid; gap: var(--s2); }
  .region-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
  .region-toolbar .btn { min-height: 2rem; padding: .2rem .6rem; font-size: .8125rem; }
  .region-grid { display: grid; grid-template-columns: repeat(var(--region-columns), 1fr); aspect-ratio: 16 / 9; background: var(--stage); touch-action: none; }
  .region-cell { min-width: 0; min-height: 0; border: 0; border-inline-end: 1px solid color-mix(in srgb, var(--stage-fg) 25%, transparent); border-block-end: 1px solid color-mix(in srgb, var(--stage-fg) 25%, transparent); padding: 0; background: transparent; cursor: pointer; }
  .region-cell[aria-pressed="true"] { background: color-mix(in srgb, var(--bad) 70%, transparent); }
  .region-cell:focus-visible { position: relative; z-index: 1; outline-offset: -2px; }
  .polygon-canvas { width: 100%; aspect-ratio: 16 / 9; overflow: visible; background: var(--stage); touch-action: none; }
  .polygon-shape { fill: color-mix(in srgb, var(--bad) 25%, transparent); stroke: color-mix(in srgb, var(--stage-fg) 70%, transparent); stroke-width: .8; vector-effect: non-scaling-stroke; cursor: pointer; }
  [data-polygon-selected="true"] .polygon-shape { fill: color-mix(in srgb, var(--bad) 50%, transparent); stroke: var(--stage-fg); stroke-width: 1.5; }
  .polygon-point { display: none; fill: var(--stage-fg); stroke: var(--bad); stroke-width: .8; vector-effect: non-scaling-stroke; cursor: grab; }
  [data-polygon-selected="true"] .polygon-point { display: block; }
  .polygon-point:active { cursor: grabbing; }
  .polygon-point:focus-visible { display: block; outline: none; stroke: var(--accent); stroke-width: 2; }
  .schedule-list { display: grid; gap: var(--s3); }
  .schedule-entry { position: relative; padding-block: var(--s2); border-block-end: 1px solid var(--hair); }
  .schedule-remove { position: absolute; inset-block-start: var(--s2); inset-inline-end: 0; font-size: .8125rem; color: var(--bad); }
  .schedule-row { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: end; padding-inline-end: 4rem; }
  .schedule-field { display: grid; gap: var(--s1); color: var(--fg-2); font-size: .8125rem; }
  .schedule-field input[type="checkbox"] { justify-self: start; }
  .weekdays { display: flex; gap: var(--s1); margin-block-start: var(--s2); }
  .weekdays legend { color: var(--fg-2); font-size: .8125rem; margin-block-end: var(--s1); }
  .weekdays input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .weekdays span { display: grid; width: 2rem; height: 2rem; place-items: center; border: var(--rule-w) solid var(--rule); font-size: .8125rem; }
  .weekdays input:checked + span { color: var(--accent-fg); background: var(--fg); border-color: var(--fg); }
  .weekdays input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ptz { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
  .ptz .btn { touch-action: none; user-select: none; }
  .setup { margin-block-start: var(--s5); }
  .setup .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0 var(--s3); }
  .setup fieldset { margin-block: var(--s3); }
  .setup details { margin-block: var(--s3); }
  .setup .field { margin-block: var(--s2); }
  .onboarding { margin-block-start: var(--s6); }
  @media (max-width: 62rem) {
    .workspace { grid-template-columns: 1fr; }
    .viewer { position: static; }
  }
`;

/** The Controls/Events tabs; the log itself only starts loading once its tab is first opened. */
const TAB_SCRIPT = String.raw`
  (() => {
    const tabs = [
      { tab: document.querySelector("#tab-controls"), panel: document.querySelector("#panel-controls") },
      { tab: document.querySelector("#tab-events"), panel: document.querySelector("#panel-events") },
    ].filter((entry) => entry.tab instanceof HTMLElement && entry.panel instanceof HTMLElement);
    if (tabs.length < 2) return;
    const select = (chosen) => {
      for (const entry of tabs) {
        const active = entry === chosen;
        entry.tab.setAttribute("aria-selected", String(active));
        entry.panel.hidden = !active;
      }
      if (chosen.panel.id === "panel-events") window.dispatchEvent(new CustomEvent("hometruth:events-visible"));
    };
    for (const entry of tabs) entry.tab.addEventListener("click", () => ht.pageState.update({ 'camera-tab': entry.panel.id === 'panel-events' ? 'events' : null }));
    ht.pageState.watch(['camera-tab'], query => select(query.get('camera-tab') === 'events' ? tabs[1] : tabs[0]));
  })();
`;

const DASHBOARD_SCRIPT = String.raw`
  (() => {
    "use strict";
    const root = document.querySelector("[data-camera-dashboard]");
    if (!(root instanceof HTMLElement)) return;
    const api = JSON.parse(root.dataset.api || "{}");
    const t = ht.t;

    const deviceId = () => root.dataset.deviceId || "";
    const deviceName = () => root.dataset.deviceName || "camera";
    const commandId = () => {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
      return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    };
    const statusBar = document.querySelector("#status-bar");
    const statusText = document.querySelector("#status-bar-text");
    const setStatus = (message, kind) => {
      if (statusText instanceof HTMLElement) {
        const base = statusText.dataset.base || "";
        statusText.textContent = base ? base + " · " + message : message;
      }
      if (statusBar instanceof HTMLElement) statusBar.dataset.kind = kind || "info";
    };
    // The status line is the page's one voice: every outcome lands there, in its tone.
    const announce = (message, kind) => setStatus(message, kind === "error" ? "error" : kind === "busy" ? "busy" : "ok");
    const post = async (url, body, options) => {
      const response = await fetch(url, {
        method: "POST", credentials: "same-origin", cache: "no-store", keepalive: Boolean(options && options.keepalive),
        headers: { "accept": "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(ht.errorOf(payload, t("cam.requestRejected")));
      return payload;
    };
    const reloadState = () => window.location.reload();
    const requireDevice = () => {
      if (deviceId()) return true;
      announce(t("cam.chooseFirst"), "error");
      return false;
    };
    const sendControl = async (capabilityId, value, confirmed, quiet) => {
      if (!requireDevice()) return null;
      try {
        const payload = await post(api.control, { deviceId: deviceId(), capabilityId, value, confirmed: Boolean(confirmed) });
        if (!quiet) announce(t("cam.updated"));
        return payload;
      } catch (error) {
        if (!quiet) announce(error instanceof Error ? error.message : t("cam.controlFailed"), "error");
        throw error;
      }
    };

    const setupFeedback = document.querySelector("#setup-feedback");
    const showSetupFeedback = (message, kind) => {
      ht.say(setupFeedback, message, kind === "error" ? "bad" : kind === "success" ? "ok" : undefined);
      if (setupFeedback instanceof HTMLElement) setupFeedback.setAttribute("role", kind === "error" ? "alert" : "status");
    };
    const discoveryMessage = document.querySelector("#discovery-message");
    const showDiscoveryMessage = (message, kind) => {
      ht.say(discoveryMessage, message, kind === "error" || kind === "empty" ? "bad" : kind === "ready" ? "ok" : undefined);
      if (discoveryMessage instanceof HTMLElement) discoveryMessage.setAttribute("role", kind === "error" ? "alert" : "status");
    };

    const setupForm = document.querySelector("#setup-form");
    if (setupForm instanceof HTMLFormElement) {
      setupForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submit = setupForm.querySelector("button[type=submit]");
        const fields = new FormData(setupForm);
        const optionalText = (name, preserveWhitespace) => {
          const entry = fields.get(name);
          if (typeof entry !== "string") return undefined;
          const value = preserveWhitespace ? entry : entry.trim();
          return value.length > 0 ? value : undefined;
        };
        const body = { profile: fields.get("profile") };
        const countryCode = optionalText("countryCode");
        const phoneCode = optionalText("phoneCode");
        const email = optionalText("email");
        const passwordValue = optionalText("password", true);
        const onvifUsername = optionalText("onvifUsername");
        const onvifPasswordValue = optionalText("onvifPassword", true);
        const activateOnvif = fields.get("activateOnvif") === "on";
        if (activateOnvif && (!email || !passwordValue || !onvifPasswordValue)) {
          const missing = [];
          if (!email) missing.push(t("cam.setup.missing.email"));
          if (!passwordValue) missing.push(t("cam.setup.missing.password"));
          if (!onvifPasswordValue) missing.push(t("cam.setup.missing.onvifPassword"));
          showSetupFeedback(t("cam.setup.missing", { missing: missing.join(", ") }), "error");
          return;
        }
        if (activateOnvif && (onvifPasswordValue.length > 16 || !/^[\x20-\x7e]+$/.test(onvifPasswordValue))) {
          showSetupFeedback(t("cam.setup.passwordRule"), "error");
          return;
        }
        if (activateOnvif && !window.confirm(t("cam.setup.confirmOnvif"))) return;
        if (countryCode) body.countryCode = countryCode.toUpperCase();
        if (phoneCode) body.phoneCode = phoneCode;
        if (email) body.email = email;
        if (passwordValue) body.password = passwordValue;
        if (onvifUsername) body.onvifUsername = onvifUsername;
        if (onvifPasswordValue) body.onvifPassword = onvifPasswordValue;
        const password = setupForm.querySelector("#password");
        const onvifPassword = setupForm.querySelector("#onvif-password");
        if (submit instanceof HTMLButtonElement) submit.disabled = true;
        showSetupFeedback(t("cam.setup.checking"), "progress");
        try {
          await post(api.setup, body);
          showSetupFeedback(t("cam.setup.accepted"), "progress");
          const discovered = await post(api.discover, {});
          const discoveredState = discovered && typeof discovered === "object" && discovered.state ? discovered.state : discovered;
          const discoveredDevices = discoveredState && typeof discoveredState === "object" && Array.isArray(discoveredState.devices) ? discoveredState.devices : [];
          const onvifReady = (device) => Array.isArray(device.capabilities) && device.capabilities.some((capability) => capability.id === "onvif.enabled" && capability.availability === "available");
          if (activateOnvif) {
            const camera = discoveredDevices.find(onvifReady);
            if (!camera) throw new Error(t("cam.setup.noOnvifControl"));
            showSetupFeedback(t("cam.setup.enablingOnvif"), "progress");
            await post(api.control, { deviceId: camera.id, capabilityId: "onvif.enabled", value: true, confirmed: true });
            showSetupFeedback(t("cam.setup.onvifWaiting"), "progress");
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
            await post(api.discover, {});
          } else if (onvifPasswordValue && !email && !discoveredDevices.find(onvifReady)) {
            throw new Error(t("cam.setup.passwordRejected"));
          }
          const message = t(activateOnvif ? "cam.setup.activated" : "cam.setup.checked");
          showSetupFeedback(message, "success");
          announce(message);
          if (password instanceof HTMLInputElement) password.value = "";
          if (onvifPassword instanceof HTMLInputElement) onvifPassword.value = "";
          window.setTimeout(reloadState, 350);
        } catch (error) {
          const message = error instanceof Error ? error.message : t("cam.setup.saveFailed");
          showSetupFeedback(message, "error");
          announce(message, "error");
        } finally {
          if (submit instanceof HTMLButtonElement) submit.disabled = false;
        }
      });
    }

    const discoveryForm = document.querySelector("#discovery-form");
    const discoverButton = document.querySelector("#discover-button");
    if (discoveryForm instanceof HTMLFormElement && discoverButton instanceof HTMLButtonElement) {
      discoveryForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const splitTargets = (value, maximum) => Array.from(new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))).slice(0, maximum);
        const fields = new FormData(discoveryForm);
        const hostsEntry = fields.get("hosts");
        const cidrsEntry = fields.get("cidrs");
        const hosts = splitTargets(typeof hostsEntry === "string" ? hostsEntry : "", 64);
        const cidrs = splitTargets(typeof cidrsEntry === "string" ? cidrsEntry : "", 16);
        const body = {};
        if (hosts.length > 0) body.hosts = hosts;
        if (cidrs.length > 0) body.cidrs = cidrs;
        const buttons = discoveryForm.querySelectorAll("[data-discover-submit]");
        buttons.forEach((button) => { if (button instanceof HTMLButtonElement) button.disabled = true; });
        discoverButton.textContent = t(hosts.length > 0 || cidrs.length > 0 ? "cam.discover.checkingAddress" : "cam.discover.looking");
        showDiscoveryMessage(t("cam.discover.wait"), "searching");
        let reloadAfterDiscovery = false;
        try {
          const payload = await post(api.discover, body);
          const state = payload && typeof payload === "object" && payload.state ? payload.state : payload;
          const discovery = state && typeof state === "object" ? state.discovery : null;
          const devices = state && typeof state === "object" && Array.isArray(state.devices) ? state.devices : [];
          const message = discovery && typeof discovery.message === "string" ? discovery.message : devices.length > 0 ? t("cam.discover.found", { count: devices.length }) : t("cam.discover.none");
          if (discovery && discovery.status === "error") {
            showDiscoveryMessage(message, "error");
            announce(message, "error");
          } else if (devices.length === 0) {
            showDiscoveryMessage(message, "empty");
            announce(message, "error");
            const help = discoveryForm.querySelector(".discovery-help");
            if (help instanceof HTMLDetailsElement) help.open = true;
          } else {
            showDiscoveryMessage(message, "ready");
            announce(message);
            reloadAfterDiscovery = true;
            window.setTimeout(reloadState, 650);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : t("cam.discover.failed");
          showDiscoveryMessage(message, "error");
          announce(message, "error");
          const help = discoveryForm.querySelector(".discovery-help");
          if (help instanceof HTMLDetailsElement) help.open = true;
        } finally {
          if (!reloadAfterDiscovery) {
            buttons.forEach((button) => { if (button instanceof HTMLButtonElement) button.disabled = false; });
            discoverButton.textContent = t("cam.discover.button");
          }
        }
      });
    }

    const disconnectButton = document.querySelector("#disconnect-button");
    if (disconnectButton instanceof HTMLButtonElement) {
      disconnectButton.addEventListener("click", async () => {
        if (!window.confirm(t("cam.setup.confirmForget"))) return;
        disconnectButton.disabled = true;
        try {
          await post(api.disconnect, {});
          announce(t("cam.setup.forgotten"));
          reloadState();
        } catch (error) {
          announce(error instanceof Error ? error.message : t("cam.setup.forgetFailed"), "error");
          disconnectButton.disabled = false;
        }
      });
    }

    const liveButton = document.querySelector("#live-button");
    const listenButton = document.querySelector("#listen-button");
    const snapshotButton = document.querySelector("#snapshot-button");
    const recordButton = document.querySelector("#record-button");
    const viewerAudio = document.querySelector("#viewer-audio");
    const viewerImage = document.querySelector("#viewer-image");
    const viewerStage = document.querySelector(".stage-frame");
    // The stage reserves a 4:3 box before any frame arrives; if a frame reports another shape the stage adopts it once and holds it.
    const rememberViewerAspect = () => {
      if (!(viewerImage instanceof HTMLImageElement) || !(viewerStage instanceof HTMLElement)) return;
      if (!(viewerImage.naturalWidth > 0) || !(viewerImage.naturalHeight > 0)) return;
      viewerStage.style.setProperty("--viewer-aspect", String(Math.round((viewerImage.naturalWidth / viewerImage.naturalHeight) * 1000) / 1000));
    };
    if (viewerImage instanceof HTMLImageElement) {
      viewerImage.addEventListener("load", rememberViewerAspect);
      if (viewerImage.complete) rememberViewerAspect();
    }
    const viewerPlaceholder = document.querySelector("#viewer-placeholder");
    const viewerModePill = document.querySelector("#viewer-mode-pill");
    const playbackTime = document.querySelector("#playback-time");
    const playbackStartButton = document.querySelector("#playback-start-button");
    const playbackSeekButton = document.querySelector("#playback-seek-button");
    const playbackPauseButton = document.querySelector("#playback-pause-button");
    const playbackStopButton = document.querySelector("#playback-stop-button");
    let playbackActive = false;
    let playbackPaused = false;
    let activeLocalRecording = null;
    const playbackUrl = (action) => "/api/camera/devices/" + encodeURIComponent(deviceId()) + "/playback/" + action;
    const setViewerMode = (label) => {
      if (!(viewerModePill instanceof HTMLElement)) return;
      viewerModePill.textContent = label;
      viewerModePill.hidden = !label;
    };
    const setPlaceholder = (message) => {
      if (!(viewerPlaceholder instanceof HTMLElement)) return;
      viewerPlaceholder.hidden = false;
      const text = viewerPlaceholder.querySelector("p");
      if (text) text.textContent = message;
    };
    const setPlaybackButtons = () => {
      if (playbackStartButton instanceof HTMLButtonElement) playbackStartButton.disabled = playbackActive || playbackTime instanceof HTMLInputElement && playbackTime.disabled;
      if (playbackSeekButton instanceof HTMLButtonElement) playbackSeekButton.disabled = !playbackActive;
      if (playbackPauseButton instanceof HTMLButtonElement) {
        playbackPauseButton.disabled = !playbackActive;
        playbackPauseButton.textContent = t(playbackPaused ? "cam.playback.resume" : "action.pause");
      }
      if (playbackStopButton instanceof HTMLButtonElement) playbackStopButton.disabled = !playbackActive;
    };
    const playbackTimestamp = () => {
      if (!(playbackTime instanceof HTMLInputElement)) return "";
      const digits = playbackTime.value.replace(/\D/g, "");
      return digits.length === 12 ? digits + "00" : digits.length === 14 ? digits : "";
    };
    const stopPlayback = async (quiet, clearPicture) => {
      const wasActive = playbackActive;
      playbackActive = false;
      playbackPaused = false;
      setPlaybackButtons();
      if (clearPicture && viewerImage instanceof HTMLImageElement && viewerImage.src.includes("/playback.mjpeg")) {
        viewerImage.removeAttribute("src");
        viewerImage.hidden = true;
        if (viewerPlaceholder instanceof HTMLElement) viewerPlaceholder.hidden = false;
        setViewerMode("");
      }
      if (!wasActive || !deviceId()) return;
      try {
        await post(playbackUrl("stop"), {}, { keepalive: clearPicture });
        if (!quiet) announce(t("cam.playback.stopped"));
      } catch (error) {
        if (!quiet) announce(error instanceof Error ? error.message : t("cam.playback.stopFailed"), "error");
      }
    };
    if (playbackTime instanceof HTMLInputElement && !playbackTime.value) {
      const recent = new Date(Date.now() - 5 * 60 * 1000);
      const local = new Date(recent.getTime() - recent.getTimezoneOffset() * 60 * 1000);
      playbackTime.value = local.toISOString().slice(0, 19);
    }
    setPlaybackButtons();
    let firstFrameTimer = 0;
    const setLiveButtonState = (playing) => {
      if (!(liveButton instanceof HTMLButtonElement)) return;
      liveButton.dataset.icon = playing ? "pause" : "play";
      liveButton.textContent = t(playing ? "action.pause" : "camera.live");
      liveButton.title = t(playing ? "cam.live.pause" : "cam.live.play");
      liveButton.setAttribute("aria-pressed", playing ? "true" : "false");
    };
    const liveViewActive = () => viewerImage instanceof HTMLImageElement && !viewerImage.hidden && viewerImage.src.includes("/stream.mjpeg");
    const stopLiveView = () => {
      window.clearTimeout(firstFrameTimer);
      if (viewerImage instanceof HTMLImageElement) {
        viewerImage.removeAttribute("src");
        viewerImage.hidden = true;
      }
      setPlaceholder(t("cam.live.paused"));
      setViewerMode("");
      setLiveButtonState(false);
      setStatus(t("cam.live.paused"), "info");
    };
    const setViewerImage = async (kind) => {
      if (!(viewerImage instanceof HTMLImageElement) || !deviceId()) return;
      await stopPlayback(true, false);
      window.clearTimeout(firstFrameTimer);
      const encodedId = encodeURIComponent(deviceId());
      viewerImage.hidden = false;
      viewerImage.src = kind === "snapshot" ? "/api/camera/devices/" + encodedId + "/snapshot?t=" + Date.now() : "/api/camera/devices/" + encodedId + "/stream.mjpeg";
      viewerImage.alt = t(kind === "snapshot" ? "cam.alt.still" : "cam.alt.live", { name: deviceName() });
      if (viewerPlaceholder instanceof HTMLElement) viewerPlaceholder.hidden = true;
      setViewerMode(t(kind === "snapshot" ? "cam.mode.still" : "camera.live"));
      if (kind === "snapshot") {
        setLiveButtonState(false);
        setStatus(t("cam.still.fetching"), "busy");
      } else {
        setLiveButtonState(true);
        setStatus(t("cam.live.connecting"), "busy");
        firstFrameTimer = window.setTimeout(() => {
          if (liveViewActive() && !(viewerImage.naturalWidth > 0)) setStatus(t("cam.live.slow"), "warn");
        }, 8000);
      }
    };
    const safeDownloadStem = () => {
      const stem = deviceName().normalize("NFKD").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48);
      return stem || "pet-camera";
    };
    const downloadBlob = (blob, suffix, extension) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeDownloadStem() + "-" + suffix + "-" + new Date().toISOString().replace(/[:.]/g, "-") + "." + extension;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    const captureAndDownloadSnapshot = async () => {
      if (!(viewerImage instanceof HTMLImageElement) || !requireDevice()) return;
      if (snapshotButton instanceof HTMLButtonElement) snapshotButton.disabled = true;
      try {
        const response = await fetch("/api/camera/devices/" + encodeURIComponent(deviceId()) + "/snapshot?t=" + Date.now(), { credentials: "same-origin", cache: "no-store", headers: { "accept": "image/jpeg" } });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(ht.errorOf(payload, t("camera.snapshotFailed")));
        }
        const blob = await response.blob();
        downloadBlob(blob, "snapshot", "jpg");
        const previewUrl = URL.createObjectURL(blob);
        await stopPlayback(true, false);
        viewerImage.hidden = false;
        viewerImage.src = previewUrl;
        viewerImage.alt = t("cam.alt.still", { name: deviceName() });
        viewerImage.addEventListener("load", () => URL.revokeObjectURL(previewUrl), { once: true });
        if (viewerPlaceholder instanceof HTMLElement) viewerPlaceholder.hidden = true;
        setViewerMode(t("cam.mode.still"));
        announce(t("cam.snapshot.saved"));
      } catch (error) {
        announce(error instanceof Error ? error.message : t("cam.snapshot.failed"), "error");
      } finally {
        if (snapshotButton instanceof HTMLButtonElement) snapshotButton.disabled = false;
      }
    };
    const waitForViewerFrame = () => new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (!(viewerImage instanceof HTMLImageElement)) { reject(new Error(t("cam.record.viewerUnavailable"))); return; }
        if (viewerImage.naturalWidth > 0 && viewerImage.naturalHeight > 0) { resolve(); return; }
        if (Date.now() - started >= 10000) { reject(new Error(t("cam.record.noFrame"))); return; }
        window.setTimeout(check, 100);
      };
      check();
    });
    const recordingMimeType = () => {
      if (typeof MediaRecorder !== "function") return "";
      return ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
    };
    const setRecordButtonState = (recording) => {
      if (!(recordButton instanceof HTMLButtonElement)) return;
      recordButton.textContent = t(recording ? "action.stop" : "cam.record");
      recordButton.title = t(recording ? "cam.record.stopTitle" : "cam.record.title");
      recordButton.setAttribute("aria-pressed", recording ? "true" : "false");
      recordButton.dataset.recording = recording ? "true" : "false";
    };
    const cleanupLocalRecording = (recording) => {
      window.cancelAnimationFrame(recording.drawTimer);
      window.clearTimeout(recording.limitTimer);
      recording.stream.getTracks().forEach((track) => track.stop());
      if (recording.audio) {
        recording.audio.pause();
        recording.audio.removeAttribute("src");
        recording.audio.load();
      }
      if (recording.audioContext) void recording.audioContext.close().catch(() => {});
    };
    const stopLocalRecording = (discard) => {
      const recording = activeLocalRecording;
      if (!recording) return;
      activeLocalRecording = null;
      recording.discard = Boolean(discard);
      setRecordButtonState(false);
      try {
        if (recording.recorder.state !== "inactive") {
          recording.recorder.requestData();
          recording.recorder.stop();
        } else {
          cleanupLocalRecording(recording);
        }
      } catch {
        cleanupLocalRecording(recording);
      }
    };
    const startLocalRecording = async () => {
      if (!(viewerImage instanceof HTMLImageElement) || !(recordButton instanceof HTMLButtonElement) || !requireDevice()) return;
      if (typeof MediaRecorder !== "function" || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
        announce(t("cam.record.unsupported"), "error");
        return;
      }
      recordButton.disabled = true;
      try {
        if (!viewerImage.src.includes("/stream.mjpeg")) await setViewerImage("live");
        await waitForViewerFrame();
        const scale = Math.min(1, 1280 / viewerImage.naturalWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(2, Math.round(viewerImage.naturalWidth * scale / 2) * 2);
        canvas.height = Math.max(2, Math.round(viewerImage.naturalHeight * scale / 2) * 2);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error(t("cam.record.prepareFailed"));
        const stream = canvas.captureStream(8);
        let audio = null;
        let audioContext = null;
        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            audio = document.createElement("audio");
            audio.preload = "none";
            audio.src = "/api/camera/devices/" + encodeURIComponent(deviceId()) + "/audio.mp3?t=" + Date.now();
            audioContext = new AudioContextClass();
            await audioContext.resume();
            const source = audioContext.createMediaElementSource(audio);
            const destination = audioContext.createMediaStreamDestination();
            source.connect(destination);
            await audio.play();
            destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
          }
        } catch {
          if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
          if (audioContext) await audioContext.close().catch(() => {});
          audio = null;
          audioContext = null;
        }
        const mimeType = recordingMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        const recording = { recorder, stream, audio, audioContext, context, canvas, chunks: [], drawTimer: 0, limitTimer: 0, discard: false };
        recorder.addEventListener("dataavailable", (event) => { if (event.data && event.data.size > 0) recording.chunks.push(event.data); });
        recorder.addEventListener("error", () => {
          if (activeLocalRecording === recording) activeLocalRecording = null;
          recording.discard = true;
          cleanupLocalRecording(recording);
          setRecordButtonState(false);
          announce(t("cam.record.stoppedUnexpectedly"), "error");
        }, { once: true });
        recorder.addEventListener("stop", () => {
          cleanupLocalRecording(recording);
          if (recording.discard) return;
          const type = recorder.mimeType || mimeType || "video/webm";
          const blob = new Blob(recording.chunks, { type });
          if (blob.size === 0) { announce(t("cam.record.empty"), "error"); return; }
          downloadBlob(blob, "recording", type.startsWith("video/mp4") ? "mp4" : "webm");
          announce(t("cam.record.saved"));
        }, { once: true });
        // Safari only emits canvas-capture frames when asked; draw on the paint clock and request a frame after every draw.
        const videoTrack = stream.getVideoTracks()[0];
        let lastDraw = 0;
        const draw = (now) => {
          if (activeLocalRecording !== recording) return;
          if (!lastDraw || now - lastDraw >= 120) {
            lastDraw = now || performance.now();
            try {
              context.drawImage(viewerImage, 0, 0, canvas.width, canvas.height);
              if (videoTrack && typeof videoTrack.requestFrame === "function") videoTrack.requestFrame();
            } catch { /* A reconnect can skip a frame. */ }
          }
          recording.drawTimer = window.requestAnimationFrame(draw);
        };
        activeLocalRecording = recording;
        draw(0);
        recorder.start(1000);
        recording.limitTimer = window.setTimeout(() => {
          if (activeLocalRecording !== recording) return;
          stopLocalRecording(false);
          announce(t("cam.record.limit"));
        }, 30 * 60 * 1000);
        setRecordButtonState(true);
        announce(t(audio ? "cam.record.withSound" : "cam.record.withoutSound"));
      } catch (error) {
        stopLocalRecording(true);
        announce(error instanceof Error ? error.message : t("cam.record.startFailed"), "error");
      } finally {
        recordButton.disabled = false;
      }
    };
    if (liveButton instanceof HTMLButtonElement) {
      liveButton.addEventListener("click", () => {
        if (liveViewActive()) {
          if (activeLocalRecording) stopLocalRecording(false);
          stopLiveView();
          return;
        }
        void setViewerImage("live");
      });
    }
    if (listenButton instanceof HTMLButtonElement && viewerAudio instanceof HTMLAudioElement) {
      const stopListening = () => {
        viewerAudio.pause();
        viewerAudio.removeAttribute("src");
        viewerAudio.load();
        listenButton.textContent = t("cam.listen");
        listenButton.setAttribute("aria-pressed", "false");
      };
      listenButton.addEventListener("click", async () => {
        if (!viewerAudio.paused) {
          stopListening();
          announce(t("cam.listen.stopped"));
          return;
        }
        if (!deviceId()) return;
        // Reflect the intended state before awaiting play(): a streaming MP3 fires benign load/abort transitions while the first bytes arrive.
        listenButton.textContent = t("action.stop");
        listenButton.setAttribute("aria-pressed", "true");
        setStatus(t("cam.listen.connecting"), "busy");
        viewerAudio.src = "/api/camera/devices/" + encodeURIComponent(deviceId()) + "/audio.mp3?t=" + Date.now();
        try {
          await viewerAudio.play();
          announce(t("cam.listen.listening"));
        } catch (error) {
          const aborted = error instanceof DOMException && error.name === "AbortError";
          if (aborted || !viewerAudio.paused) { announce(t("cam.listen.listening")); return; }
          stopListening();
          announce(t("cam.listen.unavailable"), "error");
        }
      });
      viewerAudio.addEventListener("error", () => {
        if (listenButton.getAttribute("aria-pressed") === "true") {
          stopListening();
          announce(t("cam.listen.disconnected"), "error");
        }
      });
    }
    if (snapshotButton instanceof HTMLButtonElement) snapshotButton.addEventListener("click", () => { void captureAndDownloadSnapshot(); });
    if (recordButton instanceof HTMLButtonElement) {
      setRecordButtonState(false);
      recordButton.addEventListener("click", () => {
        if (activeLocalRecording) stopLocalRecording(false);
        else void startLocalRecording();
      });
    }
    if (playbackStartButton instanceof HTMLButtonElement) {
      playbackStartButton.addEventListener("click", async () => {
        const timestamp = playbackTimestamp();
        if (!timestamp || !(viewerImage instanceof HTMLImageElement) || !requireDevice()) {
          announce(t("cam.playback.chooseTime"), "error");
          return;
        }
        stopLocalRecording(false);
        await stopPlayback(true, false);
        playbackActive = true;
        playbackPaused = false;
        setPlaybackButtons();
        viewerImage.hidden = false;
        viewerImage.src = "/api/camera/devices/" + encodeURIComponent(deviceId()) + "/playback.mjpeg?at=" + encodeURIComponent(timestamp) + "&t=" + Date.now();
        viewerImage.alt = t("cam.alt.recording", { name: deviceName() });
        if (viewerPlaceholder instanceof HTMLElement) viewerPlaceholder.hidden = true;
        setViewerMode(t("cam.mode.recording"));
        announce(t("cam.playback.opening"));
      });
    }
    if (playbackPauseButton instanceof HTMLButtonElement) {
      playbackPauseButton.addEventListener("click", async () => {
        if (!playbackActive) return;
        const nextPaused = !playbackPaused;
        playbackPauseButton.disabled = true;
        try {
          await post(playbackUrl(nextPaused ? "pause" : "resume"), {});
          playbackPaused = nextPaused;
          setPlaybackButtons();
          announce(t(nextPaused ? "cam.playback.paused" : "cam.playback.resumed"));
        } catch (error) {
          setPlaybackButtons();
          announce(error instanceof Error ? error.message : t("cam.playback.controlFailed"), "error");
        }
      });
    }
    if (playbackSeekButton instanceof HTMLButtonElement) {
      playbackSeekButton.addEventListener("click", async () => {
        const timestamp = playbackTimestamp();
        if (!playbackActive || !timestamp) return;
        playbackSeekButton.disabled = true;
        try {
          await post(playbackUrl("seek"), { timestamp });
          announce(t("cam.playback.seeking"));
        } catch (error) {
          announce(error instanceof Error ? error.message : t("cam.playback.seekFailed"), "error");
        } finally {
          setPlaybackButtons();
        }
      });
    }
    if (playbackStopButton instanceof HTMLButtonElement) playbackStopButton.addEventListener("click", () => { void stopPlayback(false, true); });
    if (viewerImage instanceof HTMLImageElement) {
      viewerImage.addEventListener("load", () => {
        window.clearTimeout(firstFrameTimer);
        if (playbackActive) announce(t("cam.playback.playing"));
        else if (viewerImage.src.includes("/stream.mjpeg")) setStatus(t("cam.live.playing"), "ok");
        else if (viewerImage.src.includes("/snapshot")) setStatus(t("cam.still.showing"), "ok");
      });
      viewerImage.addEventListener("error", () => {
        window.clearTimeout(firstFrameTimer);
        const wasPlayback = playbackActive;
        const wasLive = viewerImage.src.includes("/stream.mjpeg");
        if (wasPlayback) void stopPlayback(true, true);
        if (wasLive) {
          setLiveButtonState(false);
          setStatus(t("cam.live.failed"), "error");
        }
        viewerImage.hidden = true;
        setPlaceholder(t(wasPlayback ? "cam.playback.none" : "cam.live.unavailable"));
        if (wasPlayback) announce(t("cam.playback.none"), "error");
      });
    }

    const rebootButton = document.querySelector("#camera-reboot-button");
    if (rebootButton instanceof HTMLButtonElement) {
      rebootButton.addEventListener("click", async () => {
        if (!deviceId()) return;
        if (!window.confirm(t("cam.reboot.confirm", { name: deviceName() }))) return;
        rebootButton.disabled = true;
        setStatus(t("cam.reboot.working"), "busy");
        try {
          const payload = await post(api.reboot, { deviceId: deviceId() });
          announce((payload && typeof payload.message === "string" ? payload.message : t("cam.reboot.requested")) + " " + t("cam.reloading"));
          window.setTimeout(reloadState, 1200);
        } catch (error) {
          rebootButton.disabled = false;
          announce(error instanceof Error ? error.message : t("cam.reboot.failed"), "error");
        }
      });
    }

    const networkButton = document.querySelector("#network-mode-button");
    if (networkButton instanceof HTMLButtonElement) {
      networkButton.addEventListener("click", async () => {
        const action = networkButton.dataset.nextAction === "off" ? "off" : "on";
        const perDevice = Boolean(networkButton.dataset.isolationDevice);
        const question = perDevice
          ? t(action === "on" ? "cam.network.confirmIsolate" : "cam.network.confirmRelease")
          : t("cam.network.confirmSwitch", { target: t(action === "on" ? "cam.network.targetLocal" : "cam.network.targetCloud") });
        if (!window.confirm(question)) return;
        networkButton.disabled = true;
        setStatus(perDevice ? t(action === "on" ? "cam.network.isolating" : "cam.network.releasing") : t("cam.network.switching", { action }), "busy");
        try {
          const payload = await post(api.network, perDevice && requireDevice() ? { action, deviceId: deviceId() } : { action });
          announce((payload && typeof payload.message === "string" ? payload.message : t("cam.network.updated")) + " " + t("cam.reloading"));
          window.setTimeout(reloadState, 1200);
        } catch (error) {
          networkButton.disabled = false;
          announce(error instanceof Error ? error.message : t("cam.network.failed"), "error");
        }
      });
    }

    const reconnectButton = document.querySelector("#network-reconnect-button");
    if (reconnectButton instanceof HTMLButtonElement) {
      reconnectButton.addEventListener("click", async () => {
        if (!requireDevice()) return;
        reconnectButton.disabled = true;
        setStatus(t("cam.reconnect.working"), "busy");
        try {
          const payload = await post(api.reconnect, { deviceId: deviceId() });
          announce((payload && typeof payload.message === "string" ? payload.message : t("cam.reconnect.requested")) + " " + t("cam.reloading"));
          window.setTimeout(reloadState, 1200);
        } catch (error) {
          reconnectButton.disabled = false;
          announce(error instanceof Error ? error.message : t("cam.reconnect.failed"), "error");
        }
      });
    }

    const talkButtons = Array.from(document.querySelectorAll("[data-talk-button]")).filter((button) => button instanceof HTMLButtonElement);
    let activeTalk = null;
    let talkGeneration = 0;
    let talkChunks = [];
    let talkSending = false;
    const talkbackUrl = (action) => "/api/camera/devices/" + encodeURIComponent(deviceId()) + "/talkback/" + action;
    const setTalkButtonState = (state) => {
      talkButtons.forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) return;
        if (state) {
          button.dataset.active = "true";
          button.setAttribute("aria-pressed", "true");
          button.textContent = t(state === "ready" ? "cam.talk.stop" : "status.connecting");
          button.title = t(state === "ready" ? "cam.talk.stop" : "cam.talk.connecting");
        } else {
          delete button.dataset.active;
          button.setAttribute("aria-pressed", "false");
          button.textContent = t("cam.talk");
          button.title = t("cam.talk.title");
        }
      });
    };
    const cleanupTalkAudio = (talk) => {
      if (!talk) return;
      if (talk.processor) { talk.processor.onaudioprocess = null; try { talk.processor.disconnect(); } catch {} }
      if (talk.source) { try { talk.source.disconnect(); } catch {} }
      if (talk.silentGain) { try { talk.silentGain.disconnect(); } catch {} }
      if (talk.stream) talk.stream.getTracks().forEach((track) => track.stop());
      if (talk.context) void talk.context.close().catch(() => {});
    };
    const downsampleTo8k = (samples, sampleRate) => {
      if (!samples.length || !Number.isFinite(sampleRate) || sampleRate < 8000) return new Int16Array(0);
      const ratio = sampleRate / 8000;
      const length = Math.max(1, Math.floor(samples.length / ratio));
      const pcm = new Int16Array(length);
      for (let output = 0; output < length; output += 1) {
        const start = Math.floor(output * ratio);
        const end = Math.max(start + 1, Math.min(samples.length, Math.floor((output + 1) * ratio)));
        let sum = 0;
        for (let input = start; input < end; input += 1) sum += samples[input];
        const value = Math.max(-1, Math.min(1, sum / (end - start)));
        pcm[output] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
      }
      return pcm;
    };
    const pcmBytes = (pcm) => {
      const bytes = new Uint8Array(pcm.length * 2);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < pcm.length; index += 1) view.setInt16(index * 2, pcm[index], true);
      return bytes;
    };
    const sendTalkChunk = async (item) => {
      const response = await fetch(talkbackUrl("audio"), { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "accept": "application/json", "content-type": "application/octet-stream" }, body: item.bytes });
      if (response.ok) return;
      const payload = await response.json().catch(() => null);
      throw new Error(ht.errorOf(payload, t("cam.talk.rejected")));
    };
    const stopTalk = (reason, quiet) => {
      const talk = activeTalk;
      if (!talk) return;
      activeTalk = null;
      talkGeneration += 1;
      talkChunks = [];
      cleanupTalkAudio(talk);
      setTalkButtonState(null);
      void post(talkbackUrl("stop"), {}, { keepalive: reason === "pagehide" || reason === "page-hidden" })
        .catch((error) => { if (!quiet) announce(error instanceof Error ? error.message : t("cam.talk.closeFailed"), "error"); });
      if (!quiet) announce(t("cam.talk.stopped"));
    };
    const flushTalkChunks = async () => {
      if (talkSending) return;
      talkSending = true;
      try {
        while (talkChunks.length > 0) {
          const item = talkChunks.shift();
          if (!item || activeTalk !== item.talk) continue;
          try {
            await sendTalkChunk(item);
          } catch (error) {
            if (activeTalk === item.talk) {
              stopTalk("audio-error", true);
              announce(error instanceof Error ? error.message : t("cam.talk.disconnected"), "error");
            }
            break;
          }
        }
      } finally {
        talkSending = false;
        if (talkChunks.length > 0) void flushTalkChunks();
      }
    };
    const queueTalkChunk = (talk, pcm) => {
      if (activeTalk !== talk || pcm.length === 0 || talkChunks.length >= 4) return;
      talkChunks.push({ talk, bytes: pcmBytes(pcm) });
      void flushTalkChunks();
    };
    const startTalk = async (button) => {
      if (button.disabled || !requireDevice() || activeTalk) return;
      const generation = ++talkGeneration;
      const talk = { generation, stream: null, context: null, source: null, processor: null, silentGain: null };
      activeTalk = talk;
      setTalkButtonState("connecting");
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") throw new Error(t("cam.talk.noMic"));
        if (viewerAudio instanceof HTMLAudioElement && !viewerAudio.paused) {
          viewerAudio.pause();
          viewerAudio.removeAttribute("src");
          viewerAudio.load();
          if (listenButton instanceof HTMLButtonElement) {
            listenButton.textContent = t("cam.listen");
            listenButton.setAttribute("aria-pressed", "false");
          }
        }
        talk.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (activeTalk !== talk || generation !== talkGeneration) { cleanupTalkAudio(talk); return; }
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error(t("cam.talk.noAudio"));
        talk.context = new AudioContextClass({ latencyHint: "interactive" });
        await talk.context.resume();
        talk.source = talk.context.createMediaStreamSource(talk.stream);
        talk.processor = talk.context.createScriptProcessor(4096, 1, 1);
        talk.silentGain = talk.context.createGain();
        talk.silentGain.gain.value = 0;
        talk.source.connect(talk.processor);
        talk.processor.connect(talk.silentGain);
        talk.silentGain.connect(talk.context.destination);
        await post(talkbackUrl("start"), {});
        if (activeTalk !== talk || generation !== talkGeneration) {
          cleanupTalkAudio(talk);
          void post(talkbackUrl("stop"), {}, { keepalive: true }).catch(() => {});
          return;
        }
        talk.processor.onaudioprocess = (event) => {
          if (activeTalk !== talk || !talk.context) return;
          queueTalkChunk(talk, downsampleTo8k(event.inputBuffer.getChannelData(0), talk.context.sampleRate));
        };
        setTalkButtonState("ready");
        announce(t("cam.talk.live"));
      } catch (error) {
        if (activeTalk === talk) {
          activeTalk = null;
          talkGeneration += 1;
          cleanupTalkAudio(talk);
          setTalkButtonState(null);
          void post(talkbackUrl("stop"), {}, { keepalive: true }).catch(() => {});
          announce(error instanceof Error ? error.message : t("cam.talk.startFailed"), "error");
        }
      }
    };
    // Talkback is a toggle: one click opens the microphone, the next closes it.
    talkButtons.forEach((control) => {
      if (!(control instanceof HTMLButtonElement)) return;
      control.addEventListener("click", (event) => {
        event.preventDefault();
        if (activeTalk) { stopTalk("click", false); return; }
        void startTalk(control);
      });
    });

    document.querySelectorAll("[data-range-output]").forEach((output) => {
      const input = output.parentElement && output.parentElement.querySelector("input[type=range]");
      if (!(input instanceof HTMLInputElement)) return;
      input.addEventListener("input", () => { output.textContent = input.value + (input.dataset.unit || ""); });
    });

    document.addEventListener("change", async (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement) || !input.matches("[data-control-input]")) return;
      const capabilityId = input.dataset.capabilityId;
      if (!capabilityId) return;
      const previous = input.dataset.currentValue || "";
      const value = input.dataset.valueKind === "boolean" && input instanceof HTMLInputElement ? input.checked
        : input.dataset.valueKind === "number" ? Number(input.value)
        : input.value;
      const restorePrevious = () => {
        if (input.dataset.valueKind === "boolean" && input instanceof HTMLInputElement) input.checked = previous === "true";
        else input.value = previous;
        if (input instanceof HTMLInputElement && input.type === "range") {
          const output = input.parentElement && input.parentElement.querySelector("[data-range-output]");
          if (output) output.textContent = input.value + (input.dataset.unit || "");
        }
      };
      input.disabled = true;
      try {
        const needsConfirmation = input.dataset.confirmation === "confirm";
        const confirmationMessage = capabilityId === "onvif.enabled" && value === true ? t("cam.confirmOnvif", { name: deviceName() }) : t("cam.confirmChange", { name: deviceName() });
        if (needsConfirmation && !window.confirm(confirmationMessage)) { restorePrevious(); return; }
        await sendControl(capabilityId, value, needsConfirmation, false);
        input.dataset.currentValue = String(value);
        if (capabilityId === "onvif.enabled" && value === true) {
          announce(t("cam.onvifEnabled"));
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          await post(api.discover, {});
          window.setTimeout(reloadState, 250);
        }
      } catch {
        restorePrevious();
      } finally {
        input.disabled = input.dataset.baseDisabled === "true";
      }
    });

    const dangerUnlocked = () => {
      const unlock = document.querySelector("#safety-unlock");
      return unlock instanceof HTMLInputElement && unlock.checked;
    };
    const safetyUnlock = document.querySelector("#safety-unlock");
    if (safetyUnlock instanceof HTMLInputElement) {
      safetyUnlock.addEventListener("change", () => {
        document.querySelectorAll("[data-dangerous=true]").forEach((control) => {
          if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
            control.disabled = control.dataset.baseDisabled === "true" || !safetyUnlock.checked;
          }
        });
      });
    }
    const confirmAction = (control) => {
      const mode = control.dataset.confirmation || "none";
      if (control.dataset.dangerous === "true" && !dangerUnlocked()) {
        announce(t("cam.unlockFirst"), "error");
        return false;
      }
      if (mode === "type-device-name") return window.prompt(t("cam.typeName", { name: deviceName() })) === deviceName();
      return mode !== "confirm" || window.confirm(t("cam.confirmAction", { action: control.textContent.trim(), name: deviceName() }));
    };
    const releaseButton = (button) => { button.disabled = button.dataset.baseDisabled === "true" || (button.dataset.dangerous === "true" && !dangerUnlocked()); };
    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("[data-control-button]");
      if (!(button instanceof HTMLButtonElement)) return;
      if (!confirmAction(button)) return;
      const capabilityId = button.dataset.capabilityId;
      if (!capabilityId) return;
      button.disabled = true;
      try {
        await sendControl(capabilityId, true, button.dataset.confirmation !== "none", false);
        if (capabilityId === "device.wake") {
          announce(t("cam.wake.sent"));
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          try {
            await post(api.discover, {});
            reloadState();
          } catch (error) {
            announce(error instanceof Error ? error.message : t("cam.wake.notOnline"), "error");
          }
        }
      }
      catch { /* Announced by sendControl. */ }
      finally { releaseButton(button); }
    });

    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("[data-json-button]");
      if (!(button instanceof HTMLButtonElement) || !confirmAction(button)) return;
      const card = button.closest("[data-capability-card]");
      const editor = card && card.querySelector("[data-json-input]");
      if (!(editor instanceof HTMLTextAreaElement)) return;
      let value;
      try { value = JSON.parse(editor.value); }
      catch {
        announce(t("cam.invalidJson"), "error");
        editor.focus();
        return;
      }
      button.disabled = true;
      try { await sendControl(button.dataset.capabilityId, value, button.dataset.confirmation !== "none", false); }
      catch { /* Announced by sendControl. */ }
      finally { releaseButton(button); }
    });

    // The dispenser only reliably delivers one portion per command; every press dispenses exactly one treat.
    const dispenseTreat = async (button) => {
      button.disabled = true;
      setStatus(t("cam.treat.dispensing"), "busy");
      try { await sendControl(button.dataset.capabilityId || "feed.portions", 1, true, false); }
      catch { /* Announced by sendControl. */ }
      finally { button.disabled = button.dataset.baseDisabled === "true"; }
    };
    document.querySelectorAll("[data-treat-button]").forEach((control) => {
      if (control instanceof HTMLButtonElement) control.addEventListener("click", () => { void dispenseTreat(control); });
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const add = target.closest("[data-schedule-add]");
      if (!(add instanceof HTMLButtonElement)) return;
      const schedule = add.closest("[data-schedule-mode]");
      const list = schedule && schedule.querySelector("[data-schedule-list]");
      const template = schedule && schedule.querySelector("[data-schedule-template]");
      if (!(schedule instanceof HTMLElement) || !(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) return;
      if (list.querySelectorAll("[data-schedule-entry]").length >= Number(schedule.dataset.scheduleMax || "10")) {
        announce(t("cam.schedule.max"), "error");
        return;
      }
      list.append(template.content.cloneNode(true));
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const remove = target.closest("[data-schedule-remove]");
      if (remove instanceof HTMLButtonElement) remove.closest("[data-schedule-entry]")?.remove();
    });
    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const save = target.closest("[data-schedule-button]");
      if (!(save instanceof HTMLButtonElement)) return;
      const schedule = save.closest("[data-schedule-mode]");
      if (!(schedule instanceof HTMLElement)) return;
      const scheduleMode = schedule.dataset.scheduleMode;
      const entries = Array.from(schedule.querySelectorAll("[data-schedule-entry]")).map((row) => {
        const checkbox = (selector) => { const input = row.querySelector(selector); return input instanceof HTMLInputElement && input.checked; };
        const text = (selector) => { const input = row.querySelector(selector); return input instanceof HTMLInputElement ? input.value : ""; };
        const days = Array.from(row.querySelectorAll("[data-schedule-day]:checked")).map((item) => item.value);
        const entry = { enabled: scheduleMode === "deployment-intervals" ? true : checkbox("[data-schedule-enabled]") };
        if (scheduleMode === "weekly-intervals" || scheduleMode === "deployment-intervals" || scheduleMode === "daily-window") {
          entry.startTime = text("[data-schedule-start]");
          entry.endTime = text("[data-schedule-end]");
          if (scheduleMode === "weekly-intervals") entry.days = days;
        } else {
          entry.time = text("[data-schedule-time]");
          if (scheduleMode === "feed-times" || scheduleMode === "tease-times") {
            entry.once = checkbox("[data-schedule-once]");
            entry.days = days;
            entry.sound = checkbox("[data-schedule-sound]");
          }
          if (scheduleMode === "feed-times") entry.portions = Number(text("[data-schedule-portions]"));
          if (scheduleMode === "tease-times") {
            entry.mode = Number(text("[data-schedule-mode-value]"));
            entry.auto = checkbox("[data-schedule-auto]");
          }
        }
        return entry;
      });
      save.disabled = true;
      try { await sendControl(save.dataset.capabilityId || "feed.schedule", entries, false, false); }
      catch { /* Announced by sendControl. */ }
      finally { save.disabled = save.dataset.baseDisabled === "true"; }
    });

    const updateRegionCount = (region) => {
      const output = region.querySelector("[data-region-count]");
      if (output instanceof HTMLOutputElement) output.value = String(region.querySelectorAll('[data-region-cell][aria-pressed="true"]').length);
    };
    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const cell = target.closest("[data-region-cell]");
      const fill = target.closest("[data-region-fill]");
      const clear = target.closest("[data-region-clear]");
      const save = target.closest("[data-region-save]");
      const control = cell || fill || clear || save;
      if (!(control instanceof HTMLButtonElement)) return;
      const region = control.closest("[data-region-control]");
      if (!(region instanceof HTMLElement)) return;
      if (cell instanceof HTMLButtonElement) {
        cell.setAttribute("aria-pressed", cell.getAttribute("aria-pressed") === "true" ? "false" : "true");
        updateRegionCount(region);
        return;
      }
      if (fill instanceof HTMLButtonElement || clear instanceof HTMLButtonElement) {
        region.querySelectorAll("[data-region-cell]").forEach((item) => item.setAttribute("aria-pressed", fill ? "true" : "false"));
        updateRegionCount(region);
        return;
      }
      if (!(save instanceof HTMLButtonElement)) return;
      const selectedCells = Array.from(region.querySelectorAll('[data-region-cell][aria-pressed="true"]')).map((item) => Number(item.getAttribute("data-region-cell")));
      save.disabled = true;
      try { await sendControl(save.dataset.capabilityId, { selectedCells }, false, false); }
      catch { /* Announced by sendControl. */ }
      finally { save.disabled = save.dataset.baseDisabled === "true"; }
    });

    const polygonGroups = (editor) => Array.from(editor.querySelectorAll("[data-polygon]"));
    const updatePolygonShape = (group) => {
      const shape = group.querySelector("[data-polygon-shape]");
      if (!(shape instanceof SVGPolygonElement)) return;
      shape.setAttribute("points", Array.from(group.querySelectorAll("[data-polygon-point]")).map((point) => point.getAttribute("cx") + "," + point.getAttribute("cy")).join(" "));
    };
    const pointValueText = (point, x, y) => point.setAttribute("aria-valuetext", t("cam.area.valuetext", { x, y }));
    const refreshPolygonUi = (editor) => {
      const groups = polygonGroups(editor);
      const maximum = Number(editor.dataset.polygonMax || "6");
      const count = editor.querySelector("[data-polygon-count]");
      if (count instanceof HTMLOutputElement) count.value = String(groups.length);
      const selected = groups.find((group) => group.getAttribute("data-polygon-selected") === "true");
      const label = editor.querySelector("[data-polygon-selected-label]");
      if (label) label.textContent = selected ? t("cam.area.selected", { area: groups.indexOf(selected) + 1 }) : t("cam.area.none");
      const add = editor.querySelector("[data-polygon-add]");
      const remove = editor.querySelector("[data-polygon-remove]");
      if (add instanceof HTMLButtonElement) add.disabled = add.dataset.baseDisabled === "true" || groups.length >= maximum;
      if (remove instanceof HTMLButtonElement) remove.disabled = remove.dataset.baseDisabled === "true" || !selected;
      groups.forEach((group, groupIndex) => {
        group.setAttribute("data-polygon", String(groupIndex));
        group.querySelectorAll("[data-polygon-point]").forEach((point, pointIndex) => point.setAttribute("aria-label", t("cam.area.point", { area: groupIndex + 1, point: pointIndex + 1 })));
      });
    };
    const selectPolygon = (editor, selected) => {
      polygonGroups(editor).forEach((group) => group.setAttribute("data-polygon-selected", group === selected ? "true" : "false"));
      refreshPolygonUi(editor);
    };
    const appendPolygon = (editor) => {
      const canvas = editor.querySelector("[data-polygon-canvas]");
      if (!(canvas instanceof SVGSVGElement)) return;
      const groups = polygonGroups(editor);
      if (groups.length >= Number(editor.dataset.polygonMax || "6")) return;
      const namespace = "http://www.w3.org/2000/svg";
      const group = document.createElementNS(namespace, "g");
      group.setAttribute("data-polygon", String(groups.length));
      group.setAttribute("data-polygon-type", "1");
      group.setAttribute("data-polygon-v-id", "");
      group.setAttribute("data-polygon-ai-types", "[]");
      const shape = document.createElementNS(namespace, "polygon");
      shape.setAttribute("class", "polygon-shape");
      shape.setAttribute("data-polygon-shape", "");
      group.append(shape);
      [[40,40],[50,40],[60,40],[60,50],[60,60],[50,60],[40,60],[40,50]].forEach(([x, y], pointIndex) => {
        const point = document.createElementNS(namespace, "circle");
        point.setAttribute("class", "polygon-point");
        point.setAttribute("cx", String(x));
        point.setAttribute("cy", String(y));
        point.setAttribute("r", "2.4");
        point.setAttribute("tabindex", "0");
        point.setAttribute("role", "slider");
        point.setAttribute("data-polygon-point", String(pointIndex));
        pointValueText(point, x, y);
        group.append(point);
      });
      canvas.append(group);
      updatePolygonShape(group);
      selectPolygon(editor, group);
    };
    document.querySelectorAll("[data-polygon-control]").forEach((editor) => { if (editor instanceof HTMLElement) refreshPolygonUi(editor); });

    let activePolygonDrag = null;
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const point = target.closest("[data-polygon-point]");
      if (!(point instanceof SVGCircleElement) || (event.button !== 0 && event.pointerType === "mouse")) return;
      const editor = point.closest("[data-polygon-control]");
      const group = point.closest("[data-polygon]");
      const canvas = point.closest("[data-polygon-canvas]");
      if (!(editor instanceof HTMLElement) || !(group instanceof SVGGElement) || !(canvas instanceof SVGSVGElement)) return;
      selectPolygon(editor, group);
      point.setPointerCapture(event.pointerId);
      activePolygonDrag = { point, group, canvas, pointerId: event.pointerId };
      event.preventDefault();
    });
    document.addEventListener("pointermove", (event) => {
      if (!activePolygonDrag || activePolygonDrag.pointerId !== event.pointerId) return;
      const bounds = activePolygonDrag.canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = Math.max(0, Math.min(100, Math.round(((event.clientX - bounds.left) / bounds.width) * 100)));
      const y = Math.max(0, Math.min(100, Math.round(((event.clientY - bounds.top) / bounds.height) * 100)));
      activePolygonDrag.point.setAttribute("cx", String(x));
      activePolygonDrag.point.setAttribute("cy", String(y));
      pointValueText(activePolygonDrag.point, x, y);
      updatePolygonShape(activePolygonDrag.group);
      event.preventDefault();
    });
    const finishPolygonDrag = (event) => { if (activePolygonDrag && activePolygonDrag.pointerId === event.pointerId) activePolygonDrag = null; };
    document.addEventListener("pointerup", finishPolygonDrag);
    document.addEventListener("pointercancel", finishPolygonDrag);
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (!(target instanceof SVGCircleElement) || !target.matches("[data-polygon-point]")) return;
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta) return;
      const x = Math.max(0, Math.min(100, Number(target.getAttribute("cx")) + delta[0]));
      const y = Math.max(0, Math.min(100, Number(target.getAttribute("cy")) + delta[1]));
      target.setAttribute("cx", String(x));
      target.setAttribute("cy", String(y));
      pointValueText(target, x, y);
      const group = target.closest("[data-polygon]");
      if (group) updatePolygonShape(group);
      event.preventDefault();
    });
    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const editor = target.closest("[data-polygon-control]");
      if (!(editor instanceof HTMLElement)) return;
      const group = target.closest("[data-polygon]");
      if (group instanceof SVGGElement && !target.closest("[data-polygon-add],[data-polygon-remove],[data-polygon-save]")) selectPolygon(editor, group);
      if (target.closest("[data-polygon-add]") instanceof HTMLButtonElement) { appendPolygon(editor); return; }
      if (target.closest("[data-polygon-remove]") instanceof HTMLButtonElement) {
        const selected = polygonGroups(editor).find((item) => item.getAttribute("data-polygon-selected") === "true");
        selected?.remove();
        const remaining = polygonGroups(editor);
        if (remaining[0]) selectPolygon(editor, remaining[0]); else refreshPolygonUi(editor);
        return;
      }
      const save = target.closest("[data-polygon-save]");
      if (!(save instanceof HTMLButtonElement)) return;
      const polygons = polygonGroups(editor).map((item) => {
        const polygon = {
          type: Number(item.getAttribute("data-polygon-type") || "1"),
          points: Array.from(item.querySelectorAll("[data-polygon-point]")).map((point) => ({ x: Number(point.getAttribute("cx")), y: Number(point.getAttribute("cy")) })),
        };
        const vId = item.getAttribute("data-polygon-v-id");
        if (vId) polygon.vId = Number(vId);
        try {
          const aiTypes = JSON.parse(item.getAttribute("data-polygon-ai-types") || "[]");
          if (Array.isArray(aiTypes) && aiTypes.length) polygon.aiTypes = aiTypes;
        } catch { /* Keep no malformed metadata. */ }
        return polygon;
      });
      save.disabled = true;
      try { await sendControl(save.dataset.capabilityId, { polygons }, false, false); }
      catch { /* Announced by sendControl. */ }
      finally { save.disabled = save.dataset.baseDisabled === "true"; }
    });

    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const recall = target.closest("[data-preset-recall]");
      const save = target.closest("[data-preset-save]");
      const remove = target.closest("[data-preset-delete]");
      const button = recall || save || remove;
      if (!(button instanceof HTMLButtonElement)) return;
      const card = button.closest("[data-capability-card]");
      const capabilityId = button.dataset.capabilityId || "camera.presets";
      let value;
      if (recall instanceof HTMLButtonElement) value = { action: "recall", presetId: recall.dataset.presetRecall };
      else if (remove instanceof HTMLButtonElement) value = { action: "delete", presetId: remove.dataset.presetDelete };
      else {
        const name = card && card.querySelector("[data-preset-name]");
        if (!(name instanceof HTMLInputElement) || !name.value.trim()) { announce(t("cam.preset.nameFirst"), "error"); return; }
        value = { action: "save", name: name.value.trim() };
      }
      let confirmed = button.dataset.confirmation !== "none";
      if (remove instanceof HTMLButtonElement) {
        if (!window.confirm(t("cam.preset.confirmDelete", { label: remove.dataset.presetLabel || "" }))) return;
        confirmed = true;
      } else if (!confirmAction(button)) return;
      button.disabled = true;
      try {
        await sendControl(capabilityId, value, confirmed, false);
        if (save instanceof HTMLButtonElement || remove instanceof HTMLButtonElement) {
          try {
            await post(api.discover, {});
            reloadState();
          } catch (error) {
            announce(error instanceof Error ? error.message : t("cam.preset.refreshFailed"), "error");
          }
        }
      }
      catch { /* Announced by sendControl. */ }
      finally { button.disabled = button.dataset.baseDisabled === "true"; }
    });

    let activePtz = null;
    const ptzRequest = (body, keepalive) => fetch(api.ptz, { method: "POST", credentials: "same-origin", cache: "no-store", keepalive: Boolean(keepalive), headers: { "accept": "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    const issuePtzLease = () => {
      if (!activePtz) return;
      const current = activePtz;
      void ptzRequest({ deviceId: deviceId(), action: "start", direction: current.direction, leaseMs: 3000, commandId: commandId() }, false)
        .then((response) => { if (!response.ok) throw new Error(t("cam.ptz.rejected")); })
        .catch((error) => { announce(error instanceof Error ? error.message : t("cam.ptz.failed"), "error"); stopPtz("request-error"); });
    };
    const startPtz = (button, pointerId) => {
      if (!requireDevice() || button.disabled) return;
      if (activePtz) stopPtz("new-direction");
      activePtz = { button, pointerId, direction: button.dataset.ptzDirection, timer: 0 };
      button.dataset.active = "true";
      issuePtzLease();
      activePtz.timer = window.setInterval(issuePtzLease, 2200);
    };
    function stopPtz(reason) {
      if (!activePtz) return;
      const previous = activePtz;
      activePtz = null;
      window.clearInterval(previous.timer);
      delete previous.button.dataset.active;
      void ptzRequest({ deviceId: deviceId(), action: "stop", commandId: commandId(), reason }, true).catch(() => {});
    }
    const holdControl = (control, start, stop) => {
      control.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        try { control.setPointerCapture(event.pointerId); } catch { /* Capture is an enhancement. */ }
        start(control, event.pointerId);
      });
      control.addEventListener("pointerup", (event) => stop("pointerup", event.pointerId));
      control.addEventListener("pointercancel", (event) => stop("pointercancel", event.pointerId));
      control.addEventListener("lostpointercapture", () => stop("lostpointercapture"));
      control.addEventListener("keydown", (event) => { if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); start(control, -1); } });
      control.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") stop("keyup"); });
      control.addEventListener("click", (event) => event.preventDefault());
      control.addEventListener("blur", () => stop("blur"));
    };
    document.querySelectorAll("[data-ptz-direction]").forEach((control) => {
      if (!(control instanceof HTMLButtonElement)) return;
      holdControl(control, startPtz, (reason, pointerId) => { if (pointerId === undefined || (activePtz && activePtz.pointerId === pointerId)) stopPtz(reason); });
    });

    let activeMomentary = null;
    const startMomentary = (button, pointerId) => {
      if (button.disabled || !requireDevice()) return;
      if (activeMomentary) stopMomentary("new-control");
      activeMomentary = { button, pointerId };
      button.dataset.active = "true";
      void sendControl(button.dataset.capabilityId, true, false, true).catch(() => { stopMomentary("request-error"); });
    };
    function stopMomentary() {
      if (!activeMomentary) return;
      const previous = activeMomentary;
      activeMomentary = null;
      delete previous.button.dataset.active;
      void post(api.control, { deviceId: deviceId(), capabilityId: previous.button.dataset.capabilityId, value: false, confirmed: false }, { keepalive: true }).catch(() => {});
    }
    document.querySelectorAll("[data-momentary-button]").forEach((control) => {
      if (!(control instanceof HTMLButtonElement)) return;
      holdControl(control, startMomentary, (reason, pointerId) => { if (pointerId === undefined || (activeMomentary && activeMomentary.pointerId === pointerId)) stopMomentary(reason); });
    });

    const stopHeldControls = (reason) => { stopPtz(reason); stopMomentary(reason); };
    document.addEventListener("pointerup", () => stopHeldControls("document-pointerup"), true);
    document.addEventListener("pointercancel", () => stopHeldControls("document-pointercancel"), true);
    window.addEventListener("blur", () => stopHeldControls("window-blur"));
    window.addEventListener("pagehide", () => {
      stopHeldControls("pagehide");
      stopTalk("pagehide", true);
      stopLocalRecording(true);
      if (playbackActive && deviceId()) {
        playbackActive = false;
        void post(playbackUrl("stop"), {}, { keepalive: true }).catch(() => {});
      }
    });
    // Live video and recording playback are connections held open; a background tab must not
    // keep one of the browser's six connections to this host. Live video comes back when the
    // tab is shown; playback is a server session at a position, so it stops. Audio keeps
    // playing: listening to a camera from another tab is the point of it.
    let resumeLiveView = false;
    const releaseVideo = () => {
      if (liveViewActive()) {
        resumeLiveView = true;
        window.clearTimeout(firstFrameTimer);
        viewerImage.removeAttribute("src");
      }
      if (playbackActive) void stopPlayback(true, true);
    };
    const restoreVideo = () => {
      if (!resumeLiveView || document.hidden) return;
      resumeLiveView = false;
      void setViewerImage("live");
    };
    window.addEventListener("pagehide", releaseVideo);
    window.addEventListener("pageshow", restoreVideo);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { restoreVideo(); return; }
      stopHeldControls("page-hidden");
      stopTalk("page-hidden", true);
      releaseVideo();
    });

    const refreshButton = document.querySelector("#refresh-state-button");
    if (refreshButton instanceof HTMLButtonElement) {
      refreshButton.addEventListener("click", async () => {
        refreshButton.disabled = true;
        try {
          await ht.request(api.state + (deviceId() ? "?deviceId=" + encodeURIComponent(deviceId()) : ""));
          reloadState();
        } catch (error) {
          announce(error instanceof Error ? error.message : t("cam.refresh.failed"), "error");
          refreshButton.disabled = false;
        }
      });
    }
  })();
`;

export function renderCameraDashboardPage({ ctx, model, device }: CameraDashboardPageOptions): string {
  const { t } = ctx.i18n;
  const selectedDevice = model.devices.find((candidate) => candidate.id === model.selectedDeviceId) ?? model.devices[0];
  const capabilities = mergeCapabilities(selectedDevice);
  const treatCapability = capabilities.find((capability) => capability.kind === "treat");
  const ptzCapability = capabilities.find((capability) => capability.kind === "ptz");
  const talkCapability = capabilities.find((capability) => capability.id === "audio.talk");
  const playbackCapability = capabilities.find((capability) => capability.id === "storage.playback");
  const selectedId = selectedDevice?.id ?? "";
  const selectedName = selectedDevice?.name ?? t("cam.noneSelected");
  const online = selectedDevice?.status === "online";
  const streamAvailable = online && selectedDevice.stream === "available";
  const snapshotAvailable = online && selectedDevice.snapshot === "available";
  const playbackAvailable = online && playbackCapability?.availability === "available";
  const streamUrl = selectedDevice ? `/api/camera/devices/${encodeURIComponent(selectedDevice.id)}/stream.mjpeg` : "";
  const modelText = [selectedDevice?.model, selectedDevice?.firmware ? t("camera.firmware", { version: selectedDevice.firmware }) : undefined].filter(Boolean).join(" · ");
  const statusBase = statusLineBase(ctx, selectedDevice, model.network);
  const problems = statusProblems(selectedDevice, model.network);
  const viewerMessage = !selectedDevice
    ? t("cam.viewer.discover")
    : selectedDevice.status !== "online"
      ? t("cam.viewer.offline")
      : selectedDevice.stream === "unavailable"
        ? t("cam.viewer.noStream")
        : t("cam.viewer.unconfirmed");
  const talkAvailable = talkCapability?.availability === "available";
  const ptzAvailable = ptzCapability?.availability === "available";
  const treatAvailable = treatCapability?.availability === "available";
  const holdCommon = (capability: CameraCapabilityDescriptor | undefined, fallback: string, available: boolean) =>
    ` data-capability-id="${escapeHtml(capability?.id ?? fallback)}" data-base-disabled="${available ? "false" : "true"}" data-confirmation="none"${available ? "" : " disabled"}`;
  const title = device?.name ?? selectedName;

  const body = `${device ? renderDeviceHead(ctx, device, "controls") : `<h1>${escapeHtml(title)}</h1>`}
      <div class="statusline" id="status-bar" role="status" aria-live="polite" aria-atomic="true" data-kind="${streamAvailable ? "ok" : online ? "info" : selectedDevice?.status === "offline" ? "error" : "warn"}">
        <span class="mark" data-availability="${selectedDevice?.status ?? "unknown"}" aria-hidden="true"></span>
        <span id="status-bar-text" data-base="${escapeHtml(statusBase)}">${escapeHtml(`${statusBase} · ${streamAvailable ? t("cam.live.playing") : viewerMessage}`)}</span>
        ${renderNetworkToggle(ctx, model.network)}
        ${renderReconnectButton(ctx, selectedDevice, model.network)}
        ${renderRebootButton(ctx, selectedDevice)}
        <button type="button" class="btn btn-small" id="refresh-state-button">${escapeHtml(t("action.refresh"))}</button>
      </div>
      ${problems.length > 0 ? `<ul class="problems" id="problems">${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>` : ""}
      <div class="workspace">
        <section class="viewer" aria-labelledby="viewer-title">
          <div class="stage stage-frame" data-stream-state="${selectedDevice?.stream ?? "unknown"}">
            <span class="live-pill" id="viewer-mode-pill"${streamAvailable ? "" : " hidden"}>${escapeHtml(t("camera.live"))}</span>
            <img id="viewer-image"${streamAvailable ? ` src="${streamUrl}" alt="${escapeHtml(t("cam.alt.live", { name: selectedName }))}"` : ' alt="" hidden'}>
            <audio id="viewer-audio" preload="none"></audio>
            <div class="placeholder" id="viewer-placeholder"${streamAvailable ? " hidden" : ""}>
              <h2 id="viewer-title">${escapeHtml(selectedName)}</h2>
              <p></p>
            </div>
          </div>
          <div class="icon-bar" role="toolbar" aria-label="${escapeHtml(t("cam.actions"))}">
            <button type="button" class="btn btn-icon" id="live-button" data-icon="${streamAvailable ? "pause" : "play"}" aria-pressed="${streamAvailable ? "true" : "false"}" title="${escapeHtml(t(streamAvailable ? "cam.live.pause" : "cam.live.play"))}"${online && selectedDevice.stream !== "unavailable" ? "" : " disabled"}>${escapeHtml(t(streamAvailable ? "action.pause" : "camera.live"))}</button>
            <button type="button" class="btn btn-icon" id="snapshot-button" data-icon="camera" title="${escapeHtml(t("cam.snapshot.title"))}"${snapshotAvailable ? "" : " disabled"}>${escapeHtml(t("camera.snapshot"))}</button>
            <button type="button" class="btn btn-icon" id="record-button" data-icon="record" aria-pressed="false" title="${escapeHtml(t("cam.record.title"))}"${streamAvailable ? "" : " disabled"}>${escapeHtml(t("cam.record"))}</button>
            <button type="button" class="btn btn-icon" id="listen-button" data-icon="speaker" aria-pressed="false" title="${escapeHtml(t("cam.listen.title"))}"${streamAvailable ? "" : " disabled"}>${escapeHtml(t("cam.listen"))}</button>
            <button type="button" class="btn btn-icon" id="talk-button" data-icon="mic" data-talk-button data-capability-id="audio.talk" data-base-disabled="${talkAvailable ? "false" : "true"}" aria-pressed="false" title="${escapeHtml(t("cam.talk.title"))}"${talkAvailable ? "" : " disabled"}>${escapeHtml(t("cam.talk"))}</button>
            <span class="icon-bar-gap" aria-hidden="true"></span>
            <span class="ptz" role="group" aria-label="${escapeHtml(t("cam.ptz.label"))}">
              <button type="button" class="btn btn-icon" data-icon="left" data-ptz-direction="left"${holdCommon(ptzCapability, "camera.ptz", ptzAvailable)} title="${escapeHtml(t("cam.ptz.left"))}" aria-label="${escapeHtml(t("cam.ptz.left"))}">${escapeHtml(t("cam.ptz.left"))}</button>
              <button type="button" class="btn btn-icon" data-icon="right" data-ptz-direction="right"${holdCommon(ptzCapability, "camera.ptz", ptzAvailable)} title="${escapeHtml(t("cam.ptz.right"))}" aria-label="${escapeHtml(t("cam.ptz.right"))}">${escapeHtml(t("cam.ptz.right"))}</button>
            </span>
            <span class="icon-bar-gap" aria-hidden="true"></span>
            <button type="button" class="btn btn-icon btn-primary" data-icon="treat" data-treat-button${holdCommon(treatCapability, "feed.portions", treatAvailable)} title="${escapeHtml(t("cam.treat.dispense"))}" aria-label="${escapeHtml(t("cam.treat.dispense"))}">${escapeHtml(t("cam.treat.dispense"))}</button>
          </div>
          <div class="playback" aria-label="${escapeHtml(t("cam.playback.title"))}">
            <label class="field"><span>${escapeHtml(t("cam.playback.time"))}</span><input id="playback-time" type="datetime-local" step="1"${playbackAvailable ? "" : " disabled"}></label>
            <div class="bar">
              <button type="button" class="btn" id="playback-start-button"${playbackAvailable ? "" : " disabled"}>${escapeHtml(t("cam.playback.play"))}</button>
              <button type="button" class="btn" id="playback-seek-button" disabled>${escapeHtml(t("cam.playback.seek"))}</button>
              <button type="button" class="btn" id="playback-pause-button" disabled>${escapeHtml(t("action.pause"))}</button>
              <button type="button" class="btn" id="playback-stop-button" disabled>${escapeHtml(t("action.stop"))}</button>
            </div>
          </div>
          ${modelText ? `<p class="viewer-meta">${escapeHtml(modelText)}</p>` : ""}
        </section>
        <section class="controls">
          ${model.eventLog ? `<div class="tabs controls-tabs" role="tablist" aria-label="${escapeHtml(t("device.tabs.controls"))}">
            <button type="button" id="tab-controls" role="tab" aria-selected="true" aria-controls="panel-controls">${escapeHtml(t("device.tabs.controls"))}</button>
            <button type="button" id="tab-events" role="tab" aria-selected="false" aria-controls="panel-events">${escapeHtml(t("services.events"))}</button>
          </div>` : ""}
          <div id="panel-controls" role="${model.eventLog ? "tabpanel" : "presentation"}" aria-labelledby="tab-controls">
            ${model.devices.length === 0 ? renderSetup(ctx, model) : ""}
            ${renderDeviceControls(ctx, capabilities)}
          </div>
          ${model.eventLog ? renderEventPanel(ctx, model.eventLog) : ""}
        </section>
      </div>
      ${model.devices.length > 0 ? `<details class="onboarding"><summary>${escapeHtml(t("cam.setup.summary"))}</summary>${renderSetup(ctx, model)}</details>` : ""}`;

  return renderPage({
    ctx,
    title,
    nav: "devices",
    wide: true,
    css: DASHBOARD_CSS,
    mainAttributes: `data-camera-dashboard data-device-id="${escapeHtml(selectedId)}" data-device-name="${escapeHtml(selectedName)}" data-api="${escapeHtml(JSON.stringify(CAMERA_DASHBOARD_API))}"`,
    body,
    script: DASHBOARD_SCRIPT + (model.eventLog ? TAB_SCRIPT + EVENT_LOG_SCRIPT : ""),
    messages: ["cam.", "camera.", "isolation.", "device.", ...EVENT_LOG_MESSAGES],
  });
}
