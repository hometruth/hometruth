import { testPageContext } from "../../src/ui/test-context";
import { expect, test, type Page } from "@playwright/test";
import { renderServicePage } from "../../src/ui/services-page";
import { EVENT_TYPES } from "../../src/models/event-types";

test("all video results show object frames and REVEAL boxes stay aligned without cropping", async ({ page }) => {
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate", title: "Frigate camera labels", availability: "online", detail: "Ready", page: "/services/frigate", actions: [], endpoints: [] }, types: EVENT_TYPES,
  });
  const base = { at: "2026-09-12T20:00:00.000Z", level: "info" };
  const recordingUrl = `https://nvr.example.test/protect/timelapse/${"b".repeat(24)}?start=1789243200000`;
  const events = [
    ...["front", "yard", "pet"].map(camera => ({ ...base, type: camera === "pet" ? "camera_classified" : "camera_object", subject: camera, message: camera,
      data: { source: "frigate", camera, objectId: "track-" + camera, label: "person", recordingUrl } })),
    { ...base, type: "camera_object", subject: "gone", message: "Snapshot expired", data: { source: "frigate", camera: "gone", objectId: "gone", recordingUrl } },
    { ...base, type: "photo_labeled", subject: "reveal", message: "Two animals", data: { source: "reveal", photoId: "a".repeat(64), eventId: "photo-a", detections: [
      { label: "animal", score: 0.9, box: [0.1, 0.2, 0.4, 0.8] }, { label: "animal", score: 0.8, box: [0.5, 0.1, 0.9, 0.7] },
      { label: "invalid", score: 1, box: [0.8, 0, 0.2, 1] }, { label: "invalid", score: 1, box: [-1, 0, 1, 1] },
    ] } },
    { ...base, type: "photo_labeled", subject: "reveal", message: "Blank photo", data: { source: "reveal", photoId: "b".repeat(64), eventId: "photo-b", detections: [] } },
  ];
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/services/frigate", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate/events**", route => route.fulfill({ json: { events, labels: [], labelCounts: {} } }));
  await page.route("**/api/services/frigate/stream**", route => route.fulfill({ contentType: "text/event-stream", body: "" }));
  const fixtureImage = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#456"/></svg>';
  await page.route("**/api/services/frigate/frames/**", route => route.request().url().includes("/gone/")
    ? route.fulfill({ status: 404, body: "Snapshot unavailable" }) : route.fulfill({ contentType: "image/svg+xml", body: fixtureImage }));
  await page.route("**/api/cameras/reveal/photos/**", route => route.fulfill({ contentType: "image/svg+xml", body: fixtureImage }));
  await page.goto("/services/frigate");
  await expect(page.getByRole("img", { name: "Detection snapshot with bounding box" })).toHaveCount(3);
  await expect(page.locator(".event").filter({ hasText: "Snapshot expired" }).getByText("Snapshot unavailable. It may not be saved yet or may have expired.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Watch video in Protect ↗", exact: true })).toHaveCount(4);
  const photo = page.locator(".event").filter({ hasText: "Two animals" });
  await photo.scrollIntoViewIfNeeded();
  await expect(photo.locator("svg rect")).toHaveCount(2);
  await expect(photo.locator("svg rect").first()).toHaveAttribute("x", "10");
  await expect(photo.locator("svg rect").first()).toHaveAttribute("y", "20");
  await expect(photo.locator("svg rect").first()).toHaveAttribute("vector-effect", "non-scaling-stroke");
  const alignment = await photo.evaluate(node => {
    const image = node.querySelector("img")!.getBoundingClientRect();
    const box = node.querySelector("svg rect")!.getBoundingClientRect();
    return { aspect: image.width / image.height, x: (box.x - image.x) / image.width, y: (box.y - image.y) / image.height,
      width: box.width / image.width, height: box.height / image.height };
  });
  expect(alignment.aspect).toBeCloseTo(4 / 3);
  expect(alignment.x).toBeCloseTo(0.1); expect(alignment.y).toBeCloseTo(0.2);
  expect(alignment.width).toBeCloseTo(0.3); expect(alignment.height).toBeCloseTo(0.6);
  await expect(page.locator(".event").filter({ hasText: "Blank photo" }).locator("svg")).toHaveCount(0);
  await expect(photo.locator(".event-frame-link")).toHaveAttribute("href", `/api/cameras/reveal/photos/${"a".repeat(64)}`);
  // Missing images recover without losing the event or its recording link.
  await page.route("**/api/services/frigate/frames/gone/gone?retry=*", route => route.fulfill({ contentType: "image/svg+xml", body: fixtureImage }));
  await page.getByRole("button", { name: "Retry image" }).click();
  await expect(page.getByRole("img", { name: "Detection snapshot with bounding box" })).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("Frigate filters offer detection checkboxes and combine selections for history and live events", async ({ page }) => {
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate", title: "Frigate camera labels", availability: "online", detail: "Ready", page: "/services/frigate", actions: [], endpoints: [] },
    detectionLabels: ["person", "bobcat", "mule deer"], types: EVENT_TYPES,
  });
  const requests: string[][] = [];
  const streamRequests: string[][] = [];
  await page.route("**/services/frigate", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate/events**", route => {
    const selected = new URL(route.request().url()).searchParams.getAll("label"); requests.push(selected);
    return route.fulfill({ json: { labels: ["person", "bobcat", "mule deer", "coyote"], events: ["person", "bobcat", "mule deer"].filter(label => !selected.length || selected.includes(label))
      .map(label => ({ at: "2026-09-11T21:00:00.000Z", type: "camera_classified", level: "info", message: label, data: { label } })) } });
  });
  await page.route("**/api/services/frigate/stream**", route => {
    streamRequests.push(new URL(route.request().url()).searchParams.getAll("label"));
    return route.fulfill({ contentType: "text/event-stream", body: "" });
  });
  await page.goto("/services/frigate");
  await expect(page.getByRole("combobox", { name: "Event", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(4);
  await page.getByRole("checkbox", { name: "person", exact: true }).check();
  await expect(page.locator("#events .event")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "bobcat", exact: true }).check();
  await expect(page.locator("#events .event")).toHaveCount(2);
  expect(requests.at(-1)?.sort()).toEqual(["bobcat", "person"]);
  await expect.poll(() => streamRequests.at(-1)?.sort()).toEqual(["bobcat", "person"]);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.locator("#events .event")).toHaveCount(3);
  await expect(page.locator('input[name="detection"]:checked')).toHaveCount(0);
});

