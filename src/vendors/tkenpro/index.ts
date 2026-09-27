import { networkEnvironment } from "../../network/config";
/**
 * The TKENPRO vendor at this site: the local cloud emulator the cameras
 * register with, the shared DNS-override state, the saved app account, the
 * discovered-camera inventory, and the camera service that ties them
 * together. One per process; every TKENPRO device is created over it.
 */
import { FileSecretStore, MemorySecretStore, type SecretStore } from "../../config/secrets";
import { cameraDnsTarget, createNetworkAdapter } from "../../network";
import { HttpsRelay } from "../../network/https-relay";
import type { NetworkIsolation } from "../../network/isolation";
import type { DevicesConfig } from "../../schemas";
import { SecretsCameraSetupStore, hostCredentialsSaver } from "./secrets";
import type { MeariLocalCloudEvent } from "../../protocols/tkenpro/cloud-emulator";
import { MeariLocalCloudRuntime } from "../../protocols/tkenpro/local-cloud-runtime";
import { MeariAlarmUploadInterceptor, type MeariAlarmEvent } from "./alarm-upload";
import { MeariLocalControlAdapter, createDefaultCameraService } from "./camera-adapters";
import type { CameraService } from "./camera-service";
import { createTkenproCloudServices, type MeariCloudEmulatorService, type TkenproCameraIdentity } from "./cloud-services";
import { FileCameraInventoryStore } from "./inventory-store";
import { CameraNetworkMode, IsolationNetworkMode } from "./network-mode";

declare global {
  // Survives `bun --hot` reloads so the previous emulator's listeners are closed first.
  var bunHonoLocalCloudRuntime: MeariLocalCloudRuntime | undefined;
}

export interface TkenproVendorOptions {
  readonly mode: "development" | "test" | "production";
  /** Configured addresses of the TKENPRO cameras at this site. */
  readonly cameraHosts: readonly string[];
  /** The site's secrets: the app account, each camera's ONVIF login, the router key. */
  readonly secrets?: SecretStore;
  /** The device config, so ONVIF logins saved from the settings form land under the right device. */
  readonly devicesConfig?: DevicesConfig;
  /**
   * The site's isolation service. With it, "local mode" is per camera (its
   * own gateway rule and capture), the alarm-upload interceptor is registered
   * for the cameras' bucket hostname, and a camera that is *not* isolated is
   * turned away by the emulator so it keeps using the vendor cloud.
   */
  readonly isolation?: NetworkIsolation;
  /** Where intercepted alarms are relayed as `tkenpro/<device id>` messages. */
  readonly mqttBroker?: { publish(topic: string, payload: string): Promise<void> };
}

export interface TkenproVendor {
  readonly cameraService: CameraService;
  readonly runtime: MeariLocalCloudRuntime | undefined;
  /** The emulator's own service plus one per configured camera; absent when the runtime did not start (e.g. test mode). */
  readonly cloudServices: MeariCloudEmulatorService | undefined;
  /** The alarm-upload interceptor; absent in test mode. */
  readonly alarms: MeariAlarmUploadInterceptor | undefined;
  stop(): Promise<void>;
}

/** The vendor's HTTPS API the camera polls; relayed while isolated (see `startTkenproVendor`). */
export const TKENPRO_API_HOSTNAME = "apis-us-west.cloudedge360.com";

/** `tkenpro/<device id>`: where a camera's intercepted alarms are relayed on the site's broker. */
export function tkenproMqttTopic(deviceId: string): string {
  return `tkenpro/${deviceId}`;
}

/** The MQTT relay payload for one alarm: the same shape the Wyze Cam v3 publishes, plus the vendor's fields. */
export function alarmMqttPayload(deviceId: string, event: MeariAlarmEvent): string {
  return JSON.stringify({
    camera_id: deviceId,
    event: event.kind,
    event_type: event.eventType,
    timestamp: Math.floor(Date.parse(event.at) / 1_000),
    ...(event.eventTime ? { event_time: event.eventTime } : {}),
    ...(event.videoDurationSeconds !== undefined ? { duration_seconds: event.videoDurationSeconds } : {}),
    ...(event.decibel !== undefined ? { decibel: event.decibel } : {}),
    ...(event.mediaId ? { media_id: event.mediaId } : {}),
  });
}

