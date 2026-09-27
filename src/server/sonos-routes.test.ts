import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { clearSayClips, registerSayClip, type SaySynthesizer } from "../devices/speakers/sonos/say";
import { SONOS } from "../devices/speakers/sonos";
import { Device, type DeviceIdentity } from "../models/device";
import { Speaker, SpeakerError, type SpeakerState } from "../models/speaker";
import { Site } from "../site";
import { validators } from "../validation";

/** A fake synthesizer so tests never spawn the real macOS `say` process. */
const fakeSynthesizeSayClip: SaySynthesizer = async () => new Uint8Array([1, 2, 3, 4]);

beforeEach(() => clearSayClips());

class FakeSpeaker extends Speaker {
  calls: string[] = [];
  reachable = true;
  private state: SpeakerState = {
    playback: "stopped",
    volumePercent: 30,
    muted: false,
    group: { coordinatorHost: "fake-speaker", isCoordinator: true, memberHosts: ["fake-speaker"] },
  };

  override supportsSay(): boolean {
    return true;
  }

  async play(): Promise<void> {
    this.calls.push("play");
    this.state = { ...this.state, playback: "playing" };
  }

  async pause(): Promise<void> {
    this.calls.push("pause");
    this.state = { ...this.state, playback: "paused" };
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    this.state = { ...this.state, playback: "stopped" };
  }

  async setVolume(percent: number): Promise<void> {
    this.calls.push(`setVolume:${percent}`);
    this.state = { ...this.state, volumePercent: percent };
  }

  async setMute(muted: boolean): Promise<void> {
    this.calls.push(`setMute:${muted}`);
    this.state = { ...this.state, muted };
  }

  async playUri(uri: string): Promise<void> {
    this.calls.push(`playUri:${uri}`);
  }

  override async say(text: string): Promise<void> {
    this.calls.push(`say:${text}`);
  }

  async joinGroup(coordinatorHost: string): Promise<void> {
    this.calls.push(`joinGroup:${coordinatorHost}`);
    this.state = { ...this.state, group: { coordinatorHost, isCoordinator: false } };
  }

  async leaveGroup(): Promise<void> {
    this.calls.push("leaveGroup");
    this.state = { ...this.state, group: { coordinatorHost: this.id, isCoordinator: true } };
  }

  async getState(): Promise<SpeakerState> {
    if (!this.reachable) throw new SpeakerError("unreachable", "unreachable");
    return this.state;
  }
}

/** A speaker device whose capability is a test double, matching the SONOS model. */
class FakeSpeakerDevice extends Device<{ host: string; group?: string }> {
  readonly model = SONOS;
  readonly capabilities;
  constructor(id: string, name: string, readonly speaker: FakeSpeaker, group?: string) {
    super(id, name, { host: "10.77.0.170", ...(group ? { group } : {}) });
    this.capabilities = { speaker };
  }
  async probe(): Promise<DeviceIdentity> {
    await this.speaker.getState();
    return {};
  }
}

