import { HealthService } from "../health/service";
import { HealthStore } from "../health/store";
import { TagStore } from "../tags/store";
import { FilterStore } from "../models/filter-store";
import { FilterMatches } from "../models/filter-matches";
import { FileKindleConfigStore, MemoryKindleConfigStore } from "../kindle/store";
import { createApp } from "../server/app";
import { FileSignalCodeStore, MemorySignalCodeStore } from "../signal-code-store";
import { loadConfig } from "../config";
import { DEFAULT_DEVICES_CONFIG_PATH, DevicesConfigError, hostsForModel, loadDevicesConfig } from "../config/devices";
import { DEFAULT_SECRETS_PATH, FileSecretStore, MemorySecretStore } from "../config/secrets";
import { TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER } from "../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import type { DevicesConfig } from "../schemas";
import { createLiveSite } from "../live-site";
import type { SiteServices } from "../models/device";
import { MODELS } from "../registry";
import { DeviceNetworkRecovery, hometruthLanAddress, localAddressFor, type NetworkAdapter } from "../network";
import { NetworkIsolation, type IsolatableDevice, type IsolationObserver } from "../network/isolation";
import { WifiAdmissionService } from "../network/wifi-admission-service";
import { networkEnvironment } from "../network/config";
import { createNetworkAdapter } from "../network";
import { startTkenproVendor } from "../vendors/tkenpro";
import { importLegacySecrets } from "../vendors/tkenpro/secrets";
import { startMqttBroker, type MqttBroker } from "../vendors/mqtt-broker";
import { mqttBrokerOptions } from "../vendors/mqtt-broker/config";
import { MatterService } from "../vendors/aqara/matter-service";
import { AQARA_HUB_M2 } from "../devices/hubs/aqara-hub-m2";
import { DeviceEventLogs } from "../models/device-event-log";
import { EventBusForwarder } from "../event-bus";
import { createHueSiteService } from "../vendors/hue/site-service";
import { createRingSiteService } from "../vendors/ring/site-service";
import { HueProxySiteService } from "../integrations/hue-proxy/site-service";
import { GoveeReceiver } from "../vendors/govee/receiver";
import { createSonosMediaService } from "../vendors/sonos/site-service";
import { DogAnnouncer } from "../automations/dog-announcer";
import { FileDogConfigStore } from "../automations/dog-config";
import { dogSiteDependencies } from "../automations/dog-site";
import { MemoryOptimisticSwitchStateStore } from "../devices/composites/optimistic-switch";
import { FileDeviceConfigWriter } from "../config/device-writer";
import { FileMatterSettingsSource } from "../integrations/matter/settings";
import { MatterBridgeService } from "../integrations/matter/site-service";
import { RevealPhotoArchive } from "../vendors/reveal/photo-archive";
import { startRevealPhotoPolling } from "../vendors/reveal/polling";
import { FrigateFrameLabeler } from "../vendors/frigate/frame-labeler";
import { FrigateStillLabeler, frigateStillsConfig, RevealPhotoLabeling } from "../vendors/frigate/still-labeler";
import { FrigatePhotoImport, FrigatePhotoTarget, frigatePhotoImportConfig } from "../vendors/frigate/photo-import";
import { FrigateEvents, frigateEventsConfig } from "../vendors/frigate/events";
import { FrigateEventHistory } from "../vendors/frigate/event-history";
import { PhotoLabelEvents } from "../vendors/frigate/photo-events";
import { createFrigateSnapshots, frigateSnapshotsConfig } from "../vendors/frigate/snapshots";
import { createProtectPreviews, protectPreviewConfig } from "../vendors/frigate/protect-previews";
import { TactacamReveal } from "../devices/cameras/tactacam-reveal";
import { Esp32Nrf24Bridge } from "../devices/radio/esp32-nrf24-bridge";
import { startNrf24CapturePolling } from "../protocols/nrf24-bridge/polling";

import { Site } from "../site";
import { StateHub } from "../state/hub";
import { StateHubService } from "../state/service";
import { StatePersistence } from "../state/persistence";
import { DEFAULT_GRAPH_STORE_PATH, GraphStore } from "../graph/store";
import type { NodeId } from "../state/protocol";
import { deviceNode } from "../state/protocol";
import { createDefaultCameraService } from "../vendors/tkenpro/camera-adapters";
import { Lifecycle } from "./lifecycle";
import { DEFAULT_TOKEN_STORE_PATH, TokenStore } from "../auth/store";
import { trustsLocalNetwork } from "../auth/network";

