import { healthRoutes } from "./health-routes";
import { pageCatalog } from "./page-catalog";
import { postControlNames, readControlPath } from "../control-routes";
import { renderTagEditor } from "../ui/tag-editor";
import { renderElementApi, renderElementApiTabs, ELEMENT_API_CSS, ELEMENT_API_SCRIPT } from "../ui/element-api";
import { buildElementApi, elementForPage } from "../element-api/contract";
import { clientRoutes } from "../client/routes";
import { inventoryFor } from "../client/inventory";
import type { GraphStore } from "../graph/store";
import { elementApiRoutes } from "../element-api/routes";
import { renderCooktopPage } from "../ui/cooktop-page";
import { TagStore, TagError } from "../tags/store";
import { migrateRoomsToTags } from "../tags/room-migration";
import { ROOM } from "../tags/model";
import { tagRoutes } from "./tag-routes";
import { renderStringLightPage } from "../ui/string-light-page";
import { GoveeLanError } from "../protocols/govee/lan";
import { isIPv4 } from "node:net";
import { renderSensorPage } from "../ui/sensor-page";
import { renderRadioReceiverPage } from "../ui/radio-receiver-page";
import { kindleRoutes } from "./kindle-routes";
import { MemoryKindleConfigStore, type KindleConfigStore } from "../kindle/store";
import { AqaraHubM2 } from "../devices/hubs/aqara-hub-m2";
import { AqaraPresenceSensorFP2 } from "../devices/sensors/aqara-presence-sensor-fp2";
import { AqaraDoorWindowSensor } from "../devices/sensors/aqara-door-window-sensor";
import { AqaraConnection } from "../vendors/aqara/connection";
import { discoverContactSensors } from "../vendors/aqara/sensors";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requestId } from "hono/request-id";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { CameraMediaError, captureCameraSnapshot, createMjpegStreamResponse } from "../camera-media";
import type { Camera } from "../models/camera";
import { setCookie } from "hono/cookie";
import { checkedJson, errorJson, isAllowedChangeOrigin, pageContext, requestJson, uiPreferences, type AppEnvironment } from "./http";
import { PREFERENCES_COOKIE, PREFERENCES_PATH, pickPreferences, serializePreferencesCookie } from "../ui/preferences";
import { createDefaultCameraService } from "../vendors/tkenpro/camera-adapters";
import { CameraService } from "../vendors/tkenpro/camera-service";
import { TKENPRO_RAW_UPLOAD_PATH, tkenproErrorResponse, tkenproRoutes } from "../vendors/tkenpro/routes";
import { sonosMediaRoutes } from "../vendors/sonos/routes";
import { DogAnnouncer } from "../automations/dog-announcer";
import { dogRoutes } from "../automations/dog-routes";
import { automationSwitchRoutes } from "./automation-switch-routes";
import { renderAutomationsPage } from "../ui/automations-page";
import { TkenproPet3T } from "../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import { BinarySwitchError, type BinarySwitch } from "../models/binary-switch";
import type { Button, ButtonPressOptions } from "../models/button";
import { IrRfBlasterError, type InfraredBlaster, type RadioFrequencyBlaster } from "../models/blaster";
import { Esp32Nrf24Bridge } from "../devices/radio/esp32-nrf24-bridge";
import { Nrf24BridgeError } from "../protocols/nrf24-bridge/client";
import { Nrf24RecordingError } from "../protocols/nrf24-bridge/capture-journal";
import { decodeNrf24Code, encodeNrf24Code } from "../protocols/nrf24-bridge/code";
import { CAPABILITY_KINDS, CapabilityError, type CapabilityKind } from "../models/capability";
import { DeviceError, type Device } from "../models/device";
import { NetworkAdapterError } from "../network/adapter";
import { DeviceNetworkRecovery, type DeviceNetworkTarget } from "../network/recovery";
import { rescanDevices, summarizeRescan, type RescanResult } from "../network/rescan";
import type { DeviceIsolationStatus, NetworkIsolation } from "../network/isolation";
import type { WifiAdmissionService } from "../network/wifi-admission-service";
import { networkCommandRoutes } from "./network-command-routes";
import { HueClipError } from "../vendors/hue/clip-client";
import { LightError, type Light } from "../models/light";
import { join } from "node:path";
import { EVENT_TYPES } from "../models/event-types";
import { DeviceEventLogs } from "../models/device-event-log";
import { SelectedDeviceGroup } from "../models/device-group";
import type { Service } from "../models/service";
import { automationSwitchDocument } from "../state/automation-switch";
import { groupSwitchDocument } from "../state/group-switch";
import { StateHub } from "../state/hub";
import { deviceNode } from "../state/protocol";
import { stateRoutes } from "./state-routes";
import { authRoutes } from "./auth-routes";
import { authGuard } from "../auth/guard";
import { TokenStore } from "../auth/store";
import { trustsLocalNetwork } from "../auth/network";
import { uiModuleRoutes } from "./ui-modules";
import type { EventFilter } from "../models/event-log";
import { compileFilterCondition, FilterValidationError, type FilterCondition } from "../models/filter";
import { FilterStore, FilterStoreError } from "../models/filter-store";
import { readEventSelection } from "../models/event-selection";
import { filterRoutes } from "./filter-routes";
import { CameraLabelFeed } from "../vendors/frigate/label-feed";
import { FrigateEvents } from "../vendors/frigate/events";
import { PreviewAccessError } from "../vendors/frigate/previews";
import { ALARM_CAPTURE_DIRECTORY } from "../vendors/tkenpro/alarm-upload";
import { Site, devicePagePath } from "../site";
import { MemorySignalCodeStore, SignalCodeStoreError, type SignalCodeStore } from "../signal-code-store";
import type { DeviceControlRequest, HealthResponse, IrRfBlasterLearnRequest, IrRfBlasterSaveCodeRequest, IrRfBlasterSendCodeRequest, IrRfBlasterSendRequest, IrRfBlasterUpdateCodeRequest } from "../schemas";
import { buildSchemaCatalogResponse, CAPABILITY_KIND_SCHEMA_IDS, schemaCatalogEntries, schemaPagePath } from "../schema-catalog";
import { openApiRoutes } from "../openapi/routes";
import { renderSchemaAdminPage } from "../schema-admin";
import { renderSchemaPage } from "../schema-page";
import { renderCameraDashboardPage } from "../ui/dashboard";
import { renderCameraPage } from "../ui/camera-page";
import { partitionDevicesIntoGroups, renderHomePage, renderRootPage } from "../ui/home";
import { renderGroupPage } from "../ui/group-page";
import { deviceGroupRoutes } from "./device-group-routes";
import { renderServicePage, renderServicesPage } from "../ui/services-page";
import { renderIsolationPage } from "../ui/isolation-page";
import { renderIrRfBlasterPage } from "../ui/ir-rf-blaster-page";
import { renderLightPage } from "../ui/light-page";
import { renderLightSyncPage } from "../ui/light-sync-page";
import { renderSwitchPage } from "../ui/switch-page";
import { renderDeviceSwitchDefinition } from "../ui/switch-definition";
import { renderSpeakerPage } from "../ui/speaker-page";
import { renderTelevisionPage } from "../ui/television-page";
import { renderButtonPage } from "../ui/button-page";
import type { WorkflowTarget } from "../ui/button-page";
import { renderButtonsPage } from "../ui/buttons-page";
import { renderDeviceLogPage } from "../ui/device-log-page";
import { renderEventsPage } from "../ui/events-page";
import { parseViewState, renderGraphPage } from "../ui/graph-page";
import { deviceNav, renderDeviceHead } from "../ui/shell";

import { graphRoutes } from "./graph-routes";
import { iconRoutes } from "./icon-routes";
import { elementKey } from "../tags/identity";
import { renderDeviceSettingsPage } from "../ui/device-settings-page";
import { describeValidationErrors, validators } from "../validation";
import { RegionError, parseSourceRegion } from "../light-sync/region";
import { FileCameraRegionStore, type CameraRegionStore } from "../light-sync/region-store";
import { DeviceConfigWriteError, type DeviceConfigWriter } from "../config/device-writer";
import type { DeviceConfigEntry } from "../config/devices";
import { renderSwitchesPage, type SwitchBuilderButton } from "../ui/switches-page";
import type { DeviceRenameRequest, DeviceRenameResponse, OptimisticSwitchCreateRequest, OptimisticSwitchCreateResponse } from "../schemas";
import type { MatterBridgeSettings, MatterSettingsSource } from "../integrations/matter/settings";
import { WorkflowButtonDevice } from "../devices/composites/workflow-button";
import { validateWorkflow, WorkflowValidationError, type WorkflowDefinition } from "../workflows/runner";
import type { WorkflowButtonCreateRequest, WorkflowButtonUpdateRequest, HomeTruthObject } from "../schemas";

const NO_DEVICE = "No device with that id is defined in devices.yml";

/** A device read that could not complete because the device did not answer; reported as 502, never as a server fault. */
class DeviceUnreachableError extends Error {
  constructor(message: string) { super(message); this.name = "DeviceUnreachableError"; }
}

