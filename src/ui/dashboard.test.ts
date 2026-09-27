import { describe, expect, test } from "bun:test";
import {
  CAMERA_DASHBOARD_API,
  DEFAULT_CAMERA_CAPABILITIES,
  renderCameraDashboardPage,
  type CameraDashboardModel,
} from "./dashboard";
import { testPageContext } from "./test-context";

const ctx = testPageContext();

const model: CameraDashboardModel = {
  setup: {
    configured: true,
    profile: "tkenpro",
    accountHint: 'r•••@example.com"><script>alert(1)</script>',
  },
  discovery: { status: "ready", message: "One local camera found." },
  devices: [
    {
      id: "pet-cam/one",
      name: 'Kitchen <Cam> "One"',
      model: "TkenPro Pet Feeder",
      firmware: "1.2.3",
      status: "online",
      stream: "available",
      snapshot: "unknown",
      capabilities: [
        { id: "video.flip", category: "video", label: "Flip picture", kind: "toggle", availability: "available", value: true },
        { id: "feed.portions", category: "feeding", label: "Dispense treats", kind: "treat", availability: "available", min: 1, max: 10 },
        { id: "camera.ptz", category: "movement", label: "Move camera", kind: "ptz", availability: "available" },
        { id: "camera.presets", category: "movement", label: "Saved views", kind: "presets", availability: "available", confirmation: "confirm", presets: [{ id: "7", label: "Food bowl" }] },
        { id: "device.wake", category: "advanced", label: "Wake camera", kind: "action", availability: "available", confirmation: "none" },
        { id: "audio.talk", category: "audio", label: "Talk", kind: "momentary", availability: "unavailable" },
        { id: "device.factoryReset", category: "advanced", label: "Factory reset", kind: "action", availability: "available", confirmation: "type-device-name", dangerous: true },
      ],
    },
  ],
  selectedDeviceId: "pet-cam/one",
};