function fixture() {
  const speaker = new FakeSpeaker("sonos1");
  const site = new Site([new FakeSpeakerDevice("sonos1", "Living room Sonos", speaker)]);
  const app = createApp(undefined, site);
  const json = (path: string, method = "GET", body?: unknown) => app.request(path, method === "GET"
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { app, json, speaker };
}

describe("speaker capability routes", () => {
  test("GET returns a schema-valid speaker document", async () => {
    const { json } = fixture();
    const response = await json("/api/devices/sonos1");
    expect(response.status).toBe(200);
    const body = await response.json() as { object: { capabilities: { speaker: unknown } } };
    expect(validators.speaker(body.object.capabilities.speaker), JSON.stringify(validators.speaker.errors)).toBe(true);
  });

  test("play/pause/stop dispatch to the capability", async () => {
    const { json, speaker } = fixture();
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/play", "POST", { value: null })).status).toBe(200);
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/pause", "POST", { value: null })).status).toBe(200);
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/stop", "POST", { value: null })).status).toBe(200);
    expect(speaker.calls).toEqual(["play", "pause", "stop"]);
  });

  test("setVolume and setMute pass their value through", async () => {
    const { json, speaker } = fixture();
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/setVolume", "POST", { value: 55 })).status).toBe(200);
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/setMute", "POST", { value: true })).status).toBe(200);
    expect(speaker.calls).toEqual(["setVolume:55", "setMute:true"]);
  });

  test("joinGroup and leaveGroup dispatch to the capability", async () => {
    const { json, speaker } = fixture();
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/joinGroup", "POST", { value: "10.77.0.171" })).status).toBe(200);
    expect((await json("/api/devices/sonos1/capabilities/speaker/controls/leaveGroup", "POST", { value: null })).status).toBe(200);
    expect(speaker.calls).toEqual(["joinGroup:10.77.0.171", "leaveGroup"]);
  });

  test("say dispatches with the text value", async () => {
    const { json, speaker } = fixture();
    const response = await json("/api/devices/sonos1/capabilities/speaker/controls/say", "POST", { value: "hello there" });
    expect(response.status).toBe(200);
    expect(speaker.calls).toEqual(["say:hello there"]);
  });

  test("unknown device id 404s", async () => {
    const { json } = fixture();
    const response = await json("/api/devices/nope/capabilities/speaker/controls/play", "POST", { value: null });
    expect(response.status).toBe(404);
  });

  test("the device list reports the speaker's availability via getState", async () => {
    const { json, speaker } = fixture();
    const online = await (await json("/api/devices")).json() as { devices: { id: string; availability: string }[] };
    expect(online.devices).toEqual([{ id: "sonos1", availability: "online" }].map((d) => expect.objectContaining(d)));

    speaker.reachable = false;
    const offline = await (await json("/api/devices")).json() as { devices: { id: string; availability: string }[] };
    expect(offline.devices[0]?.availability).toBe("offline");
  });
});

describe("Sonos say clip route", () => {
  test("serves a registered clip as audio/wav", async () => {
    const { app } = fixture();
    const { path } = await registerSayClip("hello", fakeSynthesizeSayClip);
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("404s for an unknown clip id", async () => {
    const { app } = fixture();
    const response = await app.request("/local-media/say/00000000-0000-0000-0000-000000000000.wav");
    expect(response.status).toBe(404);
  });

  test("404s for a malformed filename", async () => {
    const { app } = fixture();
    const response = await app.request("/local-media/say/../../etc/passwd");
    expect(response.status).toBe(404);
  });
});

describe("Sonos group page", () => {
  function groupFixture() {
    const left = new FakeSpeakerDevice("sonos-left", "Left", new FakeSpeaker("sonos-left"), "Living Room");
    const right = new FakeSpeakerDevice("sonos-right", "Right", new FakeSpeaker("sonos-right"), "Living Room");
    const kitchen = new FakeSpeakerDevice("sonos-kitchen", "Kitchen", new FakeSpeaker("sonos-kitchen"));
    const site = new Site([left, right, kitchen]);
    return { app: createApp(undefined, site) };
  }

  test("lists the group's members, not the standalone device", async () => {
    const { app } = groupFixture();
    const response = await app.request("/groups/living-room");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Living Room");
    expect(html).toContain('data-device-id="sonos-left"');
    expect(html).toContain('data-device-id="sonos-right"');
    expect(html).not.toContain('data-device-id="sonos-kitchen"');
  });

  test("404s for an unknown group slug", async () => {
    const { app } = groupFixture();
    const response = await app.request("/groups/nope");
    expect(response.status).toBe(404);
  });

  test("the devices page collapses the group's two devices into one card", async () => {
    const { app } = groupFixture();
    const response = await app.request("/devices");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/groups/living-room"');
    expect(html).not.toContain('href="/speakers/left"');
    expect(html).toContain('href="/speakers/kitchen"');
  });
});
