import { healthValueSchema } from "../health/model";
/**
 * The catalog of event types a service can record.
 *
 * An event is not a log line with a free-text blob attached: every known
 * type has a schema for its `data`, so a reader (a person, a page, a
 * script) knows what a `motion` event carries without reading the code
 * that emitted it, and the UI can render each type in its own way — a
 * motion event as a thumbnail, a settings change as a property list — from
 * the type alone.
 *
 * Adding a type means adding it here. `EventLog.record()` validates `data`
 * against the type's schema and refuses an unknown type, so a typo becomes
 * a loud failure at the emitter rather than a silently malformed row.
 *
 * The schemas describe structural facts only. Nothing in this catalog
 * should ever carry a credential, a token, or captured payload bytes; the
 * rendering layer treats every value as untrusted text.
 */

import { eventSchema } from "./event-schema";

/** A JSON-Schema-shaped object; the same loose shape the device config schemas use. */
export type PayloadSchema = {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
  readonly type: "object";
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
};

export interface EventTypeDefinition {
  /** Stable identifier, `snake_case`, as it appears in `ServiceEvent.type`. */
  readonly id: string;
  /** Short human name for a filter menu, e.g. "Motion". */
  readonly label: string;
  /** One line saying what the event means, for the catalog page and tooltips. */
  readonly description: string;
  /** Level used when the emitter does not choose one. */
  readonly level: "info" | "warn" | "error";
  /**
   * How a page should present it. `plain` is the message alone;
   * `thumbnail` expects `data.thumbnailUrl`; `properties` expects
   * `data.changed`; `request` expects method/host/path.
   */
  readonly view: "plain" | "thumbnail" | "properties" | "request" | "network";
  /** The shape of this type's `data`. */
  readonly payloadSchema: PayloadSchema;
}

const text = (maxLength = 200) => ({ type: "string", maxLength } as const);
const count = { type: "integer", minimum: 0 } as const;
const confidence = { type: "number", minimum: 0, maximum: 1 } as const;
const timestamp = { type: "number", minimum: 0 } as const;
const zoneNames = { type: "array", maxItems: 100, items: text(128) } as const;

/**
 * Every event type HomeTruth records. Grouped by the thing that emits them,
 * but the ids are flat: an event names its type and its subject, never a
 * category.
 */