test("detection options follow the selected camera and show explicit zeros without losing checked filters", async ({ page }) => {
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate", title: "Frigate camera labels", availability: "online", detail: "Ready", page: "/services/frigate", actions: [], endpoints: [] },
    subjects: [{ id: "front", name: "Front" }, { id: "reveal", name: "REVEAL" }, { id: "offline", name: "Offline" }],
    detectionLabels: ["person", "car", "animal", "raccoon"], types: EVENT_TYPES,
  });
  const counts: Record<string, Record<string, number>> = { "": { person: 203, car: 2, animal: 588, raccoon: 588 },
    front: { person: 203, car: 2 }, reveal: { animal: 588, raccoon: 588 }, offline: {} };
  await page.route("**/services/frigate", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate/events**", route => {
    const params = new URL(route.request().url()).searchParams;
    const labelCounts = counts[params.get("subject") ?? ""]!;
    const selected = params.getAll("label");
    return route.fulfill({ json: { labels: Object.keys(counts[""]!), labelCounts,
      events: Object.keys(labelCounts).filter(label => !selected.length || selected.includes(label)).map(label => ({
        at: "2026-09-11T21:00:00.000Z", level: "info", type: "camera_classified", message: label, data: { label },
      })) } });
  });
  await page.route("**/api/services/frigate/stream**", route => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.goto("/services/frigate");
  const camera = page.getByRole("combobox", { name: "Device", exact: true });
  await camera.selectOption("front");
  await expect(page.locator(".detection-matches label")).toHaveCount(2);
  await expect(page.locator(".detection-matches label").filter({ hasText: "person" })).toHaveText("person(203)");
  await page.getByRole("checkbox", { name: "person", exact: true }).check();
  await expect(page.locator("#events .event")).toHaveCount(1);
  // Counts are independent of the checked label and the one displayed page.
  await expect(page.locator(".detection-matches label").filter({ hasText: "car" })).toHaveText("car(2)");
  await page.getByText("No saved detections (2 types)", { exact: true }).click();
  await expect(page.locator(".detection-absent label").filter({ hasText: "raccoon" })).toHaveText("raccoon(0)");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByRole("checkbox", { name: "raccoon", exact: true }).check();
  await expect(page.locator("#events .event")).toHaveCount(0);
  await expect(page.locator("#events .empty")).toBeVisible();
  await camera.selectOption("reveal");
  await expect(page.locator(".detection-matches label").filter({ hasText: "raccoon" })).toHaveText("raccoon(588)");
  await expect(page.getByRole("checkbox", { name: "raccoon", exact: true })).toBeChecked();
  await expect(page.locator("#events .event")).toHaveCount(1);
  await camera.selectOption("offline");
  await expect(page.locator(".detection-matches label")).toHaveCount(0);
  await expect(page.getByText("No saved detections for this device.", { exact: true })).toBeVisible();
  await expect(page.locator(".detection-absent label")).toHaveCount(4);
  await expect(page.getByRole("checkbox", { name: "raccoon", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await camera.selectOption("");
  await expect(page.locator(".detection-matches label")).toHaveCount(4);
  await expect(page.locator(".detection-missing")).toBeHidden();
});

test("Frigate labels link to Protect playback while invalid links and photo events stay separate", async ({ page, context }) => {
  const cameraId = "a".repeat(24);
  const recordingUrl = `https://nvr.example.test/protect/timelapse/${cameraId}?start=1789162387975`;
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate-fixture" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate-fixture", title: "Frigate labels", availability: "online", detail: "Receiving labels", page: "/services/frigate-fixture", actions: [], endpoints: [] },
    types: EVENT_TYPES,
  });
  const event = (type: string, message: string, url?: string) => ({ at: "2026-09-11T21:33:12.000Z", level: "info", type,
    subject: "front-camera", message, data: { recordingUrl: url } });
  await page.route("**/services/frigate-fixture", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate-fixture/events**", route => route.fulfill({ json: { events: [
    event("camera_object", "person (97%)", recordingUrl),
    event("camera_classified", "delivery person (87%)", recordingUrl),
    event("camera_object", "unmapped camera"),
    event("camera_object", "unsafe", "javascript:alert(1)"),
    event("camera_object", "credential URL", `https://user:secret@nvr.example.test/protect/timelapse/${cameraId}?start=1`),
    event("photo_labeled", "raccoon photo", recordingUrl),
  ] } }));
  await page.route("**/api/services/frigate-fixture/stream**", route => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await context.route("https://nvr.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Protect playback</h1>" }));
  await page.goto("/services/frigate-fixture");
  const links = page.getByRole("link", { name: "Watch video in Protect ↗", exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute("href", recordingUrl);
  await expect(links.first()).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await links.first().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(recordingUrl);
  await expect(popup.getByRole("heading", { name: "Protect playback" })).toBeVisible();
});