describe("camera dashboard renderer", () => {
  test("renders a nonce-protected, escaped, capability-driven dashboard", () => {
    const html = renderCameraDashboardPage({ ctx: testPageContext({ nonce: 'nonce"><bad' }), model });

    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('nonce="nonce&quot;&gt;&lt;bad"');
    expect(html).toContain("Kitchen &lt;Cam&gt; &quot;One&quot;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toMatch(/<[^>]+\son(?:click|change|submit|pointerdown|pointerup|pointercancel)=/i);
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)="https?:\/\//i);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();

    expect(html).toContain('data-capability-card="video.flip"');
    expect(html).toContain('data-capability-card="audio.talk"');
    // Verified categories render as their own group, only for controls the camera reported.
    for (const category of ["video", "feeding"]) expect(html).toContain(`data-category="${category}"`);
    // Placeholders the camera never reported sit under Unverified, not among verified controls.
    const unverifiedStart = html.indexOf('data-category="unverified"');
    expect(unverifiedStart).toBeGreaterThan(0);
    expect(html.indexOf("Picture quality")).toBeGreaterThan(unverifiedStart);
    expect(html.indexOf('data-category="onvif"')).toBe(-1);
    expect(html).toContain(">Unverified<");
    expect(html).toContain('data-capability-card="device.factoryReset"');
  });

  test("keeps motion, feeding, credentials, and destructive actions safely gated", () => {
    const html = renderCameraDashboardPage({ ctx, model });

    expect(html).toContain('name="password" type="password"');
    expect(html).toContain('name="onvifPassword" type="password"');
    expect(html).toContain('name="onvifUsername" autocomplete="off" value="admin"');
    expect(html).toContain("never sent back to the browser");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");

    // Multi-portion dispensing is unreliable on the hardware, so no count input is offered.
    expect(html).not.toContain("data-treat-count");
    expect(html).not.toContain('type="number" inputmode="numeric" min="1" max="10"');
    expect(html).toContain('sendControl(button.dataset.capabilityId || "feed.portions", 1, true, false)');

    expect(html).toContain('addEventListener("pointerdown"');
    expect(html).toContain('addEventListener("pointerup"');
    expect(html).toContain('addEventListener("pointercancel"');
    expect(html).toContain('action: "stop", commandId: commandId()');
    expect(html).toContain("leaseMs: 3000");
    expect(html).toContain("keepalive: Boolean(keepalive)");

    // Destructive controls stay tagged and rendered disabled; the confirm-by-typing guard remains in the JS.
    expect(html).toContain('data-dangerous="true"');
    expect(html).toMatch(/data-capability-card="device\.factoryReset"[\s\S]*?disabled/);
    expect(html).toContain('window.prompt(t("cam.typeName"');
  });

  test("dispenses a single treat directly without a second confirmation", () => {
    const html = renderCameraDashboardPage({ ctx, model });

    expect(html).toContain('data-treat-button data-capability-id="feed.portions"');
    expect(html).toContain('control.addEventListener("click", () => { void dispenseTreat(control); })');
    expect(html).not.toContain("data-treat-confirmation");
    expect(html).not.toContain('window.confirm("Dispense "');
  });

  test("shows the device-specific dispense-sound control without a duplicate unknown fallback", () => {
    const vendorModel: CameraDashboardModel = {
      ...model,
      devices: [{
        ...model.devices[0]!,
        capabilities: [...model.devices[0]!.capabilities, { id: "meari.dispenseSound", category: "feeding", label: "Play sound when dispensing", kind: "toggle", availability: "available", value: true }],
      }],
    };
    const html = renderCameraDashboardPage({ ctx, model: vendorModel });

    expect(html).toContain('data-capability-card="meari.dispenseSound"');
    expect(html).not.toContain('data-capability-card="feed.sound"');
    // A vendor control keeps its own label; a catalogued id is localized.
    expect(html).toContain("Play sound when dispensing");
  });

  test("keeps the camera view and critical actions above the controls, in the icon bar", () => {
    const html = renderCameraDashboardPage({ ctx, model });

    expect(html).toContain('class="workspace"');
    expect(html).toContain('class="viewer"');
    expect(html).toContain('class="controls"');
    expect(html).toContain('class="icon-bar"');
    expect(html).toContain('data-treat-button data-capability-id="feed.portions"');
    // The Pet 3T pans only; no tilt arrows are offered.
    expect(html).toContain('data-ptz-direction="right"');
    expect(html).toContain('aria-label="Pan left"');
    // Pan buttons live in the icon bar under the picture, with the other actions.
    expect(html.indexOf('class="stage stage-frame"')).toBeLessThan(html.indexOf('data-ptz-direction="left"'));
    expect(html.indexOf('class="icon-bar"')).toBeLessThan(html.indexOf('data-ptz-direction="left"'));
    expect(html).not.toContain('id="device-select"');
    expect(html).toContain('id="snapshot-button"');
    expect(html).toContain('id="record-button"');
    expect(html).toContain('t("cam.snapshot.saved")');
    expect(html).toContain("new MediaRecorder(stream");
    expect(html).toContain('recordButton.textContent = t(recording ? "action.stop" : "cam.record")');
    expect(html).toContain("downloadBlob(blob, \"recording\"");
    expect(html).toContain('id="listen-button"');
    expect(html).toContain('id="viewer-audio"');
    expect(html).toContain(".viewer { position: sticky;");
  });

  test("wires saved-view recall, save, and confirmed deletion", () => {
    const html = renderCameraDashboardPage({ ctx, model });

    expect(html).toContain('data-preset-recall="7"');
    expect(html).toContain('data-preset-delete="7"');
    expect(html).toContain('aria-label="Delete saved view Food bowl"');
    expect(html).toContain('value = { action: "delete", presetId: remove.dataset.presetDelete }');
    expect(html).toContain("sendControl(capabilityId, value, confirmed, false)");
    expect(html).toContain('window.confirm(t("cam.preset.confirmDelete", { label: remove.dataset.presetLabel || "" }))');
    expect(html).toContain("if (save instanceof HTMLButtonElement || remove instanceof HTMLButtonElement)");
    expect(html).toContain("await post(api.discover, {})");
  });

  test("renders the firmware-compatible 16 by 9 motion-region editor", () => {
    const regionModel: CameraDashboardModel = {
      ...model,
      devices: [{
        ...model.devices[0]!,
        capabilities: [...model.devices[0]!.capabilities, { id: "meari.detectionRegion", category: "detection", label: "Detection region", kind: "region", availability: "available", region: { width: 16, height: 9, selectedCells: [0, 143] } }],
      }],
    };
    const html = renderCameraDashboardPage({ ctx, model: regionModel });

    expect(html.match(/data-region-cell="/g)).toHaveLength(144);
    expect(html).toContain('data-region-cell="0"');
    expect(html).toContain('data-region-cell="143"');
    expect(html).toContain("<output data-region-count>2</output> / 144");
    expect(html).toContain("await sendControl(save.dataset.capabilityId, { selectedCells }, false, false)");
    expect(html).toContain('data-region-save data-capability-id="meari.detectionRegion"');
  });

  test("renders the CloudEdge-compatible draggable polygon editor", () => {
    const polygonModel: CameraDashboardModel = {
      ...model,
      devices: [{
        ...model.devices[0]!,
        capabilities: [...model.devices[0]!.capabilities, {
          id: "meari.polygonDetectionRegion", category: "detection", label: "Polygon detection areas", kind: "polygon-region", availability: "available",
          polygonRegion: { maxPolygons: 6, pointCount: 8, polygons: [{ type: 1, points: [{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 50 }, { x: 60, y: 60 }, { x: 50, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 50 }] }] },
        }],
      }],
    };
    const html = renderCameraDashboardPage({ ctx, model: polygonModel });

    expect(html.match(/data-polygon-point="/g)).toHaveLength(8);
    expect(html).toContain('data-polygon-max="6"');
    expect(html).toContain('data-polygon-point-count="8"');
    expect(html).toContain('data-polygon-save data-capability-id="meari.polygonDetectionRegion"');
    expect(html).toContain("await sendControl(save.dataset.capabilityId, { polygons }, false, false)");
    expect(html).toContain('document.addEventListener("pointermove"');
  });

  test("renders wake as a safe action and refreshes discovery after requesting it", () => {
    const html = renderCameraDashboardPage({ ctx, model });

    expect(html).toContain('data-capability-card="device.wake"');
    expect(html).toContain('data-capability-id="device.wake"');
    expect(html).toContain('if (capabilityId === "device.wake")');
    expect(html).toContain('announce(t("cam.wake.sent"))');
    expect(html).toContain("await post(api.discover, {})");
  });

  test("surfaces discovery failures and supports targeted local scans", () => {
    const failedModel: CameraDashboardModel = {
      setup: { configured: false, profile: null },
      discovery: { status: "error", message: "ONVIF authorization failed <check password>" },
      devices: [],
      selectedDeviceId: null,
    };
    const html = renderCameraDashboardPage({ ctx, model: failedModel });

    expect(html).toContain('id="discovery-form"');
    expect(html).toContain('<details class="discovery-help" open>');
    expect(html).toContain("ONVIF authorization failed &lt;check password&gt;");
    expect(html).toContain('name="hosts"');
    expect(html).toContain('placeholder="10.77.0.42"');
    expect(html).toContain('name="cidrs"');
    expect(html).toContain('placeholder="10.77.0.0/24"');
    expect(html).toContain("Enable ONVIF directly through TKENPRO");

    expect(html).toContain("if (hosts.length > 0) body.hosts = hosts");
    expect(html).toContain("if (cidrs.length > 0) body.cidrs = cidrs");
    expect(html).toContain('discovery.status === "error"');
    expect(html).toContain('showDiscoveryMessage(message, "error")');
    expect(html).toContain('showSetupFeedback(message, "error")');
  });

  test("guides direct owner-authenticated ONVIF activation in one line, and the password-only follow-up", () => {
    const vendorModel: CameraDashboardModel = {
      setup: { configured: false, profile: null },
      discovery: { status: "ready", message: "Found 1 camera" },
      devices: [{
        id: "100000001",
        name: "Pet 3T · 100000001",
        model: "Pet 3T",
        firmware: "5.7.3",
        status: "online",
        stream: "unknown",
        snapshot: "unknown",
        capabilities: [
          { id: "local.discovery", category: "advanced", label: "Local network discovery", kind: "status", availability: "available", value: "Found at 10.77.0.147", readOnly: true },
          { id: "onvif.enabled", category: "onvif", label: "Local ONVIF access", kind: "status", availability: "unknown", value: "Supported; not connected", readOnly: true },
        ],
      }],
      selectedDeviceId: "100000001",
    };

    const html = renderCameraDashboardPage({ ctx, model: vendorModel });

    expect(html).toContain("Pet 3T · 100000001 is online at Found at 10.77.0.147");
    expect(html).toContain("tick Enable ONVIF, then save");
    expect(html).toContain("Enable ONVIF directly through TKENPRO");
    expect(html).toContain("App email or phone");
    expect(html).toContain("Save and connect");
    expect(html).toContain("await post(api.discover, {})");
    expect(html).toContain('announce(t("cam.onvifEnabled"))');
    expect(html).toContain('capabilityId: "onvif.enabled", value: true, confirmed: true');

    const passwordOnlyModel: CameraDashboardModel = structuredClone(vendorModel);
    const onvif = passwordOnlyModel.devices[0]?.capabilities.find((capability) => capability.id === "onvif.enabled");
    if (!onvif) throw new Error("expected ONVIF capability");
    onvif.value = "Enabled; password required";
    const passwordOnlyHtml = renderCameraDashboardPage({ ctx, model: passwordOnlyModel });
    expect(passwordOnlyHtml).toContain("with ONVIF enabled. Enter the local camera password (username admin) and save.");
    expect(passwordOnlyHtml).toContain('throw new Error(t("cam.setup.passwordRejected"))');
  });

  test("localizes catalogued capability labels and leaves vendor-only labels alone", () => {
    const de = renderCameraDashboardPage({ ctx: testPageContext({ locale: "de" }), model });
    expect(de).toContain('lang="de"');
    expect(de).toContain("Bild spiegeln");
    expect(de).not.toContain("Flip picture");
  });

  test("exports a complete default inventory and fixed same-origin API paths", () => {
    expect(DEFAULT_CAMERA_CAPABILITIES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(DEFAULT_CAMERA_CAPABILITIES.map((capability) => capability.id)).size).toBe(DEFAULT_CAMERA_CAPABILITIES.length);
    expect(DEFAULT_CAMERA_CAPABILITIES.find((capability) => capability.id === "feed.portions")).toMatchObject({ kind: "treat", min: 1, max: 1 });
    expect(DEFAULT_CAMERA_CAPABILITIES.find((capability) => capability.id === "device.wake")).toMatchObject({ kind: "action", category: "advanced" });
    for (const path of Object.values(CAMERA_DASHBOARD_API)) {
      expect(path).toStartWith("/api/camera/");
      expect(path).not.toContain("://");
    }
  });
});

describe("camera dashboard status line and network mode", () => {
  const withNetwork: CameraDashboardModel = {
    ...model,
    network: {
      mode: "local",
      dnsOverride: "on",
      domain: "usce.mearicloud.com",
      overrideIp: "10.77.0.231",
      resolvedTo: "10.77.0.231",
      checkedAt: "2026-09-05T03:00:00.000Z",
      canToggle: true,
    },
    devices: model.devices.map((device) => ({
      ...device,
      host: "10.77.0.164",
      connection: {
        via: "local",
        local: { state: "connected", detail: "Registered with the local emulator." },
        onvif: { state: "connected", detail: "RTSP on the LAN." },
        problems: [],
      },
    })),
  };

  test("renders one status line: status · route · DNS mode · activity, with a switch link", () => {
    const html = renderCameraDashboardPage({ ctx, model: withNetwork });
    expect(html).toContain('id="status-bar" role="status"');
    expect(html).toContain('data-base="Online · local emulator · DNS override on"');
    expect(html).toContain('id="network-mode-button"');
    expect(html).toContain('data-next-action="off"');
    expect(html).toContain(">Switch to cloud<");
    expect(html).toContain(CAMERA_DASHBOARD_API.network);
    // Registered locally in local mode: nothing to reconnect.
    expect(html).not.toContain('id="network-reconnect-button"');
    // Reboot is always offered for a camera with a known address.
    expect(html).toContain('id="camera-reboot-button"');
    expect(html).toContain(">Reboot camera<");
    expect(html).toContain(CAMERA_DASHBOARD_API.reboot);
    const waiting = renderCameraDashboardPage({
      ctx,
      model: {
        ...withNetwork,
        devices: withNetwork.devices.map((device) => ({ ...device, connection: { ...device.connection!, via: "onvif", local: { state: "waiting", detail: "Not registered." } } })),
      },
    });
    expect(waiting).toContain('id="network-reconnect-button"');
    expect(waiting).toContain(">Reconnect now<");
    expect(waiting).toContain(CAMERA_DASHBOARD_API.reconnect);
    expect(html).toContain("post(api.network, perDevice && requireDevice() ? { action, deviceId: deviceId() } : { action })");
    expect(html).not.toContain('id="problems"');
  });

  test("hides the switch link when UniFi cannot be reached and lists the reason once", () => {
    const html = renderCameraDashboardPage({
      ctx,
      model: { ...withNetwork, network: { ...withNetwork.network!, mode: "cloud", dnsOverride: "unavailable", canToggle: false, detail: "UniFi API key is not configured" } },
    });
    expect(html).not.toContain('id="network-mode-button"');
    expect(html).not.toContain('id="network-reconnect-button"');
    expect(html).toContain('data-base="Online · local emulator · DNS override off"');
    expect(html).toContain('id="problems"');
    expect(html.split("UniFi API key is not configured").length).toBe(2);
  });

  test("lists connection problems under the status line", () => {
    const html = renderCameraDashboardPage({
      ctx,
      model: {
        ...withNetwork,
        devices: withNetwork.devices.map((device) => ({
          ...device,
          connection: { via: "none", local: { state: "waiting" }, cloud: { state: "offline" }, problems: ["Not registered with the local emulator yet", "Vendor cloud reports the camera offline"] },
        })),
      },
    });
    expect(html).toContain('id="problems"');
    expect(html).toContain("<li>Not registered with the local emulator yet</li>");
    expect(html).toContain("<li>Vendor cloud reports the camera offline</li>");
  });

  test("renders the icon toolbar under the picture with a play/pause live toggle and pan-only movement", () => {
    const html = renderCameraDashboardPage({ ctx, model: withNetwork });
    expect(html).toContain('class="icon-bar"');
    expect(html).toMatch(/id="live-button" data-icon="(play|pause)" aria-pressed="(true|false)"/u);
    expect(html).toContain('id="snapshot-button" data-icon="camera"');
    expect(html).toContain('id="record-button" data-icon="record"');
    expect(html).toContain('id="listen-button" data-icon="speaker"');
    expect(html).toContain('id="talk-button" data-icon="mic"');
    expect(html).toContain('data-icon="treat" data-treat-button');
    expect(html).toContain('data-icon="left" data-ptz-direction="left"');
    // Glyphs are CSS-masked SVGs, not emoji.
    expect(html).toContain('.btn-icon[data-icon="play"]::before { -webkit-mask-image: url("data:image/svg+xml;utf8,');
    expect(html).not.toMatch(/data-icon="[^a-z"]/u);
    expect(html).not.toContain('data-ptz-direction="up"');
    expect(html).not.toContain('data-ptz-direction="down"');
    // The script narrates live-view progress into the status line and toggles the button.
    expect(html).toContain('setStatus(t("cam.live.connecting"), "busy")');
    expect(html).toContain('setStatus(t("cam.live.playing"), "ok")');
    expect(html).toContain('setStatus(t("cam.live.slow"), "warn")');
    expect(html).toContain("liveButton.dataset.icon = playing ?");
    expect(html).toContain("const stopLiveView = () => {");
  });

  test("keeps camera onboarding off the camera page once a camera exists", () => {
    const html = renderCameraDashboardPage({ ctx, model: withNetwork });
    expect(html).toContain('<details class="onboarding"><summary>Add or reconnect a camera</summary>');
    const empty = renderCameraDashboardPage({ ctx, model: { ...model, devices: [], selectedDeviceId: null } });
    expect(empty).not.toContain('class="onboarding"');
    expect(empty).toContain("Camera connection");
  });
});

describe("the camera page's Events tab", () => {
  const types = [
    { id: "motion", label: "Motion", description: "Motion was detected.", level: "info" as const, view: "thumbnail" as const },
    { id: "registered", label: "Registered", description: "The camera registered.", level: "info" as const, view: "plain" as const },
  ];
  const withLog = {
    ...model,
    eventLog: { serviceId: "tkenpro-cloud-emulator", serviceTitle: "TKENPRO local cloud emulator", subject: "example-camera", types },
  };

  test("renders a tab pinned to this camera, pointing at the service that records its events", () => {
    const html = renderCameraDashboardPage({ ctx, model: withLog });
    expect(html).toContain('id="tab-events"');
    expect(html).toContain('id="panel-events"');
    expect(html).toContain('data-service-id="tkenpro-cloud-emulator"');
    expect(html).toContain('data-subject="example-camera"');
    expect(html).toContain('href="/services/tkenpro-cloud-emulator"');
  });

  test("offers the event-type filter but not a device filter: the tab is already one camera", () => {
    const html = renderCameraDashboardPage({ ctx, model: withLog });
    expect(html).toContain('id="filter-type"');
    expect(html).toContain('value="motion"');
    expect(html).not.toContain('id="filter-subject"');
  });

  test("a camera with no service recording its events shows no tab at all", () => {
    const html = renderCameraDashboardPage({ ctx, model });
    expect(html).not.toContain('id="tab-events"');
    expect(html).not.toContain('id="panel-events"');
  });
});