const definitions: readonly (Omit<EventTypeDefinition, "payloadSchema"> & { payloadSchema: Omit<PayloadSchema, "$schema" | "$id" | "title"> })[] = [
  {
    id: "health_checked", label: "Health", description: "A device or service health observation, recovery, or five-minute reminder of an ongoing problem. Repeated reports do not claim a new successful probe.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      ...healthValueSchema.properties, kind: { enum: ["device", "service"] }, id: text(200),
      source: { enum: ["poll", "report", "event", "repeat"] },
    }, required: ["status", "detail", "checkedAt", "kind", "id", "source"] },
  },
  {
    id: "filter_matched", label: "Filter matched", description: "A saved Filter matched a new Event. Contains the matching Filter's identity and revision and the unchanged source Event. Match events are never evaluated again.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      filterId: { type: "string", minLength: 1, maxLength: 100 },
      filterName: { type: "string", minLength: 1, maxLength: 200 },
      filterRevision: { type: "integer", minimum: 1 },
      event: { $ref: eventSchema.$id },
    }, required: ["filterId", "filterName", "filterRevision", "event"] },
  },
  {
    id: "state_binding", label: "State binding", description: "The state hub pointed at a site, or re-attached its push sources after a config reload.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { generation: text(200), devices: count, pushSources: count } },
  },
  {
    id: "state_stream", label: "State stream", description: "A page opened or closed its state stream, or was refused because the worker was at its limit.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { action: { enum: ["opened", "closed", "refused"] }, nodes: count, open: count, tier: { enum: ["live", "glance"] } } },
  },
  {
    id: "hue_proxy", label: "Hue proxy", description: "Hue bridge proxy lifecycle, delivery health, or a normalized light change.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      source: text(256), origin: { enum: ["bridge", "proxy", "entertainment"] }, target: text(), path: text(2000), method: text(20),
      on: { type: "boolean" }, brightnessPercent: { type: "number", minimum: 0, maximum: 100 }, color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, colorTemperatureKelvin: { type: "number", exclusiveMinimum: 0 }, transitionMs: count,
      // Pairing: how long this bridge accepts registrations, and what asked. Never the minted credential itself.
      windowMs: count, devicetype: text(80),
      // Entertainment relay teardown: which area, how many frames reached the real bridge, how long the session lived, and the DTLS cipher the client negotiated.
      area: text(80), frames: count, lifetimeMs: count, cipher: text(64),
    } },
  },
  {
    id: "camera_object", label: "Camera object", description: "A Frigate object track began, changed, or ended. Frigate times are Unix seconds; recordingStartTime is milliseconds. IDs identify tracks, not people.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      source: { const: "frigate" }, camera: text(128), objectId: text(128), phase: { enum: ["new", "update", "end"] },
      label: text(), confidence, frameTime: timestamp, startTime: timestamp, endTime: timestamp,
      currentZones: zoneNames, enteredZones: zoneNames, subLabel: text(), subLabelConfidence: confidence,
      recordingUrl: text(2000), recordingStartTime: timestamp,
      historical: { type: "boolean" },
    }, required: ["source", "camera", "objectId", "phase", "label", "confidence", "frameTime", "startTime", "currentZones", "enteredZones"] },
  },
  {
    id: "camera_classified", label: "Camera classification", description: "An enabled Frigate classifier added a label or attribute to an existing object track. frameTime is Unix seconds; recordingStartTime is milliseconds.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      source: { const: "frigate" }, camera: text(128), objectId: text(128), model: text(), label: text(), confidence,
      frameTime: timestamp, kind: { enum: ["sub_label", "attribute"] },
      recordingUrl: text(2000), recordingStartTime: timestamp,
    }, required: ["source", "camera", "objectId", "model", "label", "confidence", "frameTime", "kind"] },
  },
  {
    id: "photo_labeled", label: "Photo labeled", description: "A saved photo received AI labels, including historical imports. Numeric times are Unix milliseconds; capturedAt is unzoned camera-local text.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      source: { const: "reveal" }, eventId: text(64), photoId: text(64), camera: text(128), capturedAt: text(200), uploadedAt: timestamp,
      processedAt: timestamp, engine: text(), model: text(), modelHash: text(64), label: text(), confidence, uncertain: { type: "boolean" },
      detections: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false, properties: {
        label: text(), score: confidence, box: { type: "array", minItems: 4, maxItems: 4, items: confidence },
      }, required: ["label", "score", "box"] } },
    }, required: ["source", "eventId", "photoId", "camera", "processedAt", "engine", "model", "modelHash", "detections"] },
  },
  {
    id: "dog_detected", label: "Dog detected", description: "Frigate currently sees a dog.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      source: { const: "frigate" }, camera: text(128),
    }, required: ["source", "camera"] },
  },
  {
    id: "dog_announced", label: "Dog announced", description: "A Frigate dog detection triggered speech.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {
      source: { const: "frigate" }, camera: text(128), speakerId: text(128), text: text(100),
    }, required: ["source", "camera", "speakerId", "text"] },
  },
  {
    id: "automation_error", label: "Automation error", description: "An automation could not complete a check or action.", level: "error", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    id: "automation_recovered", label: "Automation recovered", description: "An automation check or action succeeded after an outage.", level: "info", view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  // --- Generic device lifecycle and controls ---
  {
    id: "availability_changed",
    label: "Availability changed",
    description: "A device became online, offline, degraded, or unknown.",
    level: "info",
    view: "plain",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        previous: { type: "string", enum: ["online", "offline", "degraded", "unknown"] },
        current: { type: "string", enum: ["online", "offline", "degraded", "unknown"] },
      },
      required: ["current"],
    },
  },
  {
    id: "device_control",
    label: "Control sent",
    description: "HomeTruth successfully invoked one of the device's controls.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { control: text(100) }, required: ["control"] },
  },
  {
    id: "device_reboot",
    label: "Device rebooted",
    description: "HomeTruth asked the device to reboot.",
    level: "warn",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    id: "device_enabled_changed",
    label: "Enabled changed",
    description: "A device was enabled or disabled from its Settings tab, the API, or the CLI.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
  },
  {
    id: "network_address",
    label: "Network address",
    description: "The managed network located a device, including an unexpected current address.",
    level: "info",
    view: "network",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        associated: { type: "boolean" },
        expected: text(253),
        current: text(253),
        mac: text(20),
        matches: { type: "boolean" },
      },
      required: ["associated", "expected"],
    },
  },
  {
    id: "network_reconnect",
    label: "Network reconnect",
    description: "HomeTruth asked the managed Wi-Fi network to reconnect a device so it renews DHCP.",
    level: "warn",
    view: "network",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: { expected: text(253), current: text(253), mac: text(20) },
      required: ["expected", "current", "mac"],
    },
  },

  // --- The MQTT broker ---
  {
    id: "started",
    label: "Started",
    description: "A service began running.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: true, properties: { hostname: text(60), port: count } },
  },
  {
    id: "stopped",
    label: "Stopped",
    description: "A service stopped.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: true, properties: {} },
  },
  {
    id: "client_connected",
    label: "Client connected",
    description: "An MQTT client connected to the broker.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { clientId: text(120) }, required: ["clientId"] },
  },
  {
    id: "client_disconnected",
    label: "Client disconnected",
    description: "An MQTT client disconnected.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { clientId: text(120) }, required: ["clientId"] },
  },
  {
    id: "message_published",
    label: "Message published",
    description: "A message was published to a topic on the broker.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { clientId: text(120), topic: text(250), bytes: count }, required: ["topic"] },
  },
  {
    id: "connection_rejected",
    label: "Connection rejected",
    description: "A client failed the broker's username and password check.",
    level: "warn",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { clientId: text(120) } },
  },

  // --- The local cloud emulator: a camera's own control channel ---
  {
    id: "connected",
    label: "Connected",
    description: "A camera opened a connection to the local cloud emulator.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { address: text(45) } },
  },
  {
    id: "registered",
    label: "Registered",
    description: "A camera proved its identity and registered with the emulator.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { uuid: text(64) }, required: ["uuid"] },
  },
  {
    id: "disconnected",
    label: "Disconnected",
    description: "A camera's connection to the emulator closed.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { uuid: text(64) } },
  },
  {
    id: "settings",
    label: "Settings changed",
    description: "A camera reported or confirmed changed property values.",
    level: "info",
    view: "properties",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        uuid: text(64),
        source: { type: "string", enum: ["sync", "response"] },
        /** The property codes that changed, as the firmware numbers them. */
        changed: { type: "array", maxItems: 200, items: { type: "string", maxLength: 20 } },
      },
      required: ["source", "changed"],
    },
  },
  {
    id: "heartbeat_extra",
    label: "Heartbeat extras",
    description: "A camera's heartbeat carried fields beyond its identity and routine runtime, time, and version metadata.",
    level: "info",
    view: "properties",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: { uuid: text(64), changed: { type: "array", maxItems: 50, items: text(60) } },
      required: ["changed"],
    },
  },
  {
    id: "unhandled_command",
    label: "Unhandled command",
    description: "A camera sent a protocol command the emulator has no handler for.",
    level: "info",
    view: "plain",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: { uuid: text(64), command: text(20), keys: { type: "array", maxItems: 50, items: text(60) } },
      required: ["command"],
    },
  },
  {
    id: "message",
    label: "Unrecognized push",
    description: "A camera pushed content the emulator does not recognize; its shape is recorded, never its payload.",
    level: "info",
    view: "plain",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: { uuid: text(64), cmd: text(60), method: text(60), action: text(60), keys: { type: "array", maxItems: 50, items: text(60) } },
    },
  },
  {
    id: "protocol_error",
    label: "Protocol error",
    description: "The emulator could not make sense of what a camera sent, or refused it.",
    level: "warn",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { uuid: text(64), address: text(45) } },
  },
  {
    id: "persistence_error",
    label: "Persistence error",
    description: "The emulator could not save a camera's state to disk.",
    level: "error",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: {} },
  },

  // --- The alarm path: what the camera would have sent its vendor ---
  {
    id: "motion",
    label: "Motion",
    description: "A camera detected motion and uploaded its thumbnail, which HomeTruth answered in the vendor's place.",
    level: "info",
    view: "thumbnail",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        /** Where the saved thumbnail can be fetched, when it was kept. */
        thumbnailUrl: text(400),
        /** The camera's own clock at the event, `YYYYMMDDhhmmss`. */
        eventTime: text(20),
        /** Length of the clip the camera recorded to its SD card, in seconds. */
        clipSeconds: { type: "number", minimum: 0 },
        decibel: { type: "number" },
        bytes: count,
        mediaId: text(80),
        uuid: text(64),
        /** The vendor's numeric event type, for kinds we have not named yet. */
        vendorEventType: { type: "integer" },
      },
      required: ["bytes"],
    },
  },
  {
    id: "alarm",
    label: "Other alarm",
    description: "A camera raised a detection alarm that is not motion (sound, or a kind not yet identified).",
    level: "info",
    view: "thumbnail",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        thumbnailUrl: text(400),
        eventTime: text(20),
        clipSeconds: { type: "number", minimum: 0 },
        decibel: { type: "number" },
        bytes: count,
        mediaId: text(80),
        uuid: text(64),
        vendorEventType: { type: "integer" },
      },
      required: ["bytes", "vendorEventType"],
    },
  },

  // --- What an isolated device does on the network ---
  {
    id: "cloud_request",
    label: "Cloud request",
    description: "A device made a request to a vendor hostname HomeTruth stands in for.",
    level: "info",
    view: "request",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: text(10),
        host: text(253),
        path: text(400),
        status: { type: "integer" },
        scheme: { type: "string", enum: ["http", "https"] },
        /** Which stand-in answered: an emulator of ours, or the vendor by way of the relay. */
        answeredBy: text(120),
        relayed: { type: "boolean" },
        requestBytes: count,
        responseBytes: count,
      },
      required: ["method", "host", "path"],
    },
  },
  {
    id: "dns_lookup",
    label: "DNS lookup",
    description: "A device asked a resolver for a hostname.",
    level: "info",
    view: "network",
    payloadSchema: { type: "object", additionalProperties: false, properties: { name: text(253), resolver: text(45), addresses: { type: "array", maxItems: 20, items: text(45) } }, required: ["name"] },
  },
  {
    id: "tls_attempt",
    label: "TLS attempt",
    description: "A device opened a TLS connection; the server name says who it thought it was reaching.",
    level: "info",
    view: "network",
    payloadSchema: { type: "object", additionalProperties: false, properties: { serverName: text(253), destination: text(45), port: count, accepted: { type: "boolean" } } },
  },
  {
    id: "connection",
    label: "Connection",
    description: "A device opened a TCP or UDP connection to an address.",
    level: "info",
    view: "network",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: { protocol: { type: "string", enum: ["tcp", "udp"] }, destination: text(45), port: count, resumed: { type: "boolean" }, blocked: { type: "boolean" }, note: text(120) },
      required: ["protocol", "destination", "port"],
    },
  },
  {
    id: "isolation_changed",
    label: "Isolation changed",
    description: "A device was cut off from the public internet, or released back to it.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { isolated: { type: "boolean" }, mac: text(20), hostnames: { type: "array", maxItems: 32, items: text(253) } }, required: ["isolated"] },
  },
  {
    id: "capture_changed",
    label: "Capture changed",
    description: "A packet capture of a device's traffic started, moved, or stopped.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { state: { type: "string", enum: ["started", "stopped", "moved", "waiting", "ended"] }, where: text(120) }, required: ["state"] },
  },
  {
    id: "network_error",
    label: "Network error",
    description: "A gateway rule, DNS record, or capture could not be applied.",
    level: "warn",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { what: text(120) } },
  },
  {
    id: "matter_state_changed",
    label: "Matter state changed",
    description: "A Matter subscription pushed a device's changed state, ahead of the next scheduled poll.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false, properties: { source: { type: "string", enum: ["matter"] } }, required: ["source"] },
  },
  {
    id: "matter_connection_degraded",
    label: "Matter connection degraded",
    description: "A Matter peer's subscription reported it is unreachable or not the expected hub.",
    level: "warn",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false },
  },
  {
    id: "matter_bridge",
    label: "Apple Home bridge",
    description: "The managed Matter bridge started, stopped, or changed availability.",
    level: "info",
    view: "plain",
    payloadSchema: { type: "object", additionalProperties: false },
  },
];

export const EVENT_TYPES: readonly EventTypeDefinition[] = definitions.map(definition => ({
  ...definition,
  payloadSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://hometruth.ai/schemas/event-payloads/${definition.id.replaceAll("_", "-")}`,
    title: `${definition.label} payload`,
    ...definition.payloadSchema,
  },
}));

const BY_ID = new Map(EVENT_TYPES.map((definition) => [definition.id, definition]));

export function eventType(id: string): EventTypeDefinition | undefined {
  return BY_ID.get(id);
}

/** Every type id, in catalog order; the filter menu's options. */
export function eventTypeIds(): readonly string[] {
  return EVENT_TYPES.map((definition) => definition.id);
}