export async function startTkenproVendor(options: TkenproVendorOptions): Promise<TkenproVendor> {

  const cameraHosts = [...options.cameraHosts];
  const secretStore = options.secrets ?? (options.mode === "test" ? new MemorySecretStore() : new FileSecretStore());
  const secretsFile = await secretStore.load();
  const devicesConfig: DevicesConfig = options.devicesConfig ?? { schemaVersion: 2 };
  await globalThis.bunHonoLocalCloudRuntime?.stop();
  let localCloudRuntime: MeariLocalCloudRuntime | undefined;
  let cloudServices: MeariCloudEmulatorService | undefined;
  let cameraServiceForRefresh: ReturnType<typeof createDefaultCameraService> | undefined;
  let localRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLocalCameraRefresh = (): void => {
    if (!cameraServiceForRefresh || !localCloudRuntime) return;
    if (localRefreshTimer) clearTimeout(localRefreshTimer);
    localRefreshTimer = setTimeout(() => {
      localRefreshTimer = undefined;
      if (!cameraServiceForRefresh || !localCloudRuntime) return;
      void cameraServiceForRefresh.attachRegistered().catch(() => undefined);
    }, 500);
  };
  if (options.mode !== "test") {
    try {
      // `cloudServices` needs `authorization.devices` (uuid ↔ host), which
      // only exists once the runtime is constructed, but `onEvent` must be
      // passed into that same constructor. Events cannot arrive before
      // `.start()` runs below, so a queue drained the instant the services
      // exist closes the gap without dropping anything.
      const pending: MeariLocalCloudEvent[] = [];
      let handle: ((event: MeariLocalCloudEvent) => void) | undefined;
      const isolation = options.isolation;
      localCloudRuntime = await MeariLocalCloudRuntime.create({
        ...(process.env.HOMETRUTH_LOCAL_CLOUD_AUTH
          ? { authPath: process.env.HOMETRUTH_LOCAL_CLOUD_AUTH }
          : {}),
        ...(process.env.HOMETRUTH_LOCAL_CLOUD_ADDRESS
          ? { advertisedHost: process.env.HOMETRUTH_LOCAL_CLOUD_ADDRESS }
          : {}),
        // A camera that is a site device but not isolated is turned away so it
        // falls back to the vendor cloud; a bootstrapped camera that is not in
        // devices.yml at all is still served, as before.
        ...(isolation ? {
          allowSource: (address: string) => {
            const device = isolation.deviceAt(address);
            return device === undefined || isolation.isIsolated(device.id);
          },
        } : {}),
        onEvent: (event) => {
          if (handle) handle(event);
          else pending.push(event);
          if (event.type === "registered" || event.type === "settings") scheduleLocalCameraRefresh();
        },
      });
      const camerasByHost = new Map(
        (devicesConfig.devices ?? [])
          .filter((entry) => (entry.config as { host?: unknown } | undefined)?.host)
          .map((entry) => [(entry.config as { host: string }).host, entry] as const),
      );
      const identities: TkenproCameraIdentity[] = localCloudRuntime.authorization.devices.flatMap((authorized) => {
        const entry = authorized.sourceAddress ? camerasByHost.get(authorized.sourceAddress) : undefined;
        return entry ? [{ deviceId: entry.id, name: entry.name ?? entry.id, uuid: authorized.uuid, host: authorized.sourceAddress! }] : [];
      });
      cloudServices = createTkenproCloudServices(identities);
      const emulatorService = cloudServices;
      handle = (event) => emulatorService.ingest(event);
      for (const event of pending.splice(0)) handle(event);
      await localCloudRuntime.start();
      globalThis.bunHonoLocalCloudRuntime = localCloudRuntime;
      console.log(JSON.stringify({ event: "local_camera_control_ready" }));
      if (isolation) {
        // When a camera stops being isolated, drop its emulator session so the firmware re-registers, is refused, and goes back to the vendor.
        const runtime = localCloudRuntime;
        isolation.onChange(() => {
          for (const address of runtime.cameraAddresses) {
            const device = isolation.deviceAt(address);
            if (device && !isolation.isIsolated(device.id) && runtime.dropSource(address)) {
              console.log(JSON.stringify({ event: "local_camera_released", host: address, deviceId: device.id }));
            }
          }
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({
        event: "local_camera_control_unavailable",
        message: /ENOENT/u.test(detail)
          ? "Local camera authorization has not been bootstrapped"
          : /EADDRINUSE|address already in use/iu.test(detail)
            ? "Local camera listeners could not start: a port is already in use (another HomeTruth server may still be running)"
            : "Local camera listeners could not start",
        detail,
      }));
    }
  }
  // The DNS override points at the address the local emulator advertises (the
  // interface that shares the cameras' subnet); HOMETRUTH_LOCAL_CLOUD_ADDRESS
  // overrides it. Which router API switches the record is the network adapter's
  // business (HOMETRUTH_NETWORK_ADAPTER; see src/network).
  const networkMode = options.mode === "test"
    ? undefined
    : options.isolation
      ? new IsolationNetworkMode(options.isolation, cameraHosts)
      : new CameraNetworkMode({
        target: () => cameraDnsTarget(localCloudRuntime ? { overrideIp: localCloudRuntime.advertisedHost } : {}),
        adapter: () => createNetworkAdapter(networkEnvironment(secretsFile)),
      });
  // The alarm-upload interceptor: registered with the isolation service so the
  // cameras' bucket hostname is answered here; alarms go to each camera's
  // motion sensor (through SiteServices.tkenpro.alarms), the link logs, and MQTT.
  let alarms: MeariAlarmUploadInterceptor | undefined;
  if (options.mode !== "test" && options.isolation) {
    const isolation = options.isolation;
    alarms = new MeariAlarmUploadInterceptor({ hears: (address) => isolation.isIsolatedAddress(address) });
    isolation.registerInterceptor(alarms);
    // The vendor's HTTPS API, relayed and recorded: the firmware treats an
    // unreachable API as a broken network and moves to its backup Wi-Fi
    // on supported firmware. Relay the vendor responses to preserve that
    // connectivity check, with each exchange kept under
    // .hometruth/captures/https/. Only works if the camera does not verify
    // the stand-in certificate; the isolation log says which.
    isolation.registerInterceptor(new HttpsRelay({
      hostnames: [TKENPRO_API_HOSTNAME],
      onExchange: (exchange) => {
        console.log(JSON.stringify({ event: "camera_api_relayed", host: exchange.hostname, method: exchange.method, path: exchange.path.slice(0, 120), status: exchange.status, source: exchange.source.address, ...(exchange.source.device ? { deviceId: exchange.source.device.id } : {}) }));
        cloudServices?.ingestNetwork({
          type: "cloud_request",
          message: `${exchange.method} ${exchange.hostname}${exchange.path.slice(0, 120)} relayed to the vendor (${exchange.status})`,
          data: { method: exchange.method, host: exchange.hostname, path: exchange.path.slice(0, 400), status: exchange.status, scheme: "https", answeredBy: "the vendor", relayed: true, requestBytes: exchange.requestBytes, responseBytes: exchange.responseBytes },
        }, exchange.source.address);
      },
    }));
    const broker = options.mqttBroker;
    alarms.onAlarm((event) => {
      const deviceId = cloudServices?.ingestAlarm(event) ?? options.isolation?.deviceAt(event.sourceAddress)?.id;
      console.log(JSON.stringify({ event: "camera_alarm", kind: event.kind, eventType: event.eventType, source: event.sourceAddress, ...(deviceId ? { deviceId } : {}), bytes: event.bytes }));
      if (broker && deviceId) {
        broker.publish(tkenproMqttTopic(deviceId), alarmMqttPayload(deviceId, event)).catch((error: unknown) => {
          console.warn(JSON.stringify({ event: "camera_alarm_publish_failed", deviceId, detail: error instanceof Error ? error.message : String(error) }));
        });
      }
    });
  }
  const cameraService = createDefaultCameraService(
    options.mode === "test" ? undefined : new SecretsCameraSetupStore(secretStore),
    localCloudRuntime ? new MeariLocalControlAdapter(localCloudRuntime) : undefined,
    options.mode === "test" ? undefined : new FileCameraInventoryStore(),
    cameraHosts,
    networkMode,
    // A test server must not touch the network: no broadcasts, no probes.
    { broadcast: options.mode !== "test", probe: options.mode !== "test" },
    { saveHostCredentials: hostCredentialsSaver(secretStore, devicesConfig) },
  );
  cameraServiceForRefresh = cameraService;
  await cameraService.restore({ connect: false });
  return {
    cameraService,
    runtime: localCloudRuntime,
    cloudServices,
    alarms,
    async stop() {
      if (localRefreshTimer) clearTimeout(localRefreshTimer);
      await cameraService.close();
      await localCloudRuntime?.stop();
      if (globalThis.bunHonoLocalCloudRuntime === localCloudRuntime) {
        globalThis.bunHonoLocalCloudRuntime = undefined;
      }
    },
  };
}