test("camera filters include quiet feeds and show their earlier labeled recordings", async ({ page }) => {
  const recordingUrl = `https://nvr.example.test/protect/timelapse/${"b".repeat(24)}?start=1789156795000`;
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate-history" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate-history", title: "Frigate labels", availability: "degraded", detail: "2 of 3 video feeds producing frames", page: "/services/frigate-history", actions: [], endpoints: [] },
    subjects: [{ id: "front", name: "Front camera" }, { id: "quiet", name: "Quiet camera" }, { id: "offline", name: "Offline camera" }],
    types: EVENT_TYPES,
  });
  const events = [
    { at: "2026-09-11T21:00:00.000Z", level: "info", type: "camera_object", subject: "front", message: "Front: car", data: {} },
    { at: "2026-09-11T20:00:00.000Z", level: "info", type: "camera_object", subject: "quiet", message: "Previously detected · quiet: dog", data: { historical: true, recordingUrl } },
  ];
  await page.route("**/services/frigate-history", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate-history/events**", route => {
    const subject = new URL(route.request().url()).searchParams.get("subject");
    return route.fulfill({ json: { events: events.filter(event => !subject || event.subject === subject) } });
  });
  await page.route("**/api/services/frigate-history/stream**", route => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.goto("/services/frigate-history");
  await expect(page.locator("#events .event")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Device", exact: true }).selectOption("quiet");
  await expect(page.locator("#events .event")).toHaveCount(1);
  await expect(page.getByText("Previously detected · quiet: dog", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Watch video in Protect ↗" })).toHaveAttribute("href", recordingUrl);
  await page.getByRole("combobox", { name: "Device", exact: true }).selectOption("offline");
  await expect(page.locator("#events .event")).toHaveCount(0);
  await expect(page.locator("#events .empty")).toBeVisible();
});

test("REVEAL photos open their original JPEG and older pages remain visible past 200 rows", async ({ page, context }) => {
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate", title: "Frigate camera labels", availability: "online", detail: "REVEAL: 205 photos labeled", page: "/services/frigate", actions: [], endpoints: [] },
    subjects: [{ id: "reveal-camera", name: "REVEAL" }], types: EVENT_TYPES,
  });
  const events = Array.from({ length: 205 }, (_, n) => ({ at: new Date(1789162000000 - n * 1000).toISOString(),
    type: "photo_labeled", level: "info", subject: "reveal-camera", message: `Wildlife ${n}`, data: {
      source: "reveal", photoId: n.toString(16).padStart(64, "0"), eventId: `photo-${n}`, capturedAt: "09112026031132",
    } }));
  await page.route("**/services/frigate", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate/events**", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("before") ?? 0);
    return route.fulfill({ json: { events: events.slice(offset, offset + 100), ...(offset + 100 < events.length ? { nextCursor: String(offset + 100) } : {}) } });
  });
  await page.route("**/api/services/frigate/stream**", route => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await context.route("**/api/cameras/reveal-camera/photos/*", route => route.fulfill({ contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") }));
  await page.goto("/services/frigate");
  await expect(page.locator("#events .event")).toHaveCount(100);
  await expect(page.getByRole("img", { name: "Labeled camera photo" }).first()).toBeVisible();
  const first = page.getByRole("link", { name: "View photo ↗", exact: true }).first();
  await expect(first).toHaveAttribute("href", `/api/cameras/reveal-camera/photos/${"0".repeat(64)}`);
  const popupPromise = page.waitForEvent("popup");
  await first.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp(`/api/cameras/reveal-camera/photos/${"0".repeat(64)}$`));
  await page.getByRole("button", { name: "Load older labels" }).click();
  await expect(page.locator("#events .event")).toHaveCount(200);
  await page.getByRole("button", { name: "Load older labels" }).click();
  await expect(page.locator("#events .event")).toHaveCount(205);
  await expect(page.getByRole("button", { name: "Load older labels" })).toBeHidden();
  await expect(page.getByText("Wildlife 0", { exact: true })).toBeVisible();
  await expect(page.getByText("Wildlife 204", { exact: true })).toBeAttached();
});


async function hoverPreviewFixture(page: Page, status = 200, snapshotStatus = 200) {
  const frames = await page.evaluate(() => Array.from({ length: 10 }, (_, i) => {
    const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 36;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = `rgb(${i * 25},40,120)`; ctx.fillRect(0, 0, 48, 36);
    return { time: 98 + i, image: canvas.toDataURL("image/jpeg") };
  }));
  const html = renderServicePage({
    ctx: testPageContext({ nonce: "fixture", path: "/services/frigate" }),
    service: { health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "frigate", title: "Frigate camera labels", availability: "online", detail: "Ready", page: "/services/frigate", actions: [], endpoints: [] }, types: EVENT_TYPES,
  });
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/services/frigate", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/services/frigate/events**", route => route.fulfill({ json: { labels: [], events: [{
    at: "2026-09-12T20:00:00Z", level: "info", type: "camera_object", subject: "front", message: "A person outside",
    data: { source: "frigate", camera: "front", objectId: "track", label: "person", frameTime: 100,
      recordingUrl: `https://nvr.example.test/protect/timelapse/${"b".repeat(24)}?start=95000` },
  }] } }));
  await page.route("**/api/services/frigate/stream**", route => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/services/frigate/frames/**", route => snapshotStatus !== 200
    ? route.fulfill({ status: snapshotStatus, body: "Snapshot unavailable" })
    : route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="36"><rect width="48" height="36" fill="#456"/></svg>' }));
  await page.route("**/api/services/frigate/previews/**", route => {
    requests.push(route.request().url()); return route.fulfill({ status, json: status === 200 ? { frames, playbackRate: 5 } : { error: "unavailable" } });
  });
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.goto("/services/frigate");
  const preview = page.locator(".event-preview"), image = preview.locator("img");
  if (snapshotStatus === 200) await expect(image).toBeVisible();
  else await expect(preview.locator(".event-frame-missing")).toBeVisible();
  return { frames, errors, requests, preview, image };
}

test("hover previews load on demand, advance one source second per 200ms, loop and restore the boxed snapshot", async ({ page }) => {
  const { frames, errors, requests, preview, image } = await hoverPreviewFixture(page);
  expect(requests).toEqual([]);
  await preview.hover(); await page.clock.runFor(200);
  await expect(preview.locator(".event-frame-caption")).toHaveText("10 s · 5× · approximate frames");
  expect(requests).toHaveLength(1); expect(new URL(requests[0]!).searchParams.get("at")).toBe("100");
  await expect(image).toHaveAttribute("src", frames[0]!.image);
  await page.clock.runFor(200); await expect(image).toHaveAttribute("src", frames[1]!.image);
  await page.clock.runFor(1800); await expect(image).toHaveAttribute("src", frames[0]!.image);
  await expect(preview.locator(".event-frame-link")).toHaveAttribute("href", "/api/services/frigate/frames/front/track");
  await expect(page.getByRole("link", { name: "Watch video in Protect ↗", exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(image).toHaveAttribute("src", "/api/services/frigate/frames/front/track");
  await expect(image).toHaveAttribute("alt", "Detection snapshot with bounding box");
  await preview.locator(".event-frame-link").focus();
  await expect(image).toHaveAttribute("src", frames[0]!.image); expect(requests).toHaveLength(1);
  await page.keyboard.press("Escape"); await expect(image).toHaveAttribute("src", "/api/services/frigate/frames/front/track");
  expect(errors).toEqual([]);
});

test("reduced motion suppresses automatic previews while explicit play and stop still work", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { requests, preview, image, frames, errors } = await hoverPreviewFixture(page);
  await preview.hover(); await page.clock.runFor(1000);
  await preview.locator(".event-frame-link").focus(); expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(image).toHaveAttribute("src", frames[0]!.image); expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await expect(image).toHaveAttribute("src", "/api/services/frigate/frames/front/track");
  expect(errors).toEqual([]);
});

test("missing recording access leaves the snapshot and Protect video link usable", async ({ page }) => {
  const { requests, preview, image, errors } = await hoverPreviewFixture(page, 503);
  await preview.hover(); await page.clock.runFor(200);
  await expect(preview.locator(".event-frame-caption")).toHaveText("Preview needs Protect recording access. The video link still works.");
  await expect(image).toHaveAttribute("src", "/api/services/frigate/frames/front/track");
  await expect(page.getByRole("link", { name: "Watch video in Protect ↗", exact: true })).toBeVisible();
  await page.mouse.move(0, 0); await preview.hover(); await page.clock.runFor(200);
  expect(requests).toHaveLength(1); expect(errors).toEqual([]);
});


test("a recording preview can play when the object snapshot is unavailable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { preview, image, frames, errors } = await hoverPreviewFixture(page, 200, 404);
  await expect(image).toBeHidden();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(image).toHaveAttribute("src", frames[0]!.image);
  await expect(image).toBeVisible();
  await expect(preview.locator(".event-frame-missing")).toBeHidden();
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await expect(preview.locator(".event-frame-missing")).toBeVisible();
  await expect(image).toBeHidden();
  await expect(page.getByRole("link", { name: "Watch video in Protect ↗", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
