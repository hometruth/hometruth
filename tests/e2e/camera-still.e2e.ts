import { testPageContext } from "../../src/ui/test-context";
import { expect, test } from "@playwright/test";
import { renderCameraPage } from "../../src/ui/camera-page";

const thumbnail = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=", "base64");

test("photo history shows species uncertainty and plays across pages without restarting a full import", async ({ page }) => {
  const html = renderCameraPage({ photoHistory: true,
    ctx: testPageContext({ nonce: "fixture", path: "/devices/still-fixture" }),
    device: { id: "still-fixture", name: "Photo fixture", kind: "camera", model: "tactacam-reveal", modelTitle: "REVEAL", capabilities: ["camera"], host: "", page: "/devices/still-fixture", schemaId: "camera", enabled: true },
  });
  const makePhoto = (id: string, label: string, uncertain: boolean) => ({ id, savedAt: 1000,
    capturedAt: "09112026031132", labeling: { status: "complete", result: { engine: "SpeciesNet on Frigate host", model: "SpeciesNet 4.0.3a",
      classification: { label, score: uncertain ? 0.65 : 0.95, uncertain } } } });
  const first = makePhoto("a".repeat(64), "raccoon", false), second = makePhoto("b".repeat(64), "deer", true);
  const lists: string[] = [];
  let posts = 0;
  await page.route("**/devices/still-fixture", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/cameras/still-fixture/photos**", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/sync")) {
      expect(request.method()).toBe("POST");
      expect(request.headers()["content-type"]).toContain("application/json");
      expect(request.postDataJSON()).toEqual({});
      posts++;
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    if (/\/[a-f0-9]{64}$/u.test(url.pathname)) return route.fulfill({ contentType: "image/png", body: thumbnail });
    lists.push(url.search);
    const oldest = url.searchParams.get("order") === "oldest";
    const cursor = url.searchParams.get("cursor");
    return route.fulfill({ json: { photos: oldest ? [cursor ? second : first] : [second, first], total: 2,
      ...(oldest && !cursor ? { nextCursor: "page-two" } : {}), labeling: { completed: 2, pending: 0, retrying: 0 },
      sync: { running: false, fullSyncQueued: posts > 0 } } });
  });
  await page.goto("/devices/still-fixture");
  await expect(page.locator("#photo-summary")).toContainText("Labeled 2 of 2 photos");
  await expect(page.locator("#photo-caption")).toContainText("possibly deer · 65%");
  await page.getByLabel("Seconds per photo", { exact: true }).selectOption("0.5");
  await page.getByRole("button", { name: "Play all", exact: true }).click();
  await expect(page.locator("#photo-play-status")).toContainText("Playing photo 2");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  expect(lists).toContain("?order=oldest&cursor=page-two");
  await page.getByRole("button", { name: "Fetch all photos", exact: true }).click();
  expect(posts).toBe(1);
  await expect(page.getByRole("button", { name: "Fetch all photos", exact: true })).toBeDisabled();
});

test("a snapshot-only camera displays its still automatically and never requests live video", async ({ page }) => {
  const mediaRequests: string[] = [];
  await page.route("**/api/devices/e2e-wyze", route => route.fulfill({ json: {
    object: { model: "REVEAL", capabilities: { camera: { state: { availability: "online", streamAvailable: false, snapshotAvailable: true } } } },
  } }));
  await page.route("**/api/cameras/e2e-wyze/**", route => {
    mediaRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=", "base64") });
  });
  await page.goto("/devices/e2e-wyze");
  await expect(page.locator("#viewer-image")).toBeVisible();
  await expect(page.locator("#viewer-image")).toHaveAttribute("src", /\/snapshot\?/u);
  await expect(page.locator('[data-action="live"]')).toBeHidden();
  await expect(page.getByRole("button", { name: "Snapshot" })).toBeEnabled();
  expect(mediaRequests).toEqual(["/api/cameras/e2e-wyze/snapshot"]);
});