export function createApp(
  cameraService: CameraService = createDefaultCameraService(),
  site: Site = Site.empty(),
  signalCodes: SignalCodeStore = new MemorySignalCodeStore(),
  cameraRegions: CameraRegionStore = new FileCameraRegionStore(),
  /** The isolation switch, when this site runs one; absent in tests and on a site with no capable gateway. */
  isolation?: NetworkIsolation,
  /** One-shot DHCP recovery through the managed Wi-Fi adapter. */
  networkRecovery?: DeviceNetworkRecovery,
  /** Per-device in-memory events. Injected by tests when they need to seed or inspect it. */
  deviceLogs: DeviceEventLogs = new DeviceEventLogs(),
  /** Narrow writer used by the Switch builder; absent in read-only/test instances. */
  deviceConfigWriter?: DeviceConfigWriter,
  /** Private, read-only Matter bridge pairing information for device Settings pages. */
  matterSettings?: MatterSettingsSource,
  kindleConfig: KindleConfigStore = new MemoryKindleConfigStore(),
  wifiAdmission?: WifiAdmissionService,
  tags: TagStore = new TagStore(),
  /** The state graph, its observer, and its streams; one per worker, shared by the preview app and the live app. */
  hub: StateHub = new StateHub(),
  /**
   * The tokens this server accepts. Supplying one turns the guard on.
   *
   * Tests leave it out and get an unguarded app with an in-memory store, so a
   * route test is about the route. Outside test mode leaving it out is not a
   * quiet default but a refusal: the app serves 503 to everything rather than
   * serving the house to the LAN because a wiring line was forgotten.
   */
  tokens?: TokenStore,
  graphStore?: GraphStore,
  filters: FilterStore = new FilterStore(),
) {
  site.setTagSource(tags);
  // Rooms live in the ontology now. This reads the `room:` strings still in
  // `devices.yml` once and turns each into the tag `room = <name>`; the
  // YAML is left exactly as it is, so it stays the safety net if the database
  // is ever lost. Recorded in the database, so it never runs twice.
  migrateRoomsToTags(tags, {
    configuredRooms: site.configuredRooms,
    devices: site.devices.map(device => ({ id: device.id, ...(device.room ? { room: device.room } : {}) })),
    groups: site.deviceGroups.map(group => ({ id: group.id, ...(group.room ? { room: group.room } : {}) })),
  });
  const app = new Hono<AppEnvironment>();

  /**
   * Narrow a listing to what this request may see.
   *
   * `policy.ts` marks these routes `listing`, which checks the verb and leaves
   * the rows to the handler — this is the handler's half of that bargain. With
   * no guard (tests) there is no principal and nothing is hidden.
   */
  const visible = <T>(context: Context<AppEnvironment>, items: readonly T[], idOf: (item: T) => string): T[] => {
    const principal = context.get("principal");
    return principal ? principal.filter(items, idOf) : [...items];
  };
  /** Groups are all-or-nothing: one whose members are not all in reach is not shown. */
  const visibleGroups = <T extends { readonly members: readonly string[] }>(context: Context<AppEnvironment>, groups: readonly T[]): T[] => {
    const principal = context.get("principal");
    return principal ? groups.filter(group => principal.reachesAll(group.members)) : [...groups];
  };

  const capabilityOf = <T>(id: string, kind: CapabilityKind): T | undefined =>
    site.get(id)?.capability(kind) as T | undefined;

  type BuilderButtonSource = SwitchBuilderButton & (
    { readonly kind: "configured"; readonly buttonId: string }
    | { readonly kind: "broadlink"; readonly blasterId: string; readonly savedCodeId: string }
  );
  const builderButtons = (): BuilderButtonSource[] => {
    const views = new Map(site.list().map((device) => [device.id, device]));
    const configured: BuilderButtonSource[] = site.devices.flatMap((device) => {
      if (!device.capability("button")) return [];
      const view = views.get(device.id);
      return [{ reference: device.id, name: device.name, detail: view?.modelTitle ?? "Button", kind: "configured", buttonId: device.id }];
    });
    const projected = new Set(site.devices.flatMap((device) => {
      const config = device.config as { device?: unknown; savedCodeId?: unknown };
      return device.model.id === "action-button" && typeof config.device === "string" && typeof config.savedCodeId === "string"
        ? [`${config.device}\0${config.savedCodeId}`]
        : [];
    }));
    const blasters = site.devices.filter((device) => device.capability("infraredBlaster") || device.capability("radioFrequencyBlaster"));
    const saved = blasters.map((blaster): BuilderButtonSource[] =>
      data.signalCodes(blaster.id).flatMap((command) => projected.has(`${blaster.id}\0${command.id}`) ? [] : [{
        reference: `@broadlink:${encodeURIComponent(blaster.id)}:${command.id}`,
        name: command.name,
        detail: `${blaster.name} · ${command.channel === "infrared" ? "IR" : "RF"} Button`,
        kind: "broadlink" as const,
        blasterId: blaster.id,
        savedCodeId: command.id,
      }]),
    );
    return [...configured, ...saved.flat()];
  };

  const buttonIdFor = (source: Extract<BuilderButtonSource, { kind: "broadlink" }>, occupied: Set<string>): string => {
    const slug = `${source.blasterId}-${source.name}`.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "") || "broadlink-button";
    let candidate = slug.slice(0, 100);
    if (!occupied.has(candidate)) return candidate;
    const suffix = `-${source.savedCodeId.replaceAll("-", "").slice(0, 8)}`;
    candidate = `${slug.slice(0, 100 - suffix.length)}${suffix}`;
    let number = 2;
    while (occupied.has(candidate)) {
      const numbered = `${suffix}-${number}`;
      candidate = `${slug.slice(0, 100 - numbered.length)}${numbered}`;
      number += 1;
    }
    return candidate;
  };

  const sensorIdFor = (hubId: string, accessory: { name: string; serialNumber: string }, occupied: Set<string>): string => {
    const slug = `${hubId}-${accessory.name}`.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "") || "aqara-contact-sensor";
    let candidate = slug.slice(0, 100);
    if (!occupied.has(candidate)) return candidate;
    const suffix = `-${accessory.serialNumber.toLowerCase().replace(/[^a-z0-9]+/gu, "").slice(0, 8)}`;
    candidate = `${slug.slice(0, 100 - suffix.length)}${suffix}`;
    let number = 2;
    while (occupied.has(candidate)) {
      const numbered = `${suffix}-${number}`;
      candidate = `${slug.slice(0, 100 - numbered.length)}${numbered}`;
      number += 1;
    }
    return candidate;
  };

  const networkTargetOf = (device: Device): DeviceNetworkTarget | undefined => {
    const host = (device.config as { host?: unknown } | undefined)?.host;
    const mac = site.macAddressOf(device.id);
    return typeof host === "string" && host
      ? { id: device.id, name: device.name, address: host, ...(mac ? { mac } : {}) }
      : undefined;
  };

  type ObservedAvailability = "online" | "offline" | "degraded" | "unknown";
  const lastAvailability = new Map<string, ObservedAvailability>();
  const lastNetworkAddress = new Map<string, string>();
  const recordAvailability = (device: Device, current: ObservedAvailability) => {
    const previous = lastAvailability.get(device.id);
    if (previous === current) return;
    lastAvailability.set(device.id, current);
    deviceLogs.record(device.id, "availability_changed", `${device.name} is ${current}`, {
      level: current === "offline" ? "warn" : "info",
      data: { ...(previous ? { previous } : {}), current },
    });
  };
  networkRecovery?.subscribe((event) => {
    const deviceId = typeof event.deviceId === "string" ? event.deviceId : undefined;
    const device = deviceId ? site.get(deviceId) : undefined;
    if (!device || !deviceId) return;
    if (event.event === "device_network_reconnect"
      && typeof event.address === "string"
      && typeof event.currentAddress === "string"
      && typeof event.mac === "string") {
      deviceLogs.record(deviceId, "network_reconnect", `Asked managed Wi-Fi to reconnect ${device.name}`, {
        data: { expected: event.address, current: event.currentAddress, mac: event.mac },
      });
    }
  });

  /** One bounded read: the 3 s race plus the availability log. The observer polls with this and publishes the answer itself. */
  const readDevice = async (device: Device) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Loading a page or polling status must never disconnect a device.
      // Reconnect is an explicit network action, separate from observation.
      const object = await Promise.race([
        device.describe(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("timed out")), 3_000); }),
      ]);
      recordAvailability(device, object.status ?? "unknown");
      return object;
    } catch (error) {
      recordAvailability(device, "offline");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  /** A route's read: what it learns goes into the graph before it answers, so every open page sees it first. */
  const describeDevice = async (device: Device) => {
    const record = await hub.observer.refresh(deviceNode(device.id));
    if (record.fault || !record.value) throw new DeviceUnreachableError(record.fault?.message ?? "No observation available");
    hub.observer.invalidate(device.id);
    return record.value as HomeTruthObject;
  };

  // The graph reads devices through the same bounded reader as the routes, so
  // a page, the CLI, and the stream share one truth and one availability log.
  hub.bind({
    site,
    describe: readDevice,
    describeGroup: async (groupId) => {
      const group = site.deviceGroups.find((candidate) => candidate.id === groupId && candidate.asSwitch);
      if (!group) return undefined;
      const snapshot = hub.data.group(groupId)!;
      return groupSwitchDocument(group, snapshot, new Date().toISOString());
    },
    describeAutomation: async (automationId) => {
      const service = site.getService(automationId);
      if (!service?.switch) return undefined;
      return automationSwitchDocument(service.id, service.title, service.switch.enabled, service.status().availability, new Date().toISOString());
    },
  });
  const data = hub.configure({ site, deviceLogs, eventSources: site.services.map(service => service.id === "frigate" ? new CameraLabelFeed(service, site.getService("photo-labels")) : service), ...(networkRecovery && deviceConfigWriter?.setNetwork && site.devices.some(device => networkTargetOf(device)) ? { networkClients: () => networkRecovery.addressSettings().list() } : {}), signals: signalCodes, kindle: kindleConfig, tags, ...(matterSettings ? { matter: matterSettings } : {}) });
  signalCodes = data.signals;
  kindleConfig = data.kindle;
  // Bootstrap reads are independent of requests. Runtime activation awaits local metadata once.
  void data.refresh();

  /** A per-kind route changed a device without the generic reader: re-read it for the pages watching it. */
  const changed = (deviceId: string) => {
    hub.observer.invalidate(deviceId);
    if (hub.observer.isRetained(deviceNode(deviceId))) void hub.observer.refresh(deviceNode(deviceId)).catch(() => undefined);
  };

  const switchJson = async (context: Context<AppEnvironment>, id: string, action?: "turnOn" | "turnOff" | "toggle") => {
    const capability = capabilityOf<BinarySwitch>(id, "binarySwitch");
    const device = site.get(id);
    if (!capability || !device) return errorJson(context, 404, "not_found", "No switch with that id is defined in devices.yml");
    if (action) await capability[action]();
    const document = (await describeDevice(device)).capabilities.binarySwitch!;
    if (action) {
      deviceLogs.record(device.id, "device_control", `${device.name}: ${action}`, { data: { control: action } });
    }
    recordAvailability(device, document.state.availability);
    return checkedJson(context, validators.binarySwitch, document);
  };

  const lightJson = async (context: Context<AppEnvironment>, id: string, action?: "turnOn" | "turnOff" | "toggle") => {
    const capability = capabilityOf<Light>(id, "light");
    const device = site.get(id);
    if (!capability || !device) return errorJson(context, 404, "not_found", "No light with that id is defined in devices.yml");
    if (action) await capability[action]();
    const document = (await describeDevice(device)).capabilities.light!;
    if (action) {
      deviceLogs.record(device.id, "device_control", `${device.name}: ${action}`, { data: { control: action } });
    }
    recordAvailability(device, document.state.availability);
    return checkedJson(context, validators.light, document);
  };

  const buttonJson = async (context: Context<AppEnvironment>, id: string, press?: ButtonPressOptions) => {
    const capability = capabilityOf<Button>(id, "button");
    const device = site.get(id);
    if (!capability || !device) return errorJson(context, 404, "not_found", "No button with that id is defined in devices.yml");
    if (press) {
      await capability.press(press);
      deviceLogs.record(id, "device_control", `${device.name}: press`, { data: { control: "press" } });
      changed(id);
    }
    return checkedJson(context, validators.button, (await describeDevice(device)).capabilities.button!);
  };

  const workflowButtonOf = (id: string): WorkflowButtonDevice | undefined => {
    const device = site.get(id);
    return device instanceof WorkflowButtonDevice ? device : undefined;
  };

  const workflowTargets = (): WorkflowTarget[] => site.devices
    .map((device) => ({ id: device.id, name: device.name, ...(site.view(device.id)?.room ? { room: site.view(device.id)!.room! } : {}), controls: postControlNames(device) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const validateWorkflowForSite = (workflow: WorkflowDefinition): void => {
    validateWorkflow(workflow);
    for (const node of workflow.nodes) {
      if (node.type !== "action" && node.type !== "condition") continue;
      const target = site.get(node.device);
      if (!target) throw new WorkflowValidationError(`Workflow node "${node.id}" targets missing device "${node.device}"`);
      if (node.type === "action") {
        try { target.resolveControl(node.control); }
        catch (error) { throw new WorkflowValidationError(error instanceof Error ? error.message : String(error)); }
      }
    }
  };

  app.use("*", requestId());
  app.use("*", async (context, next) => {
    const started = performance.now();
    await next();
    context.header("Server-Timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
  });
  app.use("/kindle", async (context, next) => {
    await next();
    const csp = context.res.headers.get("Content-Security-Policy");
    if (csp) context.header("Content-Security-Policy", csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    context.header("X-Frame-Options", "SAMEORIGIN");
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        defaultSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: [NONCE],
        styleSrc: [NONCE],
      },
    }),
  );
  // A page is identified entirely by its requested URL. Do not let an HTML
  // response become a reusable "last page" for another path after a restart.
  app.use("*", async (context, next) => {
    await next();
    if (context.res.headers.get("content-type")?.startsWith("text/html")) {
      context.header("Cache-Control", "no-store");
      context.header("Content-Location", new URL(context.req.url).pathname);
    }
  });
  app.use("/api/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });
  app.use("/api/*", async (context, next) => {
    if (context.req.method === "GET" || context.req.method === "HEAD") return await next();
    const contentType = context.req.header("content-type") ?? "";
    const pathname = new URL(context.req.url).pathname;
    const isTalkbackAudio = context.req.method === "POST" && TKENPRO_RAW_UPLOAD_PATH.test(pathname);
    // Restoring a tag export sends the YAML back exactly as it was written, so
    // a person can pipe the file they kept without converting it first.
    const isTagImport = context.req.method === "POST" && pathname === "/api/tags/import";
    const validContentType = isTalkbackAudio
      ? /^application\/octet-stream(?:\s*;|$)/iu.test(contentType)
      : isTagImport
        ? /^(?:text\/(?:yaml|x-yaml|plain)|application\/(?:x-)?yaml)(?:\s*;|$)/iu.test(contentType)
        : /^application\/json(?:\s*;|$)/iu.test(contentType);
    if (!validContentType) {
      return errorJson(
        context,
        415,
        "invalid_request",
        isTalkbackAudio
          ? "Talkback audio requires signed 16-bit PCM"
          : isTagImport
            ? "A tag import requires a text/yaml request"
            : "Changes require an application/json request",
      );
    }
    const origin = context.req.header("origin");
    if (origin) {
      if (!isAllowedChangeOrigin(context, origin)) {
        return errorJson(context, 403, "invalid_request", "Cross-origin changes are not allowed");
      }
    }
    return await next();
  });

  /**
   * Authentication and authorization, before any handler runs.
   *
   * `tokenStore` is what the token routes read and write; `tokens` is what
   * decides whether anything is enforced. They differ only in tests.
   */
  const tokenStore = tokens ?? new TokenStore();
  // Read once, so the guard and the pages that explain it cannot disagree
  // about whether the local network is open.
  const trustLocalNetwork = trustsLocalNetwork();
  if (tokens) {
    app.use("*", authGuard({ tokens, site, trustLocalNetwork }));
  } else if (process.env.NODE_ENV !== "test") {
    app.use("*", async context => errorJson(context, 503, "unconfigured",
      "HomeTruth was started without a token store and cannot authenticate anyone"));
  }

  app.use("*", async (context, next) => {
    const principal = context.get("principal");
    context.set("uiFeatures", {
      isolation: isolation !== undefined || wifiAdmission !== undefined,
      // With no guard there is no principal, and every page is already open.
      admin: tokens ? Boolean(principal?.allowsSite("admin")) : true,
    });
    const records = new Map(hub.snapshot().map(record => [record.node, record]));
    context.set("pageState", { snapshot: nodes => [...new Set(nodes)].flatMap(node => records.get(node) ?? []) });
    context.set("rooms", !principal || principal.allowsSite("read") ? site.rooms : []);
    context.set("tagEditor", key => {
      const catalog = pageCatalog(hub);
      const path = new URL(context.req.url).pathname;
      const base = site.pages().resolve(path)?.entry.page ?? path;
      const elements = key ? [catalog.byKey.get(key)].filter(element => element !== undefined) : catalog.byPage.get(base) ?? [];
      const tags = !principal || principal.allowsSite("read") ? catalog.tags : catalog.tags.filter(tag => elements.some(element => element.tagIds.includes(tag.id)));
      return renderTagEditor(pageContext(context), { tags, elements });
    });
    context.set("elementApi", () => {
      const path = new URL(context.req.url).pathname;
      const node = elementForPage(site, hub, path);
      if (!node) return undefined;
      const page = path.startsWith("/elements/") ? `/elements/${node.id}` : site.pages().resolve(path)?.entry.page ?? (path === "/" ? "" : path);
      const api = buildElementApi({ site, hub, node, page, origin: new URL(context.req.url).origin, routes: app.routes, version: process.env.HOMETRUTH_RELOAD_VERSION ?? "dev", uuid: inventoryFor(hub, graphStore).byKey.get(node.id)!.uuid });
      const ctx = pageContext(context);
      return { body: renderElementApi(ctx, api), tabs: renderElementApiTabs(ctx.path), css: ELEMENT_API_CSS, script: ELEMENT_API_SCRIPT };
    });
    await next();
  });

  /** The footer's theme / appearance / language form: remember the choice in one cookie and return to the page. */
  app.post(PREFERENCES_PATH, async (context) => {
    const form = await context.req.parseBody();
    const fields = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === "string" ? value : undefined]));
    const next = { ...uiPreferences(context), ...pickPreferences(fields) };
    setCookie(context, PREFERENCES_COOKIE, serializePreferencesCookie(next), { path: "/", sameSite: "Lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    const back = typeof fields.return === "string" && fields.return.startsWith("/") && !fields.return.startsWith("//") ? fields.return : "/";
    return context.redirect(back, 303);
  });

  const pageDevice = (context: Context<AppEnvironment>) => {
    const match = site.pages().resolve(new URL(context.req.url).pathname);
    return match?.entry.source === "device" ? site.view(match.entry.id) : undefined;
  };
  const devicePrefixes = ["devices", "switches", "lights", "string-lights", "buttons", "cameras", "sensors", "hubs", "blasters", "speakers", "groups"];

  /** The root is deliberately blank for now: the devices listing lives at `/devices`. */
  app.get("/", (context) => {
    context.header("Cache-Control", "no-store");
    return context.html(renderRootPage(pageContext(context)));
  });

  app.get("/devices", (context) => {
    context.header("Cache-Control", "no-store");
    return context.html(renderHomePage({ ctx: pageContext(context), devices: visible(context, site.list(), device => device.id), deviceGroups: visibleGroups(context, site.listGroups()), canGroup: Boolean(deviceConfigWriter?.addGroup), canRescan: Boolean(networkRecovery && deviceConfigWriter?.setNetwork) }));
  });

  app.route("/", elementApiRoutes(site, hub, () => app.routes));
  app.route("/", clientRoutes(hub, () => app.routes, graphStore));
  app.route("/", authRoutes(tokenStore, site, tags, trustLocalNetwork));
  app.route("/", stateRoutes(hub, { groupMembers: id => site.deviceGroups.find(group => group.id === id)?.members }));
  app.route("/", uiModuleRoutes());
  app.route("/", tagRoutes(site, tags, hub));
  app.route("/", filterRoutes(filters));
  app.route("/", graphRoutes(hub));
  app.route("/", iconRoutes());
  app.route("/", kindleRoutes(site, hub));
  app.route("/", deviceGroupRoutes(site, tags, hub, deviceConfigWriter, (id, control) => {
    deviceLogs.record(id, "device_control", `${site.get(id)?.name ?? id}: ${control}`, { data: { control } });
    changed(id);
  }, (group, snapshot) => {
    // The switch endpoint just described the group: the pages watching it get that document, not a second read.
    hub.observer.publishGroup(group.id, groupSwitchDocument(group, snapshot, new Date().toISOString()));
  }));

  app.get("/switches", async (context) => {
    const devices = visible(context, site.list(), device => device.id);
    context.header("Cache-Control", "no-store");
    return context.html(renderSwitchesPage({
      ctx: pageContext(context),
      switches: devices.filter((device) => device.capabilities.includes("binarySwitch")),
      groups: visibleGroups(context, site.listGroups()),
      buttons: builderButtons(),
      canCreate: deviceConfigWriter !== undefined,
    }));
  });

  app.get("/buttons", (context) => {
    context.header("Cache-Control", "no-store");
    return context.html(renderButtonsPage(pageContext(context), visible(context, site.list(), device => device.id).filter((device) => device.capabilities.includes("button")), Boolean(deviceConfigWriter)));
  });

  app.get("/groups/:slug", (context, next) => {
    const match = site.pages().resolve(new URL(context.req.url).pathname);
    if (match?.entry.source !== "speaker-group") return next();
    const { groups } = partitionDevicesIntoGroups(site.list());
    const group = groups.find((candidate) => candidate.label === match.entry.id);
    if (!group) return context.notFound();
    context.header("Cache-Control", "no-store");
    return context.html(renderGroupPage({ ctx: pageContext(context), label: group.label, members: group.members, ...(group.controlDevice ? { controlDevice: group.controlDevice } : {}) }));
  });

  // The Graph tab. One renderer serves every element; a device page reaches it
  // through its own tab bar, everything else through /elements/<key>/graph.
  for (const prefix of devicePrefixes) app.get(`/${prefix}/:slug/graph`, async (context) => {
    const device = pageDevice(context);
    if (!device) return context.notFound();
    context.header("Cache-Control", "no-store");
    const graph = data.topology();
    const ctx = pageContext(context);
    const url = new URL(context.req.url);
    const page = renderGraphPage({
      ctx, graph, focus: elementKey("device", device.id), nav: deviceNav(device),
      state: parseViewState(url.searchParams), base: url.pathname,
      header: renderDeviceHead(ctx, device, "graph"),
    });
    return page ? context.html(page) : context.notFound();
  });

  for (const prefix of devicePrefixes) app.get(`/${prefix}/:slug/log`, (context) => {
    const device = pageDevice(context);
    if (!device) return context.notFound();
    validatePageFilters(context);
    context.header("Cache-Control", "no-store");
    return context.html(renderDeviceLogPage({
      ctx: pageContext(context),
      device,
      events: data.events.device(device.id),
      types: EVENT_TYPES.map(({ id, label, description, level, view }) => ({ id, label, description, level, view })),
    }));
  });

  for (const prefix of devicePrefixes) app.get(`/${prefix}/:slug/settings`, async (context) => {
    const device = pageDevice(context);
    if (!device) return context.notFound();
    context.header("Cache-Control", "no-store");
    let matter: MatterBridgeSettings | undefined;
    let matterError: string | undefined;
    if (device.capabilities.includes("binarySwitch") && matterSettings) {
      ({ value: matter, error: matterError } = data.matterSettings());
    }
    return context.html(renderDeviceSettingsPage({
      ctx: pageContext(context),
      device,
      networkClients: data.networkClients(),
      networkWritable: Boolean(networkRecovery && deviceConfigWriter?.setNetwork),
      networkMac: networkTargetOf(site.get(device.id)!)?.mac,
      switchDefinition: renderDeviceSwitchDefinition(pageContext(context), site, site.get(device.id)!, id => data.signalCodes(id)),
      ...(matter ? { matter } : {}),
      ...(matterError ? { matterError } : {}),
    }));
  });

  for (const prefix of devicePrefixes) app.get(`/${prefix}/:slug`, (context) => {
    const device = pageDevice(context);
    if (!device) return context.notFound();
    const id = device.id;
    context.header("Cache-Control", "no-store");
    const ctx = pageContext(context);
    if (device.capabilities.includes("cooktop")) return context.html(renderCooktopPage({ ctx, device }));
    switch (device.kind) {
      case "device":
      case "sensor":
      case "hub": {
        const bridged = (device.relationships ?? [])
          .filter(link => link.relation === "usedBy")
          .flatMap(link => {
            const target = site.view(link.id);
            if (!target) return [];
            const serialNumber = (site.get(link.id)?.config as { serialNumber?: unknown } | undefined)?.serialNumber;
            return [{ id: target.id, name: target.name, page: target.page, modelTitle: target.modelTitle, ...(typeof serialNumber === "string" ? { serialNumber } : {}) }];
          });
        return context.html(renderSensorPage({ ctx, device, bridged }));
      }
      case "binary-switch":
        return context.html(renderSwitchPage({ ctx, device }));
      case "string-light":
        return context.html(renderStringLightPage({ ctx, device, lights: site.list().filter(light => light.parent?.id === device.id).sort((a, b) => a.parent!.index - b.parent!.index) }));
      case "light":
        return context.html(renderLightPage({ ctx, device }));
      case "button":
        if (device.model === "workflow-button") {
          const workflow = workflowButtonOf(device.id);
          const options = {
            ctx, device,
            workflowTargets: workflowTargets(),
            canEditWorkflow: typeof deviceConfigWriter?.setWorkflow === "function",
            ...(workflow ? { workflow: workflow.button.workflow, workflowRun: workflow.button.run } : {}),
          };
          return context.html(renderButtonPage(options));
        }
        return context.html(renderButtonPage({ ctx, device }));
      case "ir-rf-blaster":
        return context.html(renderIrRfBlasterPage({ ctx, device, codes: data.signalCodes(device.id) }));
      case "rf-receiver":
        return context.html(renderRadioReceiverPage({ ctx, device }));
      case "camera":
        validatePageFilters(context);
        return context.html(renderCameraPage({ ctx, device, photoHistory: Boolean(capabilityOf<Camera>(id, "camera")?.mediaSource?.()?.photos) }));
      case "speaker":
      case "speaker-group":
        return context.html(renderSpeakerPage({ ctx, device }));
      case "television":
        return context.html(renderTelevisionPage({ ctx, device }));
      case "pet-camera": {
        validatePageFilters(context);
        const model = site.as(id, TkenproPet3T)?.pageModel();
        if (!model) return context.notFound();
        if (model.eventLog) model.eventLog = { ...model.eventLog, servicePage: site.pages().page("service", model.eventLog.serviceId) };
        return context.html(renderCameraDashboardPage({ ctx, model, device }));
      }
    }
  });

  /** The polygon region editor: any device with a camera capability, whatever its page `kind`. */
  for (const prefix of devicePrefixes) app.get(`/${prefix}/:slug/light-sync`, (context) => {
    const device = pageDevice(context);
    if (!device || !device.capabilities.includes("camera")) return context.notFound();
    context.header("Cache-Control", "no-store");
    return context.html(renderLightSyncPage({ ctx: pageContext(context), device }));
  });

  /** The media bridge for any camera whose product publishes a local stream/snapshot source. */
  const cameraMedia = (id: string) => {
    const camera = capabilityOf<Camera>(id, "camera");
    if (!camera) throw new DeviceError(NO_DEVICE, "no_such_capability");
    const source = camera.mediaSource?.();
    if (!source) throw new CameraMediaError("This camera does not publish a local media source", "unavailable");
    return source;
  };

  app.get("/api/cameras/:id/stream.mjpeg", (context) =>
    createMjpegStreamResponse(cameraMedia(context.req.param("id")), context.req.raw.signal),
  );

  app.get("/api/cameras/:id/snapshot", async (context) => {
    const bytes = await captureCameraSnapshot(cameraMedia(context.req.param("id")));
    return new Response(bytes.buffer as ArrayBuffer, {
      headers: { "Cache-Control": "no-store, max-age=0", "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" },
    });
  });

  app.get("/api/cameras/:id/photos", async (context) => {
    const history = cameraMedia(context.req.param("id")).photos;
    if (!history) return errorJson(context, 404, "not_found", "This camera has no saved photo history");
    context.header("Cache-Control", "no-store");
    const order = context.req.query("order") ?? "newest";
    if (order !== "newest" && order !== "oldest") return errorJson(context, 400, "invalid_value", "Photo order must be newest or oldest");
    return context.json(await history.list(context.req.query("cursor"), order));
  });

  app.post("/api/cameras/:id/photos/sync", async (context) => {
    const history = cameraMedia(context.req.param("id")).photos;
    if (!history?.syncAll) return errorJson(context, 404, "not_found", "This camera cannot import photo history");
    await history.syncAll();
    return context.json({ queued: true }, 202);
  });

  app.get("/api/cameras/:id/photos/:photoId", async (context) => {
    const history = cameraMedia(context.req.param("id")).photos;
    const bytes = await history?.read(context.req.param("photoId"));
    if (!bytes) return errorJson(context, 404, "not_found", "Saved photo not found");
    return new Response(new Uint8Array(bytes).buffer, { headers: { "Cache-Control": "private, max-age=86400", "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" } });
  });

  /** A camera's saved light-sync region: the polygon a rule samples pixels from. See `light-sync/region.ts`. */
  const NO_CAMERA = "No camera with that id is defined in devices.yml";

  app.get("/api/cameras/:id/light-sync/region", async (context) => {
    const id = context.req.param("id");
    if (!capabilityOf<Camera>(id, "camera")) return errorJson(context, 404, "not_found", NO_CAMERA);
    const region = await cameraRegions.get(id);
    return checkedJson(context, validators.cameraRegionResponse, {
      region: region ? { points: region.points.map((p) => ({ x: p.x, y: p.y })) } : null,
    });
  });

  app.put("/api/cameras/:id/light-sync/region", async (context) => {
    const id = context.req.param("id");
    if (!capabilityOf<Camera>(id, "camera")) return errorJson(context, 404, "not_found", NO_CAMERA);
    const input = await requestJson(context);
    if (!validators.sourceRegion(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.sourceRegion.errors));
    }
    const region = parseSourceRegion(input);
    await cameraRegions.set(id, region);
    return checkedJson(context, validators.cameraRegionResponse, { region: { points: region.points.map((p) => ({ x: p.x, y: p.y })) } });
  });

  app.delete("/api/cameras/:id/light-sync/region", async (context) => {
    const id = context.req.param("id");
    if (!capabilityOf<Camera>(id, "camera")) return errorJson(context, 404, "not_found", NO_CAMERA);
    await cameraRegions.delete(id);
    return checkedJson(context, validators.cameraRegionResponse, { region: null });
  });

  app.get("/events", (context) => {
    validatePageFilters(context);
    context.header("Cache-Control", "no-store");
    return context.html(renderEventsPage({
      ctx: pageContext(context),
      subjects: subjectViews(site.devices.map((device) => device.id)).sort((left, right) => left.name.localeCompare(right.name)),
      types: eventTypeViews(),
      events: allEvents(200, eventFilter(context, true)),
    }));
  });

  app.route("/", healthRoutes(site, pageContext));

  app.get("/services", (context) => {
    context.header("Cache-Control", "no-store");
    return context.html(renderServicesPage({ ctx: pageContext(context), services: data.services().map(service => ({ ...service, ...service.status, page: site.pages().page("service", service.id)! })) }));
  });

  app.get("/services/:id", (context) => {
    const match = site.pages().resolve(new URL(context.req.url).pathname);
    const id = match?.entry.source === "service" ? match.entry.id : context.req.param("id");
    const source = serviceForEvents(id);
    if (!source) return context.notFound();
    validatePageFilters(context);
    const cached = data.service(id);
    const service = { id, title: source.title, health: source.health, availability: cached?.status.availability ?? "unknown" as const, detail: cached?.status.detail ?? "", actions: cached?.actions ?? [], endpoints: cached?.endpoints ?? [], page: site.pages().page("service", id) ?? `/services/${encodeURIComponent(id)}` };
    context.header("Cache-Control", "no-store");
    return context.html(renderServicePage({
      ctx: pageContext(context),
      service,
      subjects: subjectViews(source.subjects()),
      types: eventTypeViews(),
      detectionLabels: source.detectionLabels(),
      events: !context.get("principal") || context.get("principal")!.allowsSite("read") ? source.events(100, eventFilter(context, true)) : [],
      actions: service.actions,
    }));
  });

  /** Isolation is configuration, not a service: it gets a settings page, not a log. */
  app.get("/network-isolation", async (context) => {
    context.header("Cache-Control", "no-store");
    const status = isolation?.snapshot();
    return context.html(renderIsolationPage({
      ctx: pageContext(context),
      status,
      devices: site.list(),
      logPageOf: (deviceId) => site.services.some((service) => site.serviceSubjects(service.id).includes(deviceId)) ? `${site.view(deviceId)?.page ?? devicePagePath(deviceId)}/log` : undefined,
    }));
  });

  app.route("/", networkCommandRoutes(wifiAdmission));

  /** Isolation: which devices are cut off from the internet, and the switch for each. */
  app.get("/api/isolation", async (context) => {
    if (!isolation) return errorJson(context, 404, "not_found", "This server cannot isolate devices");
    const status = context.req.query("refresh") === "1" ? await isolation.refresh() : (isolation.snapshot() ?? await isolation.refresh());
    return context.json(status);
  });

  app.get("/api/devices/:id/isolation", async (context) => {
    if (!isolation) return errorJson(context, 404, "not_found", "This server cannot isolate devices");
    const id = context.req.param("id");
    const status = isolation.snapshot() ?? await isolation.refresh();
    const device = status.devices.find((entry: DeviceIsolationStatus) => entry.deviceId === id);
    if (!device) return errorJson(context, 404, "not_found", site.get(id) ? `${id} has no LAN address, so it cannot be isolated` : NO_DEVICE);
    return context.json(device);
  });

  app.post("/api/devices/:id/isolation", async (context) => {
    if (!isolation) return errorJson(context, 404, "not_found", "This server cannot isolate devices");
    const id = context.req.param("id");
    const input = await requestJson(context);
    const isolated = (input as { isolated?: unknown } | undefined)?.isolated;
    if (typeof isolated !== "boolean") return errorJson(context, 400, "invalid_request", "Send {\"isolated\": true | false}");
    if (!site.get(id)) return errorJson(context, 404, "not_found", NO_DEVICE);
    const result = await isolation.setIsolated(id, isolated);
    const device = result.status.devices.find((entry: DeviceIsolationStatus) => entry.deviceId === id);
    return context.json({ message: result.message, device, status: result.status });
  });

  app.get("/api/services", (context) =>
    checkedJson(context, validators.serviceListResponse, { services: site.listServices(), generatedAt: new Date().toISOString() }),
  );

  /**
   * `?subject=<device id>` narrows to one device's events and `?type=a,b` to
   * particular kinds; both apply to the live stream below as well, so a
   * filtered view is filtered at the source rather than in the browser.
   */
  const validatePageFilters = (context: Context<AppEnvironment>): void => {
    for (const key of ["filter", "editing-filter"]) {
      const slug = context.req.query(key);
      if (slug === undefined) continue;
      const principal = context.get("principal");
      if (principal && !principal.allowsSite("read")) throw new FilterStoreError("Saved Filters require site read access", "forbidden");
      filters.getBySlug(slug);
    }
  };
  const eventFilter = (context: Context<AppEnvironment>, page = false): EventFilter => {
    let subject = context.req.query("subject")?.trim();
    const types = context.req.query("type")?.split(",").map((type) => type.trim()).filter(Boolean);
    const labels = [...new Set(context.req.queries("label")?.map(label => label.trim().toLowerCase()).filter(label => label.length > 0 && label.length <= 200) ?? [])].slice(0, 100);
    const serialized = context.req.query("where");
    const savedId = context.req.query("filter");
    let where: FilterCondition | undefined;
    if (savedId !== undefined) {
      const principal = context.get("principal");
      if (principal && !principal.allowsSite("read")) throw new FilterStoreError("Saved Filters require site read access", "forbidden");
      where = (page ? filters.getBySlug(savedId) : filters.get(savedId)).filter.condition;
    }
    if (serialized !== undefined) {
      if (serialized.length > 16_384) throw new FilterValidationError("Filter condition exceeds 16384 characters");
      let input: unknown;
      try { input = JSON.parse(serialized); } catch { throw new FilterValidationError("Filter condition must be JSON"); }
      compileFilterCondition(input);
      where = where ? { all: [where, input as FilterCondition] } : input as FilterCondition;
    }
    if (where) compileFilterCondition(where);
    return { ...(subject ? { subject } : {}), ...(types && types.length > 0 ? { types } : {}), ...(labels.length ? { labels } : {}), ...(where ? { where } : {}) };
  };

  const detectionSubjects = (filter: EventFilter): readonly string[] | undefined => {
    const selected = filter.where ? readEventSelection(filter.where).subjects : [];
    if (filter.subject !== undefined) return selected.length && !selected.includes(filter.subject) ? [] : [filter.subject];
    return selected.length ? selected : undefined;
  };

  const serviceForEvents = (id: string) => {
    const service = site.getService(id);
    return service && id === "frigate" ? new CameraLabelFeed(service, site.getService("photo-labels")) : service;
  };

  app.get("/api/services/frigate/frames/:camera/:objectId", async context => {
    context.header("Cache-Control", "no-store");
    const { camera, objectId } = context.req.param();
    const rawTime = context.req.query("at");
    const frameTime = rawTime === undefined ? undefined : Number(rawTime);
    const valid = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value);
    if (!valid(camera) || !valid(objectId) || (frameTime !== undefined && (!rawTime || !Number.isFinite(frameTime) || frameTime < 0 || frameTime >= 100_000_000_000))) {
      return errorJson(context, 400, "invalid_request", "Invalid detection frame");
    }
    const service = site.getService("frigate");
    if (!(service instanceof FrigateEvents)) return errorJson(context, 404, "not_found", "Frigate is not configured");
    try {
      const jpeg = await service.snapshot(camera, objectId, context.req.raw.signal, frameTime);
      if (!jpeg) return errorJson(context, 404, "not_found", "No snapshot is available for this detection");
      return new Response(new Uint8Array(jpeg).buffer, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=30", "X-Content-Type-Options": "nosniff" } });
    } catch { return errorJson(context, 502, "unavailable", "The detection snapshot could not be loaded"); }
  });

  app.get("/api/services/frigate/previews/:camera/:objectId", async context => {
    context.header("Cache-Control", "no-store");
    const { camera, objectId } = context.req.param();
    const rawTime = context.req.query("at");
    const frameTime = Number(rawTime);
    const valid = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value);
    if (!valid(camera) || !valid(objectId) || !rawTime || !Number.isFinite(frameTime) || frameTime < 0 || frameTime >= 100_000_000_000) {
      return errorJson(context, 400, "invalid_request", "Invalid detection preview");
    }
    const service = site.getService("frigate");
    if (!(service instanceof FrigateEvents)) return errorJson(context, 404, "not_found", "Frigate is not configured");
    try {
      const preview = await service.preview(camera, objectId, frameTime, context.req.raw.signal);
      if (!preview) return errorJson(context, 404, "not_found", "No timed frames are available for this detection");
      return context.json(preview);
    } catch (error) {
      if (error instanceof PreviewAccessError) return errorJson(context, 503, "unavailable", "Protect recording access is required for previews");
      return errorJson(context, 502, "unavailable", "The detection preview could not be loaded");
    }
  });

  /** Which devices a service's events are about, named as the site names them. */
  const subjectViews = (subjects: readonly string[]) =>
    subjects.map((subject) => { const device = site.view(subject); return { id: subject, name: device?.name ?? subject, ...(device ? { page: device.page } : {}) }; });

  /**
   * Every supported type stays available in the picker, including quiet
   * types such as motion that may have aged out of the in-memory ring. A
   * filter is also a statement about which future live events to follow; it
   * must not disappear merely because its current count is zero.
   */
  const eventTypeViews = () =>
    EVENT_TYPES.map(({ id, label, description, level, view }) => ({ id, label, description, level, view }));

  // A service's momentary actions, declared once on the model; the CLI and the
  // service page both come through here rather than reaching past it.
  app.post("/api/services/:id/actions/:action", async (context) => {
    const id = context.req.param("id"), actionId = context.req.param("action");
    const service = site.services.find((candidate) => candidate.id === id);
    if (!service) return errorJson(context, 404, "not_found", `No service with id "${id}"`);
    const action = service.actions.find((candidate) => candidate.id === actionId);
    if (!action) return errorJson(context, 404, "not_found", `Service "${id}" has no action "${actionId}"`);
    const { detail } = await action.invoke();
    data.refreshService(service);
    // `until` when the press left something standing, so the page that asked can
    // keep counting down to the same deadline without asking again.
    const until = action.state?.().until;
    return context.json({ serviceId: id, action: actionId, detail, ...(until ? { until } : {}) });
  });

  app.get("/api/services/:id/events", (context) => {
    const id = context.req.param("id");
    const service = serviceForEvents(id);
    if (!service) return errorJson(context, 404, "not_found", `No service with id "${id}"`);
    if (service instanceof CameraLabelFeed) {
      const filter = eventFilter(context);
      try {
        const page = service.page(Number(context.req.query("limit") ?? 100), context.req.query("before"), filter);
        return checkedJson(context, validators.serviceEventsResponse, { serviceId: id, ...page,
          subjects: [...service.subjects()], ...service.detectionOptions(detectionSubjects(filter)), types: [...new Set(page.events.map(event => event.type))] });
      } catch { return errorJson(context, 400, "invalid_request", "Invalid label history page"); }
    }
    const events = service.events(Number(context.req.query("limit") ?? "") || undefined, eventFilter(context));
    return checkedJson(context, validators.serviceEventsResponse, {
      serviceId: id,
      events: [...events],
      subjects: [...service.subjects()],
      types: [...new Set(service.events().map((event) => event.type))],
    });
  });

  // The MQTT broker is the unified mirror of these same source logs.
  // Including it here would show every event twice.
  const eventSources = () => site.services.filter((service) => service.id !== "mqtt-broker");
  /** Every recent event HomeTruth and its services recorded, newest first. */
  const allEvents = (limit = 200, filter: EventFilter = {}) => [
    ...deviceLogs.recentAll(undefined, filter),
    ...eventSources().flatMap((service) => service.events(undefined, filter)),
  ]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, Math.max(1, Math.min(200, limit)));
  const eventsForDevice = (deviceId: string, limit = 200, filter: EventFilter = {}) => allEvents(limit, { ...filter, subject: deviceId });

  /** A live aggregate tail: the matching backlog, then every matching event as it is recorded. */
  const eventStream = (context: Context<AppEnvironment>, filter: EventFilter): Response => {
    const encoder = new TextEncoder();
    const frame = (event: unknown) => encoder.encode(`event: service-event\ndata: ${JSON.stringify(event)}\n\n`);
    let unsubscribes: (() => void)[] = [];
    const stop = () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        for (const event of [...allEvents(200, filter)].reverse()) controller.enqueue(frame(event));
        const listener = (event: unknown) => {
          try { controller.enqueue(frame(event)); } catch { /* Client already gone. */ }
        };
        unsubscribes = [deviceLogs.subscribeAll(listener, filter), ...eventSources().map((service) => service.subscribe(listener, filter))];
      },
      cancel: stop,
    });
    context.req.raw.signal.addEventListener("abort", stop, { once: true });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  };

  app.get("/api/events", (context) => {
    const limit = Number(context.req.query("limit") ?? "") || 200;
    const events = allEvents(limit, eventFilter(context));
    return checkedJson(context, validators.eventsResponse, {
      events,
      subjects: [...new Set(events.flatMap((event) => event.subject ? [event.subject] : []))],
      types: [...new Set(events.map((event) => event.type))],
    });
  });

  app.get("/api/events/stream", (context) => eventStream(context, eventFilter(context)));

  app.get("/api/devices/:id/events", (context) => {
    const id = context.req.param("id");
    if (!site.get(id)) return errorJson(context, 404, "not_found", NO_DEVICE);
    const limit = Number(context.req.query("limit") ?? "") || 200;
    const events = eventsForDevice(id, limit, eventFilter(context));
    return checkedJson(context, validators.deviceEventsResponse, {
      deviceId: id,
      events,
      types: [...new Set(events.map((event) => event.type))],
    });
  });

  /** The catalog: every event type, its schema, and how a page should present it. */
  app.get("/api/event-types", (context) =>
    checkedJson(context, validators.eventTypeCatalogResponse, { types: [...EVENT_TYPES] }),
  );

  /**
   * One saved alarm thumbnail. The name comes from an event's own
   * `data.thumbnailUrl`, and is confined to that device's own folder under
   * the alarm directory: no separators, no traversal, nothing outside it.
   *
   * A Pet 3T scrambles the first kilobyte of every thumbnail it uploads
   * (`src/protocols/tkenpro/alarm-image.ts`), so what is on disk is what the
   * camera sent and the image is recovered here, with that camera's own
   * picture key. Without the key the file is served as it arrived and the
   * page shows a broken image rather than pretending it has a picture.
   */
  app.get("/api/devices/:id/alarms/:file", async (context) => {
    const id = context.req.param("id");
    const file = context.req.param("file");
    if (!site.get(id)) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!/^[A-Za-z0-9._-]{1,120}\.jpg$/u.test(file) || file.includes("..")) {
      return errorJson(context, 400, "invalid_request", "That is not a thumbnail name");
    }
    const path = join(ALARM_CAPTURE_DIRECTORY, id.replace(/[^a-z0-9._-]/giu, "_"), file);
    const image = Bun.file(path);
    if (!(await image.exists())) return errorJson(context, 404, "not_found", "No thumbnail was kept for that event");
    const stored = new Uint8Array(await image.arrayBuffer());
    const camera = site.as(id, TkenproPet3T);
    const shown = camera ? camera.decodeThumbnail(stored) : stored;
    context.header("Cache-Control", "private, max-age=86400");
    context.header("Content-Type", "image/jpeg");
    return context.body(shown.buffer as ArrayBuffer);
  });

  /**
   * A live tail of one service's events, Server-Sent Events. Sends the
   * backlog immediately (same events `/events` would return), then one more
   * `event: service-event` per event as it happens, and a `retry:` hint so a
   * dropped connection reconnects on its own. No polling: the browser holds
   * this connection open and gets pushed to the moment `EventLog.record()`
   * runs, the same instant a server console line would have appeared.
   */
  app.get("/api/services/:id/stream", (context) => {
    const id = context.req.param("id");
    const service = serviceForEvents(id);
    if (!service) return errorJson(context, 404, "not_found", `No service with id "${id}"`);
    const filter = eventFilter(context);

    const encoder = new TextEncoder();
    const sseFrame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        for (const event of [...service.events(undefined, filter)].reverse()) controller.enqueue(sseFrame("service-event", event));
        const stopEvents = service.subscribe((event) => {
          try { controller.enqueue(sseFrame("service-event", event)); } catch { /* Client already gone. */ }
        }, filter);
        // Counts follow the camera, even when a new event does not match checked labels.
        let stopCounts: (() => void) | undefined;
        if (service instanceof CameraLabelFeed) {
          const subjects = detectionSubjects(filter);
          const sendCounts = () => {
            try { controller.enqueue(sseFrame("detection-labels", service.detectionOptions(subjects))); } catch { /* Client already gone. */ }
          };
          sendCounts();
          stopCounts = service.subscribe(sendCounts, subjects === undefined ? {} : { where: subjects.length
            ? { path: "/subject", op: "in", value: subjects } : { not: { all: [] } } });
        }
        unsubscribe = () => { stopEvents(); stopCounts?.(); };
      },
      cancel() {
        unsubscribe?.();
      },
    });
    context.req.raw.signal.addEventListener("abort", () => unsubscribe?.(), { once: true });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  });

  /** Live aggregate tail for one device: its own ring plus every service event tagged with its id. */
  app.get("/api/devices/:id/events/stream", (context) => {
    const id = context.req.param("id");
    if (!site.get(id)) return errorJson(context, 404, "not_found", NO_DEVICE);
    return eventStream(context, { ...eventFilter(context), subject: id });
  });

  app.get("/api/models", (context) => checkedJson(context, validators.modelListResponse, site.modelList()));

  app.post("/api/aqara/:id/pair", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!(device instanceof AqaraHubM2) && !(device instanceof AqaraPresenceSensorFP2)) {
      return errorJson(context, 404, "not_found", "Pair the Aqara hub or FP2 directly; child sensors use their hub's connection");
    }
    let body: unknown;
    try { body = await context.req.json(); } catch { return errorJson(context, 400, "invalid_request", "A HomeKit code is required"); }
    const pin = (body as { pin?: unknown } | null)?.pin;
    if (typeof pin !== "string" || !/^\d{3}-\d{2}-\d{3}$/.test(pin)) return errorJson(context, 400, "invalid_request", "Enter a HomeKit code in XXX-XX-XXX format");
    if (!(device.source instanceof AqaraConnection)) return errorJson(context, 409, "not_supported", "This connection is managed elsewhere");
    try {
      await device.source.pair(pin);
      context.header("Cache-Control", "no-store");
      return context.json({ paired: true });
    } catch {
      return errorJson(context, 409, "pairing_failed", "Pairing could not complete. The device must be available for HomeKit pairing and the code must match. Existing Apple Home pairings are not removed automatically.");
    }
  });

  /** Add every contact sensor the hub already bridges but HomeTruth has no device for yet. */
  app.post("/api/aqara/:id/sync", async (context) => {
    if (!deviceConfigWriter) return errorJson(context, 409, "not_supported", "This HomeTruth instance has no writable device configuration");
    const hub = site.get(context.req.param("id"));
    if (!(hub instanceof AqaraHubM2)) return errorJson(context, 404, "not_found", "Sync sensors from the hub's own page");
    const discovered = await discoverContactSensors(hub.source);
    const configured = new Set(
      site.devices
        .filter((device): device is AqaraDoorWindowSensor => device instanceof AqaraDoorWindowSensor && device.hub.id === hub.id)
        .map((device) => device.config.serialNumber.toLowerCase()),
    );
    const occupied = new Set(site.devices.map((device) => device.id));
    const additions: DeviceConfigEntry[] = [];
    for (const accessory of discovered) {
      if (configured.has(accessory.serialNumber.toLowerCase())) continue;
      const id = sensorIdFor(hub.id, accessory, occupied);
      occupied.add(id);
      additions.push({ id, name: accessory.name, model: "aqara-door-window-sensor", config: { hub: hub.id, serialNumber: accessory.serialNumber } });
    }
    if (additions.length) await deviceConfigWriter.addAll(additions);
    context.header("Cache-Control", "no-store");
    return context.json({ added: additions.map((entry) => ({ id: entry.id, name: entry.name, page: site.view(entry.id)?.page ?? devicePagePath(entry.id) })) });
  });

  app.get("/api/devices", async (context) => {
    const body = await site.summaries(describeDevice);
    return checkedJson(context, validators.deviceListResponse, { ...body, devices: visible(context, body.devices, device => device.id) });
  });

  const deviceDetail = async (context: Context<AppEnvironment>, id: string) => {
    const device = site.get(id);
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    // The room comes from the ontology, not from the `room:` still in the YAML,
    // so a rename is visible here the moment it happens.
    const room = site.roomOf(elementKey("device", device.id), device.room);
    const body = {
      id: device.id,
      name: device.name,
      ...(room ? { room } : {}),
      page: site.view(device.id)!.page,
      model: {
        id: device.model.id,
        title: device.model.title,
        manufacturer: device.model.manufacturer,
        product: device.model.product,
        capabilities: [...device.model.capabilities],
        connectionTypes: [...device.model.connectionTypes],
        ...(device.model.sensors ? { sensors: [...device.model.sensors] } : {}),
        objectSchemaId: device.model.objectSchemaId,
      },
      config: device.config as Record<string, unknown>,
      secrets: Object.fromEntries(site.secretKeysOf(device.id).map((key) => [key, true])),
      controls: [...postControlNames(device)],
      enabled: device.enabled,
      object: await describeDevice(device).catch((error: unknown) => {
        // A dead or moved host makes the read race out before the protocol
        // client's own timeout; that is an unreachable device, not a server fault.
        const host = (device.config as { host?: unknown }).host;
        const reason = error instanceof Error ? error.message : String(error);
        throw new DeviceUnreachableError(`${device.name} did not answer${typeof host === "string" ? ` at ${host}` : ""} (${reason}). If it has moved, use Find on network on its Settings tab.`);
      }),
    };
    return checkedJson(context, validators.deviceDetailResponse, body);
  };

  app.get("/api/devices/:id", (context) => deviceDetail(context, context.req.param("id")));

  app.get("/api/rooms", (context) => {
    context.header("Cache-Control", "no-store");
    // Always writable: a room is a tag, and the tag store is always there.
    return context.json({ rooms: site.rooms, writable: true });
  });

  app.post("/api/devices/:id/room", async (context) => {
    const id = context.req.param("id");
    if (!site.get(id)) return errorJson(context, 404, "not_found", NO_DEVICE);
    const input = await requestJson(context);
    if (!validators.deviceRoomRequest(input)) return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.deviceRoomRequest.errors));
    // The room is a tag: `room` is single-valued, so attaching replaces
    // whatever room the device was in, and clearing it detaches the name.
    const key = elementKey("device", id);
    if (input.room) tags.attach(key, { name: ROOM, value: input.room });
    else tags.detachName(key, ROOM);
    data.invalidate();
    // Kept in sync so the YAML stays a usable fallback, but never the source of
    // truth; an instance with no writable config still records the room.
    await deviceConfigWriter?.setRoom?.(id, input.room).catch(() => {});
    return context.json({ id, room: input.room });
  });

  app.post("/api/devices/:id/name", async (context) => {
    if (!deviceConfigWriter) return errorJson(context, 409, "not_supported", "This HomeTruth instance has no writable device configuration");
    const id = context.req.param("id");
    if (!site.get(id)) return errorJson(context, 404, "not_found", NO_DEVICE);
    const input = await requestJson(context);
    if (!validators.deviceRenameRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.deviceRenameRequest.errors));
    }
    const name = (input as DeviceRenameRequest).name.trim();
    if (!name) return errorJson(context, 400, "invalid_request", "A device name cannot be blank");
    await deviceConfigWriter.rename(id, name);
    const body: DeviceRenameResponse = { id, name, page: site.view(id)!.page };
    return checkedJson(context, validators.deviceRenameResponse, body);
  });

  app.get("/api/devices/:id/enabled", (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    return checkedJson(context, validators.deviceEnabled, device.enabled);
  });

  const setDeviceEnabled = async (context: Context<AppEnvironment>, id: string, enabled: boolean) => {
    const device = site.get(id);
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!deviceConfigWriter?.setEnabled) return errorJson(context, 409, "not_supported", "This HomeTruth instance has no writable device configuration");
    await deviceConfigWriter.setEnabled(id, enabled);
    device.enabled = enabled;
    data.configurationChanged();
    hub.observer.invalidate(id);
    deviceLogs.record(id, "device_enabled_changed", `${device.name} was ${enabled ? "enabled" : "disabled"}`, { data: { enabled } });
    return checkedJson(context, validators.deviceEnabled, enabled);
  };
  app.post("/api/devices/:id/enable", (context) => setDeviceEnabled(context, context.req.param("id"), true));
  app.post("/api/devices/:id/disable", (context) => setDeviceEnabled(context, context.req.param("id"), false));

  const controlRequest = async (context: Context<AppEnvironment>) => {
    const input = await requestJson(context);
    if (!validators.deviceControlRequest(input)) return undefined;
    const { value, confirmed } = input as DeviceControlRequest;
    return { value, options: confirmed === undefined ? {} : { confirmed } };
  };
  const invalidControlRequest = (context: Context<AppEnvironment>) =>
    errorJson(context, 400, "invalid_request", describeValidationErrors(validators.deviceControlRequest.errors));

  /** The device's own control namespace: `turnOn`, `pan.left`, or `infraredBlaster.send` when two capabilities share a name. */
  app.post("/api/devices/:id/controls/:control", async (context) => {
    const id = context.req.param("id");
    const device = site.get(id);
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    const request = await controlRequest(context);
    if (!request) return invalidControlRequest(context);
    const control = context.req.param("control");
    const resolved = device.resolveControl(control);
    if (readControlPath(id, resolved.kind, resolved.controlId)) return errorJson(context, 404, "unknown_control", "State is read with GET, not a POST control");
    await device.invokeControl(control, request.value, request.options);
    deviceLogs.record(id, "device_control", `${device.name}: ${control}`, { data: { control } });
    return deviceDetail(context, id);
  });

  app.post("/api/devices/:id/capabilities/:kind/controls/:controlId", async (context) => {
    const id = context.req.param("id");
    const kind = context.req.param("kind");
    const controlId = context.req.param("controlId");
    const device = site.get(id);
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!(CAPABILITY_KINDS as readonly string[]).includes(kind)) {
      return errorJson(context, 404, "not_found", `No capability "${kind}"; one of ${CAPABILITY_KINDS.join(", ")}`);
    }
    if (readControlPath(id, kind, controlId)) return errorJson(context, 404, "unknown_control", "State is read with GET, not a POST control");
    const request = await controlRequest(context);
    if (!request) return invalidControlRequest(context);
    await device.invoke(kind as CapabilityKind, controlId, request.value, request.options);
    deviceLogs.record(id, "device_control", `${device.name}: ${kind}.${controlId}`, { data: { control: `${kind}.${controlId}` } });
    return deviceDetail(context, id);
  });

  app.post("/api/devices/:id/reboot", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!device.reboot) return errorJson(context, 409, "not_supported", `${device.name} cannot be rebooted from HomeTruth`);
    await device.reboot();
    deviceLogs.record(device.id, "device_reboot", `${device.name} was asked to reboot`);
    return deviceDetail(context, device.id);
  });

  app.get("/api/devices/:id/network/settings", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    const target = networkTargetOf(device);
    if (!target || !networkRecovery || !deviceConfigWriter?.setNetwork) return errorJson(context, 409, "not_supported", "IP settings are unavailable for this device or server");
    await data.refreshNetworkClients();
    const clients = data.networkClients();
    const matches = clients.filter((client) => target.mac ? client.mac === target.mac.toLowerCase()
      : [client.address, client.fixedAddress, client.lastAddress].includes(target.address));
    return context.json({ address: target.address, mac: target.mac?.toLowerCase() ?? (matches.length === 1 ? matches[0]!.mac : null), clients });
  });

  app.post("/api/devices/:id/network/settings", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    const target = networkTargetOf(device);
    if (!target || !networkRecovery || !deviceConfigWriter?.setNetwork) return errorJson(context, 409, "not_supported", "IP settings are unavailable for this device or server");
    const input = await requestJson(context) as { address?: unknown; mac?: unknown } | undefined;
    if (!input || typeof input.address !== "string" || !isIPv4(input.address)
      || typeof input.mac !== "string" || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(input.mac)
      || Object.keys(input).some((key) => key !== "address" && key !== "mac")) {
      return errorJson(context, 400, "invalid_request", "Provide an IPv4 address and the device MAC address");
    }
    const address = input.address;
    const mac = input.mac.toLowerCase();
    if (target.mac && target.mac.toLowerCase() !== mac) return errorJson(context, 409, "invalid_request", "The selected MAC does not match this device's saved identity");
    if (site.devices.some((other) => other.id !== device.id && ((other.config as { host?: unknown }).host === address || site.macAddressOf(other.id)?.toLowerCase() === mac))) {
      return errorJson(context, 409, "invalid_request", "This IP or MAC is already configured for another HomeTruth device");
    }
    const addresses = networkRecovery.addressSettings();
    await deviceConfigWriter.setNetwork(device.id, address, mac, () => addresses.reserve(mac, address));
    if ((site.get(device.id)?.config as { host?: unknown })?.host !== address || site.macAddressOf(device.id)?.toLowerCase() !== mac) {
      return errorJson(context, 500, "reload_failed", "The reservation and file were saved, but HomeTruth could not load the updated device. Check the server log before reconnecting.");
    }
    data.reserveNetworkAddress(mac, address);
    let message = `Saved ${address} in HomeTruth and the DHCP reservation.`;
    try {
      await networkRecovery.reconnect({ ...target, address, mac });
      message += " Reconnect requested; allow a few seconds for the device to renew its address.";
    } catch (error) {
      message += ` The device could not be reconnected automatically: ${error instanceof Error ? error.message : String(error)}. Power-cycle it to renew its address.`;
    }
    deviceLogs.record(device.id, "network_address", message, { data: { associated: true, expected: address, mac } });
    return context.json({ address, mac, message });
  });

  /**
   * Find devices in the gateway's client table by their saved MAC, whatever
   * subnet DHCP put them on, and move devices.yml to match. No DHCP
   * reservation is made: a device that roams between networks gets whatever
   * address that network hands out, and the Settings tab is where an address
   * is pinned.
   */
  const applyRescan = async (targets: readonly DeviceNetworkTarget[]): Promise<RescanResult[]> => {
    const clients = await networkRecovery!.addressSettings().list();
    const located = await rescanDevices(targets, clients, async (id) => {
      try { await site.get(id)?.probe(); return true; } catch { return false; }
    });
    const results: RescanResult[] = [];
    for (const result of located) {
      if ((result.outcome !== "moved" && result.outcome !== "identified") || !result.mac) { results.push(result); continue; }
      const address = result.outcome === "moved" ? result.currentAddress! : result.address;
      try {
        await deviceConfigWriter!.setNetwork!(result.deviceId, address, result.mac);
        deviceLogs.record(result.deviceId, "network_address", result.detail, {
          level: result.outcome === "moved" ? "warn" : "info",
          data: { associated: true, expected: address, current: address, mac: result.mac, matches: true },
        });
        results.push(result);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deviceLogs.record(result.deviceId, "network_error", `Could not update ${result.name}: ${detail}`, { data: { what: "rescan" } });
        results.push({ ...result, outcome: "failed", detail });
      }
    }
    console.log(JSON.stringify({ event: "network_rescan", message: summarizeRescan(results), moved: results.filter((result) => result.outcome === "moved").map((result) => result.deviceId) }));
    return results;
  };
  const RESCAN_UNAVAILABLE = "Rescan needs a managed network and a writable device configuration";

  app.post("/api/network/rescan", async (context) => {
    if (!networkRecovery || !deviceConfigWriter?.setNetwork) return errorJson(context, 409, "not_supported", RESCAN_UNAVAILABLE);
    const results = await applyRescan(site.devices.map(networkTargetOf).filter((target): target is DeviceNetworkTarget => target !== undefined));
    return context.json({ message: summarizeRescan(results), results });
  });

  /** The same lookup for one device, from its Settings tab. */
  app.post("/api/devices/:id/network/rescan", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!networkRecovery || !deviceConfigWriter?.setNetwork) return errorJson(context, 409, "not_supported", RESCAN_UNAVAILABLE);
    const target = networkTargetOf(device);
    if (!target) return errorJson(context, 409, "not_supported", `${device.name} has no LAN address to look up`);
    const [result] = await applyRescan([target]);
    return context.json({ message: result!.detail, result });
  });

  /** Read association, addressing, and HomeTruth isolation without changing the network. */
  app.get("/api/devices/:id/network", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!networkRecovery) return errorJson(context, 409, "not_supported", "This server cannot inspect managed Wi-Fi clients");
    const target = networkTargetOf(device);
    if (!target) return errorJson(context, 409, "not_supported", `${device.name} has no direct LAN address to inspect`);
    let status;
    try {
      // Only the override destination comes from the snapshot. Rule states are
      // read fresh for this device, using its configured or currently observed MAC.
      const cloudHostnames = device.model.cloudHostnames ?? [];
      const isolationStatus = cloudHostnames.length ? (isolation?.snapshot() ?? await isolation?.refresh()) : undefined;
      status = await networkRecovery.inspect(target, {
        ...(isolation ? { isolationRequested: isolation.isIsolated(device.id) } : {}),
        dnsOverrides: cloudHostnames.map(domain => ({ domain, ...(isolationStatus?.overrideIp ? { overrideIp: isolationStatus.overrideIp } : {}) })),
      });
    } catch (error) {
      deviceLogs.record(device.id, "network_error", `Could not inspect ${device.name}: ${error instanceof Error ? error.message : String(error)}`, {
        data: { what: "Wi-Fi client lookup" },
      });
      throw error;
    }
    const fingerprint = `${status.associated}\0${status.currentAddress ?? ""}\0${status.addressMatches ?? ""}`;
    if (lastNetworkAddress.get(device.id) !== fingerprint) {
      lastNetworkAddress.set(device.id, fingerprint);
      deviceLogs.record(device.id, "network_address", status.message, {
        level: status.associated && status.addressMatches === false ? "warn" : "info",
        data: {
          associated: status.associated,
          expected: status.configuredAddress,
          ...(status.currentAddress ? { current: status.currentAddress } : {}),
          ...(status.mac ? { mac: status.mac } : {}),
          ...(status.addressMatches === undefined ? {} : { matches: status.addressMatches }),
        },
      });
    }
    return context.json(status);
  });

  /** Drop one managed Wi-Fi association so the device reconnects and runs DHCP again. */
  app.post("/api/devices/:id/network/reconnect", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", NO_DEVICE);
    if (!networkRecovery) return errorJson(context, 409, "not_supported", "This server cannot reconnect managed Wi-Fi clients");
    const target = networkTargetOf(device);
    if (!target) return errorJson(context, 409, "not_supported", `${device.name} has no direct LAN address to reconnect`);
    try {
      return context.json(await networkRecovery.reconnect(target));
    } catch (error) {
      deviceLogs.record(device.id, "network_error", `Could not reconnect ${device.name}: ${error instanceof Error ? error.message : String(error)}`, {
        data: { what: "Wi-Fi reconnect" },
      });
      throw error;
    }
  });

  app.post("/api/switches", async (context) => {
    if (!deviceConfigWriter) return errorJson(context, 409, "not_supported", "This HomeTruth instance has no writable device configuration");
    const input = await requestJson(context);
    if (!validators.optimisticSwitchCreateRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.optimisticSwitchCreateRequest.errors));
    }
    const request = input as OptimisticSwitchCreateRequest;
    if (site.get(request.id)) return errorJson(context, 409, "already_exists", `A device with id "${request.id}" already exists`);
    const choices = builderButtons();
    const onSource = choices.find((choice) => choice.reference === request.onButton);
    const offSource = choices.find((choice) => choice.reference === request.offButton);
    if (!onSource) return errorJson(context, 400, "invalid_request", "On must name an available Button or saved Broadlink command");
    if (!offSource) return errorJson(context, 400, "invalid_request", "Off must name an available Button or saved Broadlink command");
    const occupied = new Set([...site.devices.map((device) => device.id), request.id]);
    const additions: DeviceConfigEntry[] = [];
    const materialize = (source: BuilderButtonSource): string => {
      if (source.kind === "configured") return source.buttonId;
      const id = buttonIdFor(source, occupied);
      occupied.add(id);
      additions.push({ id, name: source.name, model: "action-button", config: { device: source.blasterId, savedCodeId: source.savedCodeId } });
      return id;
    };
    const onButton = materialize(onSource);
    const offButton = materialize(offSource);
    additions.push({
      id: request.id,
      name: request.name,
      ...(request.room ? { room: request.room } : {}),
      model: "optimistic-switch",
      config: {
        onButton,
        offButton,
        ...(request.initialState ? { initialState: request.initialState } : {}),
      },
    });
    await deviceConfigWriter.addAll(additions);
    const body: OptimisticSwitchCreateResponse = { id: request.id, page: site.view(request.id)?.page ?? devicePagePath(request.id) };
    return checkedJson(context, validators.optimisticSwitchCreateResponse, body, 201);
  });

  app.get("/api/switches/:id", (context) => switchJson(context, context.req.param("id")));
  app.get("/api/switches/:id/state", async (context) => {
    const device = site.get(context.req.param("id"));
    if (!device?.capability("binarySwitch")) return errorJson(context, 404, "not_found", "No switch with that id is defined in devices.yml");
    const document = (await describeDevice(device)).capabilities.binarySwitch!;
    context.header("Cache-Control", "no-store");
    return context.json(document.state);
  });
  app.post("/api/switches/:id/turn-on", (context) => switchJson(context, context.req.param("id"), "turnOn"));
  app.post("/api/switches/:id/turn-off", (context) => switchJson(context, context.req.param("id"), "turnOff"));
  app.post("/api/switches/:id/toggle", (context) => switchJson(context, context.req.param("id"), "toggle"));

  app.get("/api/buttons/:id", (context) => buttonJson(context, context.req.param("id")));
  app.post("/api/buttons/:id/press", async (context) => {
    const input = await requestJson(context);
    if (!validators.buttonPressRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.buttonPressRequest.errors));
    }
    const request = input as { durationMs?: number };
    return buttonJson(context, context.req.param("id"), request.durationMs === undefined ? {} : { durationMs: request.durationMs });
  });

  app.get("/api/buttons/:id/workflow", (context) => {
    const device = workflowButtonOf(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", "No Workflow Button with that id is defined in devices.yml");
    return context.json({ id: device.id, name: device.name, workflow: device.button.workflow, run: device.button.run, runs: device.button.runs });
  });

  app.put("/api/buttons/:id/workflow", async (context) => {
    if (!deviceConfigWriter?.setWorkflow) return errorJson(context, 409, "not_supported", "This HomeTruth instance has no writable device configuration");
    const device = workflowButtonOf(context.req.param("id"));
    if (!device) return errorJson(context, 404, "not_found", "No Workflow Button with that id is defined in devices.yml");
    const input = await requestJson(context);
    if (!validators.workflowButtonUpdateRequest(input)) return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.workflowButtonUpdateRequest.errors));
    const workflow = (input as WorkflowButtonUpdateRequest).workflow as unknown as WorkflowDefinition;
    try { validateWorkflowForSite(workflow); }
    catch (error) { return errorJson(context, 400, "invalid_workflow", error instanceof Error ? error.message : String(error)); }
    await deviceConfigWriter.setWorkflow(device.id, workflow);
    return context.json({ id: device.id, workflow });
  });

  app.post("/api/buttons", async (context) => {
    if (!deviceConfigWriter) return errorJson(context, 409, "not_supported", "This HomeTruth instance has no writable device configuration");
    const input = await requestJson(context);
    if (!validators.workflowButtonCreateRequest(input)) return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.workflowButtonCreateRequest.errors));
    const request = input as WorkflowButtonCreateRequest;
    if (site.get(request.id)) return errorJson(context, 409, "already_exists", `A device with id "${request.id}" already exists`);
    const workflow = (request.workflow ?? { start: "start", nodes: [{ id: "start", type: "end", label: "Complete" }] }) as unknown as WorkflowDefinition;
    try { validateWorkflowForSite(workflow); }
    catch (error) { return errorJson(context, 400, "invalid_workflow", error instanceof Error ? error.message : String(error)); }
    await deviceConfigWriter.add({
      id: request.id,
      name: request.name,
      ...(request.room ? { room: request.room } : {}),
      model: "workflow-button",
      config: { workflow },
    });
    return context.json({ id: request.id, page: site.view(request.id)?.page ?? `/buttons/${encodeURIComponent(request.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || request.id)}` }, 201);
  });

  app.get("/api/lights/:id", (context) => lightJson(context, context.req.param("id")));
  app.post("/api/lights/:id/turn-on", (context) => lightJson(context, context.req.param("id"), "turnOn"));
  app.post("/api/lights/:id/turn-off", (context) => lightJson(context, context.req.param("id"), "turnOff"));
  app.post("/api/lights/:id/toggle", (context) => lightJson(context, context.req.param("id"), "toggle"));

  app.post("/api/lights/:id/brightness", async (context) => {
    const id = context.req.param("id");
    const device = capabilityOf<Light>(id, "light");
    if (!device) return errorJson(context, 404, "not_found", "No light with that id is defined in devices.yml");
    const input = await requestJson(context);
    const percent = typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).percent
      : undefined;
    if (typeof percent !== "number") {
      return errorJson(context, 400, "invalid_request", "Brightness requires a numeric percent");
    }
    await device.setBrightness(percent);
    deviceLogs.record(id, "device_control", `${site.view(id)?.name ?? id}: setBrightness`, { data: { control: "setBrightness" } });
    return checkedJson(context, validators.light, (await describeDevice(site.get(id)!)).capabilities.light!);
  });

  app.post("/api/lights/:id/color-temperature", async (context) => {
    const id = context.req.param("id");
    const device = capabilityOf<Light>(id, "light");
    if (!device) return errorJson(context, 404, "not_found", "No light with that id is defined in devices.yml");
    const input = await requestJson(context);
    const kelvin = typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).kelvin
      : undefined;
    if (typeof kelvin !== "number") {
      return errorJson(context, 400, "invalid_request", "Color temperature requires a numeric kelvin value");
    }
    await device.setColorTemperature(kelvin);
    deviceLogs.record(id, "device_control", `${site.view(id)?.name ?? id}: setColorTemperature`, { data: { control: "setColorTemperature" } });
    return checkedJson(context, validators.light, (await describeDevice(site.get(id)!)).capabilities.light!);
  });

  app.post("/api/lights/:id/color", async (context) => {
    const id = context.req.param("id");
    const device = capabilityOf<Light>(id, "light");
    if (!device) return errorJson(context, 404, "not_found", "No light with that id is defined in devices.yml");
    if (!device.supportsColor()) return errorJson(context, 404, "not_found", "This light has no color control");
    const input = await requestJson(context);
    const hex = typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).hex
      : undefined;
    if (typeof hex !== "string" || !/^#[0-9A-Fa-f]{6}$/u.test(hex)) {
      return errorJson(context, 400, "invalid_request", 'Color requires a "#rrggbb" hex value');
    }
    await device.setColor(hex);
    deviceLogs.record(id, "device_control", `${site.view(id)?.name ?? id}: setColor`, { data: { control: "setColor" } });
    return checkedJson(context, validators.light, (await describeDevice(site.get(id)!)).capabilities.light!);
  });

  const NO_BLASTER = "No IR/RF blaster with that id is defined in devices.yml";
  const NO_SAVED_CODE = "No saved code with that id exists for this blaster";
  const FREQUENCY_IS_RF_ONLY = "frequencyHz applies only to the radio-frequency channel";

  const blasterOf = (id: string) => {
    const infrared = capabilityOf<InfraredBlaster>(id, "infraredBlaster");
    const radioFrequency = capabilityOf<RadioFrequencyBlaster>(id, "radioFrequencyBlaster");
    return infrared && radioFrequency ? { infrared, radioFrequency } : undefined;
  };

  const irRfBlasterJson = async (context: Context<AppEnvironment>, id: string) => {
    const device = blasterOf(id);
    if (!device) return errorJson(context, 404, "not_found", NO_BLASTER);
    const object = await describeDevice(site.get(id)!);
    const body = {
      infrared: object.capabilities.infraredBlaster,
      radioFrequency: object.capabilities.radioFrequencyBlaster,
      codes: [...await signalCodes.list(id)],
    };
    return checkedJson(context, validators.irRfBlasterDevice, body);
  };

  app.get("/api/ir-rf-blasters/:id", (context) => irRfBlasterJson(context, context.req.param("id")));

  const NO_NRF24_RECEIVER = "No ESP32 nRF24 radio receiver with that id is defined in devices.yml";
  const nrf24Receiver = (id: string) => site.as(id, Esp32Nrf24Bridge)?.receiver;
  const nrf24ReceiverJson = async (context: Context<AppEnvironment>, id: string, state?: Awaited<ReturnType<Esp32Nrf24Bridge["receiver"]["getState"]>>) => {
    const receiver = nrf24Receiver(id);
    if (!receiver) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    return context.json({ ...(state ?? await receiver.getState()), live: true, quiet: await receiver.quietStatus() ?? null,
      recording: receiver.captureStatus() ?? null, codes: [...await signalCodes.list(id)] });
  };
  app.get("/api/radio-receivers/:id", async (context) => {
    const id = context.req.param("id");
    try { return await nrf24ReceiverJson(context, id); }
    catch (error) {
      if (!(error instanceof Nrf24BridgeError) && !(error instanceof Nrf24RecordingError)) throw error;
      const receiver = nrf24Receiver(id);
      const cached = receiver?.cachedState();
      if (!cached) throw error;
      return context.json({ ...cached.state, live: false, lastSeenAt: cached.recordedAt,
        quiet: await receiver?.quietStatus() ?? null,
        connectionError: error instanceof Error ? error.message : "Radio bridge unavailable",
        recording: receiver?.captureStatus() ?? null, codes: [...await signalCodes.list(id)] });
    }
  });
  app.post("/api/radio-receivers/:id/quiet", async (context) => {
    const receiver = nrf24Receiver(context.req.param("id"));
    if (!receiver) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    const { validateQuietRequest } = await import("../protocols/nrf24-bridge/quiet-capture");
    let settings: ReturnType<typeof validateQuietRequest>;
    try { settings = validateQuietRequest(await requestJson(context)); }
    catch (error) { return errorJson(context, 400, "invalid_request", error instanceof Error ? error.message : String(error)); }
    const quiet = await receiver.startQuietCapture(settings);
    return context.json({ quiet }, 202);
  });
  app.post("/api/radio-receivers/:id/start", async (context) => {
    const id = context.req.param("id");
    const receiver = nrf24Receiver(id);
    if (!receiver) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    const input = await requestJson(context);
    if (!input || typeof input !== "object" || Array.isArray(input)) return errorJson(context, 400, "invalid_request", "Listener settings must be an object");
    const body = input as Record<string, unknown>;
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) {
      return errorJson(context, 400, "invalid_request", "Capture note must be text of at most 1000 characters");
    }
    const request = body.mode === "raw"
      && Number.isSafeInteger(body.channel) && (body.channel as number) >= 5 && (body.channel as number) <= 75
      && (body.crcBytes === 1 || body.crcBytes === 2)
      ? { mode: "raw" as const, channel: body.channel as number, crcBytes: body.crcBytes as 1 | 2 }
      : body.mode === "sweep" && body.durationMs === 30000 && body.crcBytes === 2
        ? { mode: "sweep" as const, durationMs: 30000 as const, crcBytes: 2 as const }
      : body.mode === undefined || body.mode === "energy"
        ? { mode: "energy" as const }
        : undefined;
    if (!request) return errorJson(context, 400, "invalid_request", "Use energy, raw (channel 5–75, CRC 1 or 2), or sweep (durationMs 30000, CRC 2)");
    const state = await receiver.startListening({ ...request, ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}) });
    deviceLogs.record(id, "device_control", `${site.view(id)?.name ?? id}: startListening`, { data: { control: "startListening" } });
    return nrf24ReceiverJson(context, id, state);
  });
  app.post("/api/radio-receivers/:id/stop", async (context) => {
    const id = context.req.param("id");
    const receiver = nrf24Receiver(id);
    if (!receiver) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    const state = await receiver.stopListening();
    deviceLogs.record(id, "device_control", `${site.view(id)?.name ?? id}: stopListening`, { data: { control: "stopListening" } });
    return nrf24ReceiverJson(context, id, state);
  });

  app.post("/api/radio-receivers/:id/codes", async (context) => {
    const id = context.req.param("id");
    const receiver = nrf24Receiver(id);
    if (!receiver) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    const input = await requestJson(context);
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100 || !Number.isSafeInteger(body.sequence) || (body.sequence as number) < 0) {
      return errorJson(context, 400, "invalid_request", "Saving requires a name and packet sequence");
    }
    const state = await receiver.getState();
    const packet = state.observations.find((observation) => observation.sequence === body.sequence);
    if (!packet || packet.kind !== "packet") return errorJson(context, 404, "not_found", "That captured packet is no longer available");
    if (!packet.crcValid) return errorJson(context, 409, "invalid_capture", "Only CRC-validated packet captures can be saved");
    if (packet.length === 0) return errorJson(context, 409, "invalid_capture", "This packet has no payload to save as a command");
    const code = encodeNrf24Code(packet, state.config.dataRateKbps);
    await signalCodes.add(id, {
      name,
      channel: "radio-frequency",
      code,
      frequencyHz: (2400 + packet.channel) * 1_000_000,
    });
    return nrf24ReceiverJson(context, id, state);
  });

  app.post("/api/radio-receivers/:id/codes/:codeId/send", async (context) => {
    const id = context.req.param("id");
    const receiver = nrf24Receiver(id);
    if (!receiver) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    const saved = (await signalCodes.list(id)).find((entry) => entry.id === context.req.param("codeId"));
    if (!saved) return errorJson(context, 404, "not_found", "No saved nRF24 code with that id exists");
    const input = await requestJson(context);
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const repeatCount = body.repeatCount ?? 1;
    if (!Number.isSafeInteger(repeatCount) || (repeatCount as number) < 1 || (repeatCount as number) > 20) {
      return errorJson(context, 400, "invalid_request", "repeatCount must be from 1 to 20");
    }
    let packet;
    try { packet = decodeNrf24Code(saved.code); }
    catch (error) { return errorJson(context, 409, "invalid_saved_code", error instanceof Error ? error.message : "Saved code is invalid"); }
    await receiver.transmit({ ...packet, repeatCount: repeatCount as number });
    deviceLogs.record(id, "device_control", `${site.view(id)?.name ?? id}: replayCode (${saved.name})`, { data: { control: "replayCode" } });
    return nrf24ReceiverJson(context, id);
  });

  app.post("/api/radio-receivers/:id/codes/:codeId/delete", async (context) => {
    const id = context.req.param("id");
    if (!nrf24Receiver(id)) return errorJson(context, 404, "not_found", NO_NRF24_RECEIVER);
    if (!(await signalCodes.remove(id, context.req.param("codeId")))) return errorJson(context, 404, "not_found", "No saved nRF24 code with that id exists");
    return nrf24ReceiverJson(context, id);
  });

  app.post("/api/ir-rf-blasters/:id/send", async (context) => {
    const id = context.req.param("id");
    const device = blasterOf(id);
    if (!device) return errorJson(context, 404, "not_found", NO_BLASTER);
    const input = await requestJson(context);
    if (!validators.irRfBlasterSendRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.irRfBlasterSendRequest.errors));
    }
    const request = input as IrRfBlasterSendRequest;
    const hold = request.durationMs ? { durationMs: request.durationMs } : {};
    if (request.channel === "infrared") await device.infrared.send(request.code, hold);
    else await device.radioFrequency.send(request.code, hold);
    return irRfBlasterJson(context, id);
  });

  app.post("/api/ir-rf-blasters/:id/learn", async (context) => {
    const id = context.req.param("id");
    const device = blasterOf(id);
    if (!device) return errorJson(context, 404, "not_found", NO_BLASTER);
    const input = await requestJson(context);
    if (!validators.irRfBlasterLearnRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.irRfBlasterLearnRequest.errors));
    }
    const request = input as IrRfBlasterLearnRequest;
    if (request.channel === "infrared" && request.frequencyHz !== undefined) {
      return errorJson(context, 400, "invalid_request", FREQUENCY_IS_RF_ONLY);
    }
    const timeout = request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {};
    const learned = request.channel === "infrared"
      ? await device.infrared.learn(timeout)
      : await device.radioFrequency.learn({ ...timeout, ...(request.frequencyHz !== undefined ? { frequencyHz: request.frequencyHz } : {}) });
    return checkedJson(context, validators.irRfBlasterLearnResponse, learned);
  });

  app.post("/api/ir-rf-blasters/:id/codes", async (context) => {
    const id = context.req.param("id");
    if (!blasterOf(id)) return errorJson(context, 404, "not_found", NO_BLASTER);
    const input = await requestJson(context);
    if (!validators.irRfBlasterSaveCodeRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.irRfBlasterSaveCodeRequest.errors));
    }
    const request = input as IrRfBlasterSaveCodeRequest;
    if (request.channel === "infrared" && request.frequencyHz !== undefined) {
      return errorJson(context, 400, "invalid_request", FREQUENCY_IS_RF_ONLY);
    }
    await signalCodes.add(id, request);
    return irRfBlasterJson(context, id);
  });

  app.post("/api/ir-rf-blasters/:id/codes/:codeId/send", async (context) => {
    const id = context.req.param("id");
    const codeId = context.req.param("codeId");
    const device = blasterOf(id);
    if (!device) return errorJson(context, 404, "not_found", NO_BLASTER);
    const saved = (await signalCodes.list(id)).find((entry) => entry.id === codeId);
    if (!saved) return errorJson(context, 404, "not_found", NO_SAVED_CODE);
    // The body is optional: an empty press uses the button's default hold.
    const input = await requestJson(context);
    if (!validators.irRfBlasterSendCodeRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.irRfBlasterSendCodeRequest.errors));
    }
    const press = input as IrRfBlasterSendCodeRequest;
    const durationMs = press.durationMs ?? saved.durationMs ?? 0;
    const hold = durationMs > 0 ? { durationMs } : {};
    if (saved.channel === "infrared") await device.infrared.send(saved.code, hold);
    else await device.radioFrequency.send(saved.code, hold);
    return irRfBlasterJson(context, id);
  });

  app.post("/api/ir-rf-blasters/:id/codes/:codeId/update", async (context) => {
    const id = context.req.param("id");
    const codeId = context.req.param("codeId");
    if (!blasterOf(id)) return errorJson(context, 404, "not_found", NO_BLASTER);
    const input = await requestJson(context);
    if (!validators.irRfBlasterUpdateCodeRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.irRfBlasterUpdateCodeRequest.errors));
    }
    if (!(await signalCodes.update(id, codeId, input as IrRfBlasterUpdateCodeRequest))) {
      return errorJson(context, 404, "not_found", NO_SAVED_CODE);
    }
    return irRfBlasterJson(context, id);
  });

  app.post("/api/ir-rf-blasters/:id/codes/:codeId/delete", async (context) => {
    const id = context.req.param("id");
    const codeId = context.req.param("codeId");
    if (!blasterOf(id)) return errorJson(context, 404, "not_found", NO_BLASTER);
    if (!(await signalCodes.remove(id, codeId))) return errorJson(context, 404, "not_found", NO_SAVED_CODE);
    return irRfBlasterJson(context, id);
  });

  app.get("/schemas", (context) => context.html(renderSchemaAdminPage({ ctx: pageContext(context) })));

  app.get("/schemas/*", (context) => {
    const path = new URL(context.req.url).pathname;
    const entry = schemaCatalogEntries.find(candidate => schemaPagePath(candidate.schema.$id) === path);
    if (!entry) return context.notFound();
    context.header("Cache-Control", "no-store");
    const schemaId = entry.schema.$id;
    const capabilityKind = Object.entries(CAPABILITY_KIND_SCHEMA_IDS).find(([, id]) => id === schemaId)?.[0];
    const instances = site.list().flatMap((device) => [
      ...(device.schemaId === schemaId ? [{ device }] : []),
      ...(capabilityKind && device.capabilities.includes(capabilityKind as CapabilityKind) && device.schemaId !== schemaId ? [{ device }] : []),
      ...(device.sensors ?? []).filter((sensor) => sensor.schemaId === schemaId).map((sensor) => ({ device, sensorName: sensor.name })),
    ]);
    return context.html(renderSchemaPage({ ctx: pageContext(context), entry: { ...entry, schemaId }, instances }));
  });

  app.get("/api/schemas", (context) => {
    const body: unknown = buildSchemaCatalogResponse();
    if (!validators.schemaCatalogResponse(body)) {
      throw new Error(
        `Invalid schema catalog response: ${describeValidationErrors(validators.schemaCatalogResponse.errors)}`,
      );
    }
    return checkedJson(context, validators.schemaCatalogResponse, body);
  });

  app.get("/api/health", (context) => {
    const body: HealthResponse = {
      status: "ok",
      runtime: { name: "bun", version: Bun.version },
      timestamp: new Date().toISOString(),
    };
    return checkedJson(context, validators.healthResponse, body);
  });

  app.route("/", tkenproRoutes(cameraService));
  app.route("/", sonosMediaRoutes());
  const dogAnnouncer = site.getService("dog-announcer");
  app.get("/automations", context => {
    context.header("Cache-Control", "no-store");
    const dog = dogAnnouncer instanceof DogAnnouncer ? dogAnnouncer.view() : undefined;
    const ctx = pageContext(context);
    return context.html(renderAutomationsPage(ctx, dog ? [{
      id: "dog-announcer", name: ctx.i18n.t("dog.title"),
      description: ctx.i18n.t("dog.intro"),
      status: !dog.config.enabled ? "Paused" : dog.status.availability === "degraded" ? "Needs attention"
        : "Active",
    }] : []));
  });
  if (dogAnnouncer instanceof DogAnnouncer) {
    const publishAutomation = (service: Service) => {
      const target = service.switch;
      if (target) hub.observer.publishAutomation(service.id, automationSwitchDocument(service.id, service.title, target.enabled, service.status().availability, new Date().toISOString()));
    };
    app.route("/", dogRoutes(dogAnnouncer, site, publishAutomation));
    app.route("/", automationSwitchRoutes(dogAnnouncer, publishAutomation));
  }

  // Last, and reading `app.routes` only when asked: the description is of the
  // app as it finally stands, including whatever was mounted conditionally
  // above and including these two routes themselves.
  app.route("/", openApiRoutes(site, () => app.routes, trustLocalNetwork));

  app.notFound((context) => errorJson(context, 404, "not_found", "Route not found"));

  app.onError((error, context) => {
    if (error instanceof FilterValidationError) return errorJson(context, 400, "invalid_filter", error.message.slice(0, 500));
    if (error instanceof FilterStoreError) return errorJson(context, error.code === "missing" ? 404 : error.code === "forbidden" ? 403 : 409, `filter_${error.code}`, error.message);
    if (error instanceof TagError) return errorJson(context, error.code === "missing" ? 404 : error.code === "conflict" ? 409 : 400, `tag_${error.code}`, error.message);
    if (error instanceof GoveeLanError) return errorJson(context, error.code === "invalid_host" ? 400 : 502, `govee_${error.code}`, error.message);
    if (error instanceof DeviceUnreachableError) return errorJson(context, 502, "unreachable", error.message);
    const cause = (error as { cause?: unknown }).cause;
    console.error(JSON.stringify({
      event: "request_error",
      errorType: error.name,
      requestId: context.get("requestId"),
      path: new URL(context.req.url).pathname,
      message: error.message,
      ...(cause instanceof Error
        ? { cause: `${cause.name}: ${cause.message}` }
        : cause !== undefined
          ? { cause: String(cause) }
          : {}),
    }));
    const vendorResponse = tkenproErrorResponse(error, context);
    if (vendorResponse) return vendorResponse;
    if (error instanceof NetworkAdapterError) {
      return errorJson(context, error.code === "not_configured" ? 409 : error.code === "not_supported" ? 409 : 502, error.code === "gateway_error" ? "camera_error" : "not_supported", error.message);
    }
    if (error instanceof CameraMediaError) {
      const status: ContentfulStatusCode = error.code === "invalid_uri" ? 400 : error.code === "unavailable" ? 503 : 502;
      return errorJson(context, status, `camera_media_${error.code}`, error.message);
    }
    if (error instanceof CapabilityError) {
      const status: ContentfulStatusCode = error.code === "unknown_control" ? 404 : error.code === "invalid_value" ? 400 : 409;
      return errorJson(context, status, error.code, error.message);
    }
    if (error instanceof DeviceError) {
      const status: ContentfulStatusCode = error.code === "no_such_capability" || error.code === "unknown_control" ? 404 : error.code === "ambiguous_control" ? 400 : 409;
      return errorJson(context, status, error.code, error.message);
    }
    if (error instanceof BinarySwitchError) {
      const status: ContentfulStatusCode = error.code === "invalid_host" ? 400 : 502;
      return errorJson(context, status, `switch_${error.code}`, error.message);
    }
    if (error instanceof HueClipError) {
      const status: ContentfulStatusCode = error.code === "not_found" ? 404 : error.code === "unreachable" ? 502 : 400;
      return errorJson(context, status, `hue_${error.code}`, error.message);
    }
    if (error instanceof LightError) {
      const status: ContentfulStatusCode = error.code === "invalid_host" ? 400 : error.code === "protocol" ? 400 : 502;
      return errorJson(context, status, `light_${error.code}`, error.message);
    }
    if (error instanceof IrRfBlasterError) {
      const status: ContentfulStatusCode = error.code === "invalid_host" || error.code === "protocol"
        ? 400
        : error.code === "learn_timeout"
          ? 504
          : 502;
      return errorJson(context, status, `ir_rf_blaster_${error.code}`, error.message);
    }
    if (error instanceof Nrf24BridgeError) {
      const status: ContentfulStatusCode = error.code === "invalid_url" ? 400 : error.code === "not_supported" ? 409 : 502;
      return errorJson(context, status, `nrf24_bridge_${error.code}`, error.message);
    }
    if (error instanceof Nrf24RecordingError) return errorJson(context, 507, "recording_failed", error.message);
    if (error instanceof SignalCodeStoreError) {
      const status: ContentfulStatusCode = error.code === "invalid" ? 400 : error.code === "full" ? 409 : 500;
      return errorJson(context, status, `saved_code_${error.code}`, error.message);
    }
    if (error instanceof DeviceConfigWriteError) {
      const status: ContentfulStatusCode = error.code === "duplicate" ? 409 : 400;
      return errorJson(context, status, `device_config_${error.code}`, error.message);
    }
    if (error instanceof RegionError) {
      const status: ContentfulStatusCode = error.code === "invalid_point" ? 400 : 400;
      return errorJson(context, status, `region_${error.code}`, error.message);
    }
    return errorJson(context, 500, "internal_error", "Unexpected server error");
  });

  return app;
}

const app = createApp();

export default app;