export async function prepareApplication(port: number) {
  const config = loadConfig();
  const lifecycle = new Lifecycle();

  // Site devices come only from the git-ignored YAML file. In test mode the file
  // is read only when HOMETRUTH_DEVICES names one, keeping the suite deterministic.
  const devicesPath = process.env.HOMETRUTH_DEVICES ?? (config.mode === "test" ? undefined : DEFAULT_DEVICES_CONFIG_PATH);

  // Read and validate local configuration before admitting a replacement.
  let devicesConfig: DevicesConfig = { schemaVersion: 2 };
  if (devicesPath) {
    try {
      devicesConfig = await loadDevicesConfig(devicesPath);
      console.log(JSON.stringify({ event: "devices_loaded", path: devicesPath, count: devicesConfig.devices?.length ?? 0 }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof DevicesConfigError && error.code === "missing") {
        console.warn(JSON.stringify({ event: "devices_config_missing", path: devicesPath }));
      } else {
        console.error(JSON.stringify({ event: "devices_config_invalid", path: devicesPath, detail }));
        throw error;
      }
    }
  }
  const cameraHosts = hostsForModel(devicesConfig, TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER.id);

  // Secrets live apart from the config. The first start with no secrets file
  // imports what .env.local and camera-setup.json used to hold, once.
  const secretStore = config.mode === "test" ? new MemorySecretStore() : new FileSecretStore(process.env.HOMETRUTH_SECRETS);
  if (config.mode !== "test" && !(await secretStore.exists())) {
    const written = await importLegacySecrets(secretStore, devicesConfig);
    if (written.length > 0) console.log(JSON.stringify({ event: "secrets_imported", path: DEFAULT_SECRETS_PATH, keys: written }));
  }
  const secretsFile = await secretStore.load();

  /**
   * API tokens. One store for the worker's whole life, shared by the preview
   * app and the live app, so a token issued a moment ago works while the site
   * is still starting up.
   *
   * A house with no tokens is a house nobody can get into, so the first start
   * mints one and prints it. That is the only occasion a whole token is written
   * to the log, and it is the same bargain Jupyter and Home Assistant strike:
   * whoever can read this console already started the process.
   */
  const tokens = new TokenStore(config.mode === "test" ? ":memory:" : process.env.HOMETRUTH_TOKENS_DB ?? DEFAULT_TOKEN_STORE_PATH);
  lifecycle.defer(() => tokens.close());
  /**
   * Test mode runs unguarded, the same bargain `createApp` documents: an
   * end-to-end browser has no token to present, and the guard's own behaviour
   * is covered against the real app in `src/auth/*.test.ts`. Every other mode
   * passes the store, so there is no path to an unguarded production server —
   * one built without it refuses every request rather than serving the house.
   */
  const enforce = config.mode === "test" ? undefined : tokens;
  if (enforce) {
    /**
     * A token is minted unasked only when one is actually needed to get in.
     * With the local network open, the console already has the run of the
     * house, so issuing a standing full-access credential nobody requested
     * would add a thing to leak and nothing to reach.
     */
    if (trustsLocalNetwork()) {
      console.log(JSON.stringify({
        event: "local_network_open",
        message: "Anyone on the local network has full access without a token. Set HOMETRUTH_TRUST_LAN=off to require one, and `ht tokens issue` for access from anywhere else.",
      }));
    } else if (!tokens.hasUsableToken()) {
      const first = tokens.issue({ name: "First token", permissions: ["admin"], subject: { all: true } });
      console.log(JSON.stringify({
        event: "first_token_issued",
        kid: first.record.kid,
        token: first.token,
        message: "HomeTruth had no API tokens, so it issued this one. Sign in with it, issue narrower tokens for each client, then revoke it.",
      }));
    }
  }

  const hue = createHueSiteService(secretsFile);
  /**
   * Ring's cloud, when an account is configured. Not handed to the preview
   * site below: Ring drops an existing location socket when a second one
   * opens, so only the live site may hold one.
   */
  const ring = config.mode === "test" ? undefined : createRingSiteService(secretsFile, {
    store: secretStore,
    onError: message => console.error(JSON.stringify({ event: "ring_token_store_failed", message })),
  });
  const signalCodes = config.mode === "test" ? new MemorySignalCodeStore() : new FileSignalCodeStore();
  const optimisticSwitchStates = new MemoryOptimisticSwitchStateStore();
  const sonosMedia = createSonosMediaService(() => port);
  const previewCamera = createDefaultCameraService();
  const previewSite = Site.fromConfig(devicesConfig, {
    signalCodes, optimisticSwitchStates, sonosMedia,
    tkenpro: { cameraService: previewCamera },
    ...(hue ? { hue: { clip: hue.clip, session: hue.session } } : {}),
  }, secretsFile);
  lifecycle.defer(() => previewCamera.close());
  lifecycle.defer(() => Promise.allSettled(previewSite.devices.map(device => device.close?.())));
  lifecycle.defer(() => hue?.session.isConnected ? hue.session.disconnect() : undefined);
  lifecycle.defer(() => ring?.stop());
  // One state graph for the worker's whole life: the preview app binds it to the
  // preview site, activation rebinds it to the live site and drops the preview's records.
  const hub = new StateHub({ generation: process.env.HOMETRUTH_GENERATION ?? "dev" });
  // Enumerable like every other service: its own page, status line and log.
  const stateHub = new StateHubService(hub);
  lifecycle.defer(() => hub.stop());
  const filters = new FilterStore(config.mode === "test" ? ":memory:" : ".hometruth/filters.sqlite");
  lifecycle.defer(() => filters.close());
  const preview = createApp(previewCamera, previewSite, signalCodes, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub, enforce, undefined, filters);
  return {
    app: preview,
    stop: () => lifecycle.close(),
    async activate() {
      const filterMatches = new FilterMatches(filters);
      lifecycle.defer(() => filterMatches.stop());

      // One lazy network client is shared by isolation and explicit network
      // actions. Merely loading device status must never kick a Wi-Fi client.
      let networkAdapter: NetworkAdapter | undefined;
      const getNetworkAdapter = (): NetworkAdapter =>
        networkAdapter ??= createNetworkAdapter(networkEnvironment(secretsFile));
      const networkRecovery = config.mode === "test"
        ? undefined
        : new DeviceNetworkRecovery({ adapter: getNetworkAdapter });

      // The embedded MQTT broker for devices whose only local push signal is
      // publish (the Wyze Cam v3's Motion Guard; the pet cameras' intercepted
      // alarms). Not started in test mode, same as the local cloud runtime: tests
      // fake the broker per-device instead.
      let mqttBroker: MqttBroker | undefined;
      if (config.mode !== "test") {
        mqttBroker = await startMqttBroker(mqttBrokerOptions(Bun.env));
        lifecycle.defer(() => mqttBroker?.stop());
        console.log(JSON.stringify({ event: "mqtt_broker_started", port: mqttBroker.port, hostname: mqttBroker.hostname }));
      }

      // One continuous Matter connection per configured Aqara Hub M2 peer,
      // opened right now — this is what "connected to Matter at startup"
      // means — and never by the short-lived preview site: two Matter
      // controllers cannot hold the same peer's paired storage directory
      // open at once (src/vendors/aqara/matter.ts). A report pushes a fresh
      // read of the hub straight into the graph, and cascades (via the
      // existing uses/usedBy relationship, src/site.ts) to every sensor
      // bridged through it; not started in test mode.
      let matterService: MatterService | undefined;
      if (config.mode !== "test") {
        const matterPeerIds = (devicesConfig.devices ?? [])
          .filter(entry => entry.model === AQARA_HUB_M2.id && entry.enabled !== false)
          .flatMap(entry => { const peerId = (entry.config as { matterPeerId?: unknown }).matterPeerId; return typeof peerId === "string" ? [peerId] : []; });
        if (matterPeerIds.length) {
          // The graph read that reportChange() triggers is the source of truth for what changed;
          // this callback only needs to know a report arrived for this peer, not its content.
          // reportChange, not invalidate: the hub itself is what reported, so its own record is
          // re-read rather than merely rescheduled, and everything it bridges is re-read with it.
          matterService = new MatterService(matterPeerIds, (peerId, _state) => {
            const deviceId = (devicesConfig.devices ?? []).find(entry => entry.model === AQARA_HUB_M2.id && (entry.config as { matterPeerId?: unknown }).matterPeerId === peerId)?.id;
            if (!deviceId) return;
            hub.observer.reportChange(deviceId);
            const event = { at: new Date().toISOString(), level: "info" as const, type: "matter_state_changed", subject: deviceId, message: `${deviceId} updated via Matter subscription`, data: { source: "matter" } };
            filterMatches.accept(event);
            mqttBroker?.publishEvent(event).catch(() => undefined);
          });
          const service = matterService;
          lifecycle.defer(() => service.stop());
          console.log(JSON.stringify({ event: "matter_service_started", peers: matterPeerIds.length }));
        }
      }

      // Network isolation: every device with a LAN address can be switched onto
      // the isolation rule. Created before the vendors so they can register their
      // stand-ins; started after them so the listeners they need are up before a
      // device is kicked into re-resolving. It is not a service — see
      // src/network/isolation.ts — so what it observes about a device goes to
      // whichever service emulates that device's cloud (`observer`, wired below
      // once the vendors exist). Not in test mode (no gateway, no :80).
      let isolation: NetworkIsolation | undefined;
      // The vendor services do not exist when isolation is built, so its observer is
      // late-bound: it forwards to whichever service claims the device at that address.
      const isolationObservers: IsolationObserver[] = [];
      // Built before the stand-in listeners because it has to be reachable
      // through them: a Hue client goes to 80/443 whatever port discovery
      // advertised, and checks the certificate it finds on 443. Registered
      // even when credentials are missing, so setup errors are visible on
      // /services instead of hiding the service or stopping the site.
      const hueProxy = config.mode === "test" ? undefined : new HueProxySiteService({
        secrets: secretsFile,
        enabled: process.env.HUE_PROXY_ENABLED !== "0",
        ...(process.env.HUE_PROXY_CONFIG ? { configPath: process.env.HUE_PROXY_CONFIG } : {}),
        ...(process.env.HUE_PROXY_ADDRESS ? { address: process.env.HUE_PROXY_ADDRESS } : {}),
        ...(process.env.HUE_PROXY_HTTP_PORT ? { httpPort: Number(process.env.HUE_PROXY_HTTP_PORT) } : {}),
        ...(process.env.HUE_PROXY_HTTPS_PORT ? { httpsPort: Number(process.env.HUE_PROXY_HTTPS_PORT) } : {}),
      });
      if (config.mode !== "test") {
        const isolatable: IsolatableDevice[] = (devicesConfig.devices ?? []).flatMap((entry) => {
          if (entry.enabled === false) return [];
          const host = (entry.config as { host?: unknown } | undefined)?.host;
          if (typeof host !== "string" || !host) return [];
          const model = MODELS.find((candidate) => candidate.id === entry.model);
          return [{ id: entry.id, name: entry.name ?? entry.id, host, cloudHostnames: model?.cloudHostnames ?? [] }];
        });
        const hosts = isolatable.map((device) => device.host);
        isolation = new NetworkIsolation({
          devices: isolatable,
          observer: { observe: (address, event) => { for (const observer of isolationObservers) observer.observe(address, event); } },
          adapter: getNetworkAdapter,
          overrideIp: () => {
            const detected = localAddressFor(hosts);
            return hometruthLanAddress(detected ? { overrideIp: detected } : {});
          },
          httpPort: Number(Bun.env.HOMETRUTH_ISOLATION_HTTP_PORT ?? 80),
          tlsPort: Number(Bun.env.HOMETRUTH_ISOLATION_TLS_PORT ?? 443),
          ...(Bun.env.HOMETRUTH_ISOLATION_LISTEN_HOST ? { listenHost: Bun.env.HOMETRUTH_ISOLATION_LISTEN_HOST } : {}),
          reconcileOnStart: Bun.env.HOMETRUTH_ISOLATION_RECONCILE_ON_START !== "off",
          accessPointCapture: Bun.env.HOMETRUTH_ISOLATION_AP_CAPTURE !== "0",
          ...(hueProxy ? { handOff: (request) => hueProxy.serve(request), defaultCertificate: () => hueProxy.tlsIdentity() } : {}),
        });
        lifecycle.defer(() => isolation?.stop());
      }

      // Restore saved camera metadata and accept incoming registrations. No startup scan.
      const tkenpro = await startTkenproVendor({
        mode: config.mode,
        cameraHosts,
        secrets: secretStore,
        devicesConfig,
        ...(isolation ? { isolation } : {}),
        ...(mqttBroker ? { mqttBroker } : {}),
      });

      lifecycle.defer(() => tkenpro.stop());

      if (isolation) {
        // A camera's network behaviour is the emulator's business: it stands in for
        // that camera's cloud, so its log is where those events belong.
        if (tkenpro.cloudServices) {
          const emulator = tkenpro.cloudServices;
          isolationObservers.push({
            observe: (address, event) => {
              if (emulator.deviceIdAt(address) === undefined) return;
              emulator.ingestNetwork(event, address);
            },
          });
        }
        const service = isolation;
        lifecycle.background("network-isolation", () => service.start());
      }

      const govee = config.mode === "test" ? undefined : new GoveeReceiver();
      lifecycle.defer(() => govee?.close());
      lifecycle.defer(() => hueProxy?.stop());
      if (hue) console.log(JSON.stringify({ event: "hue_bridge_configured", host: hue.clip.host, entertainmentAreaId: hue.entertainmentAreaId }));

      const revealPhotos = config.mode === "test" ? undefined : new RevealPhotoArchive();
      lifecycle.defer(() => revealPhotos?.close());
      // Vendor settings load at startup; camera mappings attach upstream tracks to the site's device logs.
      const frigateConfig = config.mode === "test" ? undefined : frigateEventsConfig(secretsFile.vendors?.frigateEvents);
      const photoImportConfig = config.mode === "test" ? undefined : frigatePhotoImportConfig(secretsFile.vendors?.frigatePhotoImport);
      const snapshotConfig = config.mode === "test" ? undefined : frigateSnapshotsConfig(secretsFile.vendors?.frigateSnapshots);
      const previewConfig = config.mode === "test" ? undefined : protectPreviewConfig(secretsFile.vendors?.unifiProtect,
        frigateConfig?.recordings?.cameras, process.env.UNIFI_PROTECT_USERNAME, process.env.UNIFI_PROTECT_PASSWORD);
      const frigateEvents = mqttBroker && frigateConfig ? new FrigateEvents(mqttBroker, { ...frigateConfig, photoCameras: Object.values(photoImportConfig?.cameras ?? {}) }, Date.now,
        new FrigateEventHistory(process.env.HOMETRUTH_FRIGATE_HISTORY), snapshotConfig ? createFrigateSnapshots(snapshotConfig) : undefined,
        previewConfig ? createProtectPreviews(previewConfig) : undefined) : undefined;
      const photoImport = revealPhotos && photoImportConfig ? new FrigatePhotoImport(revealPhotos, new FrigatePhotoTarget(photoImportConfig),
        () => liveSite.site.devices.filter((device): device is TactacamReveal => device instanceof TactacamReveal && device.enabled)
          .filter(device => photoImportConfig.cameras[device.id]).map(device => ({ cameraId: device.config.cameraId, camera: photoImportConfig.cameras[device.id]! }))) : undefined;
      const photoLabelEvents = revealPhotos && mqttBroker ? new PhotoLabelEvents(revealPhotos,
        () => liveSite.site.devices.filter((device): device is TactacamReveal => device instanceof TactacamReveal && device.enabled)
          .map(device => ({ cameraId: device.config.cameraId, deviceId: device.id })),
        event => mqttBroker!.publishEvent(event), photoImport) : undefined;
      filterMatches.connect([...(frigateEvents ? [frigateEvents] : []), ...(photoLabelEvents ? [photoLabelEvents] : [])]);
      const frameLabelConfig = config.mode === "test" ? undefined : frigateStillsConfig(secretsFile.vendors?.frigateFrames);
      const dogAnnouncer = new DogAnnouncer({
        store: new FileDogConfigStore(process.env.HOMETRUTH_DOG_CONFIG),
        ...dogSiteDependencies(() => liveSite.site, frameLabelConfig ? new FrigateFrameLabeler(frameLabelConfig) : undefined, secretStore),
      });

      lifecycle.defer(() => frigateEvents?.stop());
      lifecycle.defer(() => photoLabelEvents?.stop());
      lifecycle.defer(() => dogAnnouncer.stop());

      const matterBridge = config.mode === "test" ? undefined : new MatterBridgeService({ port });
      const health = new HealthService({ store: new HealthStore(config.mode === "test" ? ":memory:" : ".hometruth/health.sqlite"),
        devices: () => liveSite.site.devices, services: () => liveSite.site.services });
      lifecycle.defer(() => health.stop());
      const siteServices: SiteServices = {
        health,
        ...(matterBridge ? { matterBridge } : {}),
        ...(hueProxy ? { hueProxy } : {}),
        ...(govee ? { govee } : {}),
        tkenpro: {
          cameraService: tkenpro.cameraService,
          ...(tkenpro.alarms ? { alarms: tkenpro.alarms } : {}),
          ...(tkenpro.cloudServices ? { emulator: { id: tkenpro.cloudServices.id, title: tkenpro.cloudServices.title } } : {}),
        },
        ...(mqttBroker ? { mqttBroker } : {}),
        ...(tkenpro.cloudServices ? { tkenproCloud: tkenpro.cloudServices } : {}),
        ...(hue ? { hue: { clip: hue.clip, session: hue.session } } : {}),
        ...(ring ? { ring } : {}),
        sonosMedia,
        signalCodes,
        optimisticSwitchStates,
        dogAnnouncer,
        filterMatches,
        ...(revealPhotos ? { revealPhotos } : {}),
        ...(frigateEvents ? { frigateEvents } : {}),
        ...(photoLabelEvents ? { photoLabelEvents } : {}),
        ...(matterService ? { matter: matterService } : {}),
        stateHub,
      };

      // Writers can replace the inventory immediately. Filesystem changes also
      // stage a fresh generation so vendor configuration and secrets reload together.
      const liveSite = createLiveSite({
        path: devicesPath ?? DEFAULT_DEVICES_CONFIG_PATH,
        initialConfig: devicesConfig,
        services: siteServices,
        secrets: secretsFile,
        onReload: ({ count }) => {
          console.log(JSON.stringify({ event: "devices_reloaded", path: devicesPath, count }));
          // New device instances: re-attach button push hooks and re-read what pages are watching.
          hub.observer.attach();
          health.reconcile();
          hub.observeAll();
          void hub.data.refresh().then(() => { reconcileState(); statePersistence?.watch(observableNodes); });
          stateHub.bound({ devices: liveSite.site.devices.length, pushSources: liveSite.site.devices.filter(device => device.watch).length });
          for (const device of liveSite.site.devices) hub.observer.invalidate(device.id);
        },
        onError: (error) => console.error(JSON.stringify({
          event: "devices_reload_failed",
          path: devicesPath,
          detail: error instanceof Error ? error.message : String(error),
        })),
      });
      lifecycle.defer(() => { liveSite.close(); return Promise.allSettled(liveSite.site.devices.map(device => device.close?.())); });
      const site = liveSite.site;

      // State persists with the graph, so a restart comes up live rather than
      // blank. Restoring happens before the first request is served: doing it
      // after a page had rendered would cause the very flash it removes. A
      // restored value is presented as last-known, not current, through the
      // staleness path the browser already has.
      const kindleConfig = config.mode === "test" ? new MemoryKindleConfigStore() : new FileKindleConfigStore(process.env.HOMETRUTH_KINDLE_CONFIG);
      const graphStore = config.mode === "test" ? undefined : new GraphStore(DEFAULT_GRAPH_STORE_PATH);
      const statePersistence = graphStore ? new StatePersistence(hub.graph, graphStore) : undefined;
      let observableNodes: NodeId[] = [];
      if (graphStore && statePersistence) lifecycle.defer(() => { statePersistence.stop(); graphStore.close(); });
      function reconcileState(): void {
        if (!graphStore || !statePersistence) return;
        const desired = hub.data.topology();
        const { added, matched, tombstoned } = graphStore.reconcile(desired.nodes(), desired.edges());
        observableNodes = [...new Set(desired.nodes().flatMap(node => node.stateNode ? [node.stateNode as NodeId] : []))];
        console.log(JSON.stringify({ event: "graph_reconciled", added, matched, tombstoned, nodes: desired.size, observable: observableNodes.length }));
      }
      const radioCapturePolling = config.mode === "test" ? undefined : startNrf24CapturePolling(
        () => site.devices.filter((device): device is Esp32Nrf24Bridge => device instanceof Esp32Nrf24Bridge && device.enabled).map(device => device.bridge),
        { onError: error => console.warn(JSON.stringify({ event: "radio_capture_poll_failed", detail: String(error) })) },
      );
      lifecycle.defer(() => radioCapturePolling?.stop());
      const revealPolling = revealPhotos ? startRevealPhotoPolling(() => site.devices.filter((device): device is TactacamReveal => device instanceof TactacamReveal && device.enabled)) : undefined;
      const stillLabelConfig = config.mode === "test" ? undefined : frigateStillsConfig(secretsFile.vendors?.frigateStills);
      const revealLabeling = revealPhotos && stillLabelConfig ? new RevealPhotoLabeling(revealPhotos, new FrigateStillLabeler(stillLabelConfig),
        () => site.devices.filter((device): device is TactacamReveal => device instanceof TactacamReveal && device.enabled).map(device => device.config.cameraId)) : undefined;
      lifecycle.defer(() => revealPolling?.stop());
      lifecycle.defer(() => revealLabeling?.stop());
      if (revealLabeling) {
        revealLabeling.start();
        console.log(JSON.stringify({ event: "reveal_photo_labeling_started", engine: "speciesnet" }));
      }
      const deviceConfigWriter = devicesPath
        ? new FileDeviceConfigWriter(devicesPath, () => liveSite.reload())
        : undefined;


      // MQTT is the default fan-out for every normalized HomeTruth event. Service
      // logs remain the authoritative per-service views, and device logs remain the
      // authoritative per-device views; the broker mirrors both so subscribers and
      // the broker page can observe the whole home through one event bus.
      const eventBus = new EventBusForwarder(mqttBroker, (error, event) => {
        console.warn(JSON.stringify({ event: "event_bus_publish_failed", type: event.type, ...(event.subject ? { subject: event.subject } : {}), detail: error instanceof Error ? error.message : String(error) }));
      });
      lifecycle.defer(() => eventBus.stop());
      const publishEvent = eventBus.publish;
      const deviceLogs = new DeviceEventLogs(200, undefined, event => { publishEvent(event); filterMatches.accept(event); });
      const eventBusUnsubscribers: (() => void)[] = [];
      lifecycle.defer(() => { for (const unsubscribe of eventBusUnsubscribers) unsubscribe(); });
      // Evaluate each original event once, independent of MQTT and browser subscriptions.
      // connect() subscribes to future events only; startup history is never evaluated.
      filterMatches.connect(site.services.filter(service => service.id !== mqttBroker?.id));
      if (mqttBroker) {
        for (const service of site.services) {
          // Photo labels publish through their durable outbox and acknowledge the broker callback themselves.
          if (service.id === mqttBroker.id || service === photoLabelEvents) continue;
          // Subscribe before replaying the snapshot so an event emitted during the
          // replay window is not lost. The snapshot contains only events that
          // existed before the subscription was attached.
          // Frigate history is durable UI history, not an outbox of new motion alerts.
          const backlog = service === frigateEvents ? [] : [...service.events()].reverse();
          eventBusUnsubscribers.push(service.subscribe(publishEvent));
          for (const event of backlog) publishEvent(event);
        }
      }
      if (photoLabelEvents) lifecycle.background("photo-label-events", async () => { await photoLabelEvents.prepare(); photoLabelEvents.start(); });
      const tags = new TagStore(config.mode === "test" ? ":memory:" : process.env.HOMETRUTH_TAGS_DB ?? ".hometruth/tags.sqlite");
      lifecycle.defer(() => tags.close());
      const app = createApp(
        tkenpro.cameraService,
        site,
        signalCodes,
        undefined,
        isolation,
        networkRecovery,
        deviceLogs,
        deviceConfigWriter,
        new FileMatterSettingsSource(),
        kindleConfig,
        config.mode === "test" ? undefined : new WifiAdmissionService(),
        tags,
        hub,
        enforce,
        graphStore,
        filters,
      );

      await hub.data.refresh();
      reconcileState();

      // After createApp, because binding the hub clears the graph: a restore or
      // a subscription set up before this point would be thrown away with it.
      // Still before the listener accepts a request, so no page ever renders
      // against an empty graph and then fills in.
      if (statePersistence && observableNodes.length) {
        const known = new Set(observableNodes);
        const restored = statePersistence.restore(node => known.has(node));
        statePersistence.watch(observableNodes);
        console.log(JSON.stringify({ event: "state_restored", nodes: restored }));
      }

      if (config.mode !== "test") { hub.observeAll(); health.start(); }

      if (hueProxy) lifecycle.background("hue-proxy", () => hueProxy.start());
      if (config.mode !== "test") lifecycle.background("dog-announcer", () => dogAnnouncer.start());
      if (matterBridge) {
        lifecycle.defer(() => matterBridge.stop());
        // Startup runs in its own child and never blocks the HTTP application becoming ready.
        matterBridge.start();
      }
      return app;
    },
  };
}
