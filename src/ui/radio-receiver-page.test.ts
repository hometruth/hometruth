import { expect, test } from "bun:test";
import type { RegisteredDevice } from "../site";
import { radioFrequencyReceiverSchema } from "../schemas";
import { RADIO_RECEIVER_API, renderRadioReceiverPage } from "./radio-receiver-page";
import { testPageContext } from "./test-context";

test("RF receiver page polls same-origin listener routes and distinguishes activity from decoded commands", () => {
  const device: RegisteredDevice = {
    id: "tmnt/radio", name: "TMNT radio", kind: "rf-receiver", model: "esp32-nrf24-bridge",
    modelTitle: "ESP32 nRF24 radio bridge", capabilities: ["radioFrequencyReceiver"],
    host: "http://radio.local", page: "/devices/tmnt%2Fradio", schemaId: radioFrequencyReceiverSchema.$id, enabled: true,
  };
  const html = renderRadioReceiverPage({ ctx: testPageContext(), device });
  expect(html).toContain('data-device-id="tmnt/radio"');
  expect(html).toContain("Recent channel activity");
  expect(html).toContain("It is not a decoded vehicle command");
  expect(html).toContain("Listen for codes");
  expect(html).toContain("Search all channels (30 s)");
  expect(html).toContain("Quiet capture · Wi-Fi off");
  expect(html).toContain("Control capture · Wi-Fi on");
  expect(html).toContain('id="quiet-channel"');
  expect(html).toContain('id="session-start"');
  expect(html).toContain('id="session-ready" type="checkbox"');
  expect(html).toContain('id="session-cue"');
  expect(html).toContain("Start full session · 20 s");
  expect(html).toContain("launcher empty");
  expect(html).toContain("physical button edges are NOT measured");
  expect(html).toContain("age > 3000");
  expect(html).toContain("sessionStatus = undefined");
  expect(html).toContain('value="40" selected>40 · 2440 MHz');
  expect(html).toContain('value="20000" selected>20 s');
  expect(html).not.toContain('value="10000" selected');
  expect(html).toContain('durationMs: Number(quietDuration.value)');
  expect(html).toContain('channel: quietChannel.value === "sweep" ? null : Number(quietChannel.value)');
  expect(html).toContain('quiet.durationMs / 1000');
  expect(html).toContain('id="quiet-status"');
  expect(html).not.toContain('ht.say(feedback, ht.t("radioReceiver.quietExpected"))');
  expect(html).toContain('id="quiet-profile"');
  expect(html).toContain('value="xn297-250"');
  expect(html).toContain('value="esb-2000"');
  expect(html).toContain('if (quietActive) bridgeLive = false');
  expect(html).toContain('id="sweep-status"');
  expect(html).toContain('id="capture-recording"');
  expect(html).toContain('id="capture-note"');
  expect(html).toContain("showing saved capture");
  expect(html).toContain("DISK RECORDING FAILED");
  expect(html).toContain('bridgeLive = state.live !== false');
  expect(html).toContain("Repeated addresses");
  expect(html).toContain("not verified TMNT commands");
  expect(html).toContain('mode: "sweep", durationMs: 30000, crcBytes: 2');
  expect(html).toContain("Save a captured code");
  expect(html).toContain("Replay transmits once at minimum power");
  const api = JSON.parse(/data-api="([^"]+)"/u.exec(html)?.[1]?.replaceAll("&quot;", '"') ?? "{}") as Record<string, string>;
  expect(api).toEqual(RADIO_RECEIVER_API);
  expect(Object.values(api).every((route) => route.startsWith("/api/radio-receivers/:id"))).toBe(true);
  // Syntax check generated inline JavaScript without starting a browser/server.
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)) {
    if (match[0].includes('type="application/json"')) continue;
    expect(() => new Function(match[1]!)).not.toThrow();
  }
});
