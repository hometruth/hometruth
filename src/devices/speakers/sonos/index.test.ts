import { beforeEach, describe, expect, test } from "bun:test";
import { SONOS, SonosDevice, SonosSpeaker } from "./index";
import { SpeakerError } from "../../../models/speaker";
import type { SonosFetch } from "../../../protocols/sonos/soap-client";
import { clearSayClips, type SaySynthesizer } from "./say";
import { validators } from "../../../validation";

/** A fake synthesizer so tests never spawn the real macOS `say` process. */
const fakeSynthesizeSayClip: SaySynthesizer = async () => new Uint8Array([0, 1, 2, 3]);

beforeEach(() => clearSayClips());

function soapResponse(bodyXml: string, status = 200): Response {
  return new Response(
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${bodyXml}</s:Body></s:Envelope>`,
    { status },
  );
}

/** A fetch stub speaking just enough Sonos SOAP for getState()/controls to work, tracking every SOAPACTION invoked. */
function fakeSonosFetch(overrides: Partial<Record<string, () => Response>> = {}): { fetch: SonosFetch; actions: string[] } {
  const actions: string[] = [];
  const fetchImpl: SonosFetch = async (input, init) => {
    const soapaction = new Headers(init?.headers).get("SOAPACTION") ?? "";
    const action = soapaction.split("#")[1]?.replace(/"$/u, "") ?? "";
    actions.push(action);
    if (overrides[action]) return overrides[action]!();
    if (String(input).endsWith("device_description.xml")) {
      return new Response("<root><device><UDN>uuid:RINCON_AAA01400</UDN></device></root>");
    }
    switch (action) {
      case "GetTransportInfo":
        return soapResponse("<u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus></u:GetTransportInfoResponse>");
      case "GetPositionInfo":
        return soapResponse("<u:GetPositionInfoResponse><Track>1</Track><TrackDuration>0:03:00</TrackDuration><TrackURI>http://host/clip.wav</TrackURI><RelTime>0:00:10</RelTime></u:GetPositionInfoResponse>");
      case "GetVolume":
        return soapResponse("<u:GetVolumeResponse><CurrentVolume>20</CurrentVolume></u:GetVolumeResponse>");
      case "GetMute":
        return soapResponse("<u:GetMuteResponse><CurrentMute>0</CurrentMute></u:GetMuteResponse>");
      case "GetZoneGroupState": {
        const stateXml = `&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator="RINCON_AAA01400" ID="x"&gt;&lt;ZoneGroupMember UUID="RINCON_AAA01400" Location="http://10.77.0.170:1400/xml/device_description.xml"/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;`;
        return soapResponse(`<u:GetZoneGroupStateResponse><ZoneGroupState>${stateXml}</ZoneGroupState></u:GetZoneGroupStateResponse>`);
      }
      default:
        return soapResponse("<ok/>");
    }
  };
  return { fetch: fetchImpl, actions };
}

describe("SonosSpeaker", () => {
  test("supportsSay is true", () => {
    const { fetch } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });
    expect(speaker.supportsSay()).toBe(true);
  });

  test("play/pause/stop/setMute call through to the SOAP client", async () => {
    const { fetch, actions } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    await speaker.play();
    await speaker.pause();
    await speaker.stop();
    await speaker.setMute(true);

    expect(actions).toEqual(["Play", "Pause", "Stop", "SetMute"]);
  });

  test("setVolume rejects an out-of-range value", async () => {
    const { fetch } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    await expect(speaker.setVolume(150)).rejects.toThrow(SpeakerError);
    await expect(speaker.setVolume(-1)).rejects.toThrow(SpeakerError);
  });

  test("playUri sets the transport URI then plays", async () => {
    const { fetch, actions } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    await speaker.playUri("http://host/stream.mp3", { title: "Radio" });

    expect(actions).toEqual(["SetAVTransportURI", "Play"]);
  });

  test("say without a configured media base URL throws", async () => {
    const { fetch } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    await expect(speaker.say("hello")).rejects.toThrow(SpeakerError);
  });

  test("say registers a clip and plays its URL", async () => {
    const { fetch, actions } = fakeSonosFetch();
    let capturedUri: string | undefined;
    const overrideFetch: SonosFetch = async (input, init) => {
      const soapaction = new Headers(init?.headers).get("SOAPACTION") ?? "";
      if (soapaction.includes("SetAVTransportURI")) {
        capturedUri = /<CurrentURI>([^<]*)<\/CurrentURI>/u.exec(String(init?.body))?.[1];
      }
      return await fetch(input, init);
    };
    const speaker = new SonosSpeaker({
      id: "s1",
      host: "10.77.0.170",
      fetch: overrideFetch,
      localMediaBaseUrl: () => "http://10.77.0.50:3000",
      synthesizeSayClip: fakeSynthesizeSayClip,
    });

    await speaker.say("hello there");

    expect(actions).toContain("SetAVTransportURI");
    expect(capturedUri).toMatch(/^http:\/\/10\.77\.0\.50:3000\/local-media\/say\/[0-9a-f-]{36}\.wav$/u);
  });

  test("joinGroup resolves the coordinator's UUID then points itself at it", async () => {
    const { fetch, actions } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    await speaker.joinGroup("10.77.0.171");

    expect(actions).toEqual(["", "SetAVTransportURI", "Play"]);
  });

  test("leaveGroup becomes coordinator of a standalone group", async () => {
    const { fetch, actions } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    await speaker.leaveGroup();

    expect(actions).toEqual(["BecomeCoordinatorOfStandaloneGroup"]);
  });

  test("getState composes transport, position, volume, mute, and group", async () => {
    const { fetch } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    const state = await speaker.getState();

    expect(state).toEqual({
      playback: "playing",
      volumePercent: 20,
      muted: false,
      track: { uri: "http://host/clip.wav", durationSeconds: 180, positionSeconds: 10 },
      group: { coordinatorHost: "10.77.0.170", isCoordinator: true, memberHosts: ["10.77.0.170"] },
    });
  });

  test("getState() on a bonded satellite reports real volume/mute without throwing, even though AVTransport 500s", async () => {
    // A satellite's own GetZoneGroupState correctly names another speaker as
    // coordinator; its AVTransport calls (transport/track info) 500, as
    // observed on real bonded Sonos hardware, while RenderingControl
    // (volume/mute) still succeeds.
    const { fetch } = fakeSonosFetch({
      GetTransportInfo: () => new Response("", { status: 500 }),
      GetPositionInfo: () => new Response("", { status: 500 }),
      GetZoneGroupState: () => {
        const stateXml = `&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator="RINCON_COORDINATOR" ID="x"&gt;&lt;ZoneGroupMember UUID="RINCON_COORDINATOR" Location="http://10.77.0.142:1400/xml/device_description.xml"/&gt;&lt;ZoneGroupMember UUID="RINCON_AAA01400" Location="http://10.77.0.170:1400/xml/device_description.xml"/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;`;
        return soapResponse(`<u:GetZoneGroupStateResponse><ZoneGroupState>${stateXml}</ZoneGroupState></u:GetZoneGroupStateResponse>`);
      },
    });
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    const state = await speaker.getState();

    expect(state).toEqual({
      playback: "unknown",
      volumePercent: 20,
      muted: false,
      group: { coordinatorHost: "10.77.0.142", isCoordinator: false, memberHosts: ["10.77.0.142", "10.77.0.170"] },
    });
  });

  test("describe() returns a schema-valid document", async () => {
    const { fetch } = fakeSonosFetch();
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch });

    const document = await speaker.describe();

    expect(validators.speaker(document), JSON.stringify(validators.speaker.errors)).toBe(true);
    expect(document.state.availability).toBe("online");
  });

  test("describe() reports offline when the speaker cannot be reached", async () => {
    const failingFetch: SonosFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const speaker = new SonosSpeaker({ id: "s1", host: "10.77.0.170", fetch: failingFetch });

    const document = await speaker.describe();

    expect(document.state).toEqual({ availability: "offline" });
  });

  test("invoke() dispatches say to the say control", async () => {
    const { fetch } = fakeSonosFetch();
    const speaker = new SonosSpeaker({
      id: "s1",
      host: "10.77.0.170",
      fetch,
      localMediaBaseUrl: () => "http://10.77.0.50:3000",
      synthesizeSayClip: fakeSynthesizeSayClip,
    });

    await speaker.invoke("say", "hi");
  });
});

describe("SONOS device", () => {
  test("model.create() builds a device with a speaker capability", () => {
    const { fetch } = fakeSonosFetch();
    const device = new SonosDevice({ id: "s1", name: "Living room" }, { host: "10.77.0.170" }, {}, { fetch });
    expect(device.capabilities.speaker).toBeDefined();
    expect(device.model.id).toBe("sonos");
  });

  test("expose() forwards play/pause directly onto the device", async () => {
    const { fetch, actions } = fakeSonosFetch();
    const device = new SonosDevice({ id: "s1", name: "Living room" }, { host: "10.77.0.170" }, {}, { fetch });

    // expose() attaches these onto the instance at runtime; the static
    // `CapabilityMethods` interface merge does not narrow the getter-typed
    // `methods`/`controlIds` arrays to literal keys, so call through the
    // declared merge type explicitly rather than relying on inference here.
    const forwarded = device as unknown as { play(): Promise<void>; pause(): Promise<void> };
    await forwarded.play();
    await forwarded.pause();

    expect(actions).toEqual(["Play", "Pause"]);
  });

  test("the sonosMedia service, when configured, reaches say() via the device", async () => {
    const { fetch, actions } = fakeSonosFetch();
    const device = new SonosDevice(
      { id: "s1", name: "Living room" },
      { host: "10.77.0.170" },
      { sonosMedia: { baseUrlFor: (host) => `http://10.77.0.50:3000#${host}` } },
      { fetch, synthesizeSayClip: fakeSynthesizeSayClip },
    );

    await (device as unknown as { say(text: string): Promise<void> }).say("hello");

    expect(actions).toContain("SetAVTransportURI");
  });

  test("probe() succeeds when the speaker responds", async () => {
    const { fetch } = fakeSonosFetch();
    const device = new SonosDevice({ id: "s1", name: "Living room" }, { host: "10.77.0.170" }, {}, { fetch });

    await expect(device.probe()).resolves.toEqual({ model: "Sonos speaker" });
  });
});
