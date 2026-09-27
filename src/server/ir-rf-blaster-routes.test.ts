import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { BroadlinkRm4Pro } from "../devices/blasters/broadlink-rm4-pro";
import { IrRfBlasterError, type LearnRequest, type LearnedSignal, type SendOptions, type SignalChannel, type SignalCode, type SignalTransmitter } from "../models/blaster";
import { MemorySignalCodeStore } from "../signal-code-store";
import { Site } from "../site";
import { validators } from "../validation";

class FakeBlaster implements SignalTransmitter {
  sent: { channel: SignalChannel; code: SignalCode; durationMs?: number }[] = [];
  learnRequests: LearnRequest[] = [];
  nextLearn: LearnedSignal | Error = { code: "AAA=" };
  reachable = true;

  async send(channel: SignalChannel, code: SignalCode, options: SendOptions = {}): Promise<void> {
    this.sent.push({ channel, code, ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}) });
  }

  async learn(request: LearnRequest): Promise<LearnedSignal> {
    this.learnRequests.push(request);
    if (this.nextLearn instanceof Error) throw this.nextLearn;
    return this.nextLearn;
  }

  async probe(): Promise<void> {
    if (!this.reachable) throw new IrRfBlasterError("unreachable", "protocol");
  }
}

function fixture() {
  const blaster = new FakeBlaster();
  const site = new Site([new BroadlinkRm4Pro({ id: "blaster", name: "Living room blaster" }, { host: "10.78.0.30" }, { transmitter: blaster })]);
  const signalCodes = new MemorySignalCodeStore();
  const app = createApp(undefined, site, signalCodes);
  const json = (path: string, method = "GET", body?: unknown) => app.request(path, method === "GET"
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { app, json, blaster, signalCodes };
}

describe("IR/RF blaster routes", () => {
  test("GET returns the combined document with an empty codes list", async () => {
    const { json } = fixture();
    const response = await json("/api/ir-rf-blasters/blaster");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(validators.irRfBlasterDevice(body), JSON.stringify(validators.irRfBlasterDevice.errors)).toBe(true);
    expect((body as { codes: unknown[] }).codes).toEqual([]);
  });

  test("404s for an id that is not an IR/RF blaster", async () => {
    const { json } = fixture();
    const response = await json("/api/ir-rf-blasters/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("send dispatches to the right channel and returns the refreshed document", async () => {
    const { json, blaster } = fixture();
    const response = await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "infrared", code: "AAEC" });
    expect(response.status).toBe(200);
    expect(blaster.sent).toEqual([{ channel: "infrared", code: "AAEC" }]);

    await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "radio-frequency", code: "BBCD" });
    expect(blaster.sent[1]).toEqual({ channel: "radio-frequency", code: "BBCD" });
  });

  test("send forwards a hold and treats a zero hold as a single send", async () => {
    const { json, blaster } = fixture();
    expect((await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "infrared", code: "AAEC", durationMs: 2500 })).status).toBe(200);
    expect((await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "infrared", code: "AAEC", durationMs: 0 })).status).toBe(200);
    expect(blaster.sent).toEqual([{ channel: "infrared", code: "AAEC", durationMs: 2500 }, { channel: "infrared", code: "AAEC" }]);

    const tooLong = await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "infrared", code: "AAEC", durationMs: 60001 });
    expect(tooLong.status).toBe(400);
    const fractional = await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "infrared", code: "AAEC", durationMs: 1.5 });
    expect(fractional.status).toBe(400);
  });

  test("send rejects a malformed request", async () => {
    const { json } = fixture();
    const response = await json("/api/ir-rf-blasters/blaster/send", "POST", { channel: "infrared" });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  test("learn forwards the request and returns the captured signal", async () => {
    const { json, blaster } = fixture();
    blaster.nextLearn = { code: "ZZZZ" };
    const response = await json("/api/ir-rf-blasters/blaster/learn", "POST", { channel: "infrared", timeoutMs: 5000 });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(validators.irRfBlasterLearnResponse(body)).toBe(true);
    expect(body).toEqual({ code: "ZZZZ" });
    expect(blaster.learnRequests).toEqual([{ channel: "infrared", timeoutMs: 5000 }]);
  });

  test("learn on radio-frequency can pass a known frequency and returns the carrier used", async () => {
    const { json, blaster } = fixture();
    blaster.nextLearn = { code: "ZZZZ", frequencyHz: 433920000 };
    const response = await json("/api/ir-rf-blasters/blaster/learn", "POST", { channel: "radio-frequency", frequencyHz: 433920000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "ZZZZ", frequencyHz: 433920000 });
    expect(blaster.learnRequests).toEqual([{ channel: "radio-frequency", frequencyHz: 433920000 }]);
  });

  test("learn rejects frequencyHz on the infrared channel", async () => {
    const { json } = fixture();
    const response = await json("/api/ir-rf-blasters/blaster/learn", "POST", { channel: "infrared", frequencyHz: 433920000 });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { message: string } }).error.message).toMatch(/radio-frequency channel/);
  });

  test("learn maps a timeout to 504", async () => {
    const { json, blaster } = fixture();
    blaster.nextLearn = new IrRfBlasterError("No signal was captured within 100ms", "learn_timeout");
    const response = await json("/api/ir-rf-blasters/blaster/learn", "POST", { channel: "infrared" });
    expect(response.status).toBe(504);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("ir_rf_blaster_learn_timeout");
  });

  test("saves a code, lists it, sends it by id, and deletes it", async () => {
    const { json, blaster } = fixture();
    const saveResponse = await json("/api/ir-rf-blasters/blaster/codes", "POST", {
      name: "TV power",
      channel: "infrared",
      code: "AAEC",
    });
    expect(saveResponse.status).toBe(200);
    const afterSave = await saveResponse.json() as { codes: { id: string; name: string }[] };
    expect(afterSave.codes).toHaveLength(1);
    const codeId = afterSave.codes[0]!.id;
    expect(afterSave.codes[0]!.name).toBe("TV power");

    const sendResponse = await json(`/api/ir-rf-blasters/blaster/codes/${codeId}/send`, "POST");
    expect(sendResponse.status).toBe(200);
    expect(blaster.sent).toEqual([{ channel: "infrared", code: "AAEC" }]);

    const deleteResponse = await json(`/api/ir-rf-blasters/blaster/codes/${codeId}/delete`, "POST");
    expect(deleteResponse.status).toBe(200);
    const afterDelete = await deleteResponse.json() as { codes: unknown[] };
    expect(afterDelete.codes).toEqual([]);
  });

  test("a saved button holds for its default, a press can override it, and the default can be changed", async () => {
    const { json, blaster } = fixture();
    const saveResponse = await json("/api/ir-rf-blasters/blaster/codes", "POST", { name: "Dim up", channel: "infrared", code: "AAEC", durationMs: 3000 });
    expect(saveResponse.status).toBe(200);
    const saved = (await saveResponse.json() as { codes: { id: string; durationMs?: number }[] }).codes[0]!;
    expect(saved.durationMs).toBe(3000);

    // Default hold with no body, and again with an empty JSON body.
    expect((await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/send`, "POST")).status).toBe(200);
    expect((await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/send`, "POST", {})).status).toBe(200);
    // Per-press override, including an explicit single send.
    expect((await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/send`, "POST", { durationMs: 500 })).status).toBe(200);
    expect((await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/send`, "POST", { durationMs: 0 })).status).toBe(200);
    expect(blaster.sent).toEqual([
      { channel: "infrared", code: "AAEC", durationMs: 3000 },
      { channel: "infrared", code: "AAEC", durationMs: 3000 },
      { channel: "infrared", code: "AAEC", durationMs: 500 },
      { channel: "infrared", code: "AAEC" },
    ]);

    const bad = await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/send`, "POST", { durationMs: -1 });
    expect(bad.status).toBe(400);

    const updated = await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/update`, "POST", { durationMs: 1200 });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { codes: { durationMs?: number }[] }).codes[0]!.durationMs).toBe(1200);

    const cleared = await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/update`, "POST", { durationMs: 0 });
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { codes: { durationMs?: number }[] }).codes[0]!.durationMs).toBeUndefined();

    expect((await json(`/api/ir-rf-blasters/blaster/codes/${saved.id}/update`, "POST", {})).status).toBe(400);
    expect((await json("/api/ir-rf-blasters/blaster/codes/nope/update", "POST", { durationMs: 1000 })).status).toBe(404);
  });

  test("saving a code rejects frequencyHz on the infrared channel", async () => {
    const { json } = fixture();
    const response = await json("/api/ir-rf-blasters/blaster/codes", "POST", {
      name: "Bad",
      channel: "infrared",
      code: "AAEC",
      frequencyHz: 433920000,
    });
    expect(response.status).toBe(400);
  });

  test("sending or deleting an unknown saved code 404s", async () => {
    const { json } = fixture();
    expect((await json("/api/ir-rf-blasters/blaster/codes/nope/send", "POST")).status).toBe(404);
    expect((await json("/api/ir-rf-blasters/blaster/codes/nope/delete", "POST")).status).toBe(404);
  });

  test("the device list reports the blaster's availability via probe", async () => {
    const { json, blaster } = fixture();
    const online = await (await json("/api/devices")).json() as { devices: { id: string; availability: string }[] };
    expect(online.devices).toEqual([{ id: "blaster", availability: "online" }].map((d) => expect.objectContaining(d)));

    blaster.reachable = false;
    const offline = await (await json("/api/devices")).json() as { devices: { id: string; availability: string }[] };
    expect(offline.devices[0]?.availability).toBe("offline");
  });
});
