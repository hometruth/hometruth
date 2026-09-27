import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import { ALARM_CAPTURE_DIRECTORY } from "../vendors/tkenpro/alarm-upload";
import { Site } from "../site";
import { TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER } from "../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import { encodeAlarmThumbnail } from "../protocols/tkenpro/alarm-image";

const DEVICE_ID = "test-alarm-camera";
const FILE = "20260906100002-motion-abc.jpg";
const KEY = "0123456789abcdef0123456789abcdef";
/** A synthetic thumbnail: a JPEG long enough that the camera's scrambled prefix covers part of it. */
const JPEG = (() => {
  const image = new Uint8Array(1_200);
  image.set([0xff, 0xd8, 0xff, 0xe0], 0);
  for (let index = 4; index < image.length - 2; index += 1) image[index] = index % 251;
  image.set([0xff, 0xd9], image.length - 2);
  return image;
})();
/** What the camera actually uploads: the same image with its first kilobyte XORed by the key. */
const UPLOADED: Uint8Array<ArrayBuffer> = encodeAlarmThumbnail(JPEG, KEY) as Uint8Array<ArrayBuffer>;
const folder = join(ALARM_CAPTURE_DIRECTORY, DEVICE_ID);

async function fixture(options: { withKey?: boolean } = {}) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, FILE), UPLOADED);
  const site = Site.fromConfig(
    { schemaVersion: 2, devices: [{ id: DEVICE_ID, name: "Test camera", model: TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER.id, config: { host: "10.78.0.147" } }] },
    {},
    options.withKey === false ? undefined : { schemaVersion: 1, devices: { [DEVICE_ID]: { pictureKey: KEY } } },
  );
  return createApp(undefined, site);
}

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("GET /api/devices/:id/alarms/:file", () => {
  test("undoes the camera's scrambling, so what is served is the real image", async () => {
    const app = await fixture();
    const response = await app.request(`/api/devices/${DEVICE_ID}/alarms/${FILE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const served = new Uint8Array(await response.arrayBuffer());
    expect(served).toEqual(JPEG);
    // What is on disk stays exactly what the camera uploaded.
    expect(served).not.toEqual(UPLOADED);
  });

  test("serves the stored bytes unchanged when no picture key is known, rather than pretending", async () => {
    const app = await fixture({ withKey: false });
    const response = await app.request(`/api/devices/${DEVICE_ID}/alarms/${FILE}`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(UPLOADED);
  });

  test("stays inside that device's own folder: no traversal, no other file types", async () => {
    const app = await fixture();
    for (const name of ["../../secrets.yml", "..%2Fother.jpg", "a/b.jpg", "note.txt", "..jpg.."]) {
      const response = await app.request(`/api/devices/${DEVICE_ID}/alarms/${encodeURIComponent(name)}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("content-type")).not.toBe("image/jpeg");
    }
  });

  test("404s for a thumbnail that was not kept, and for a device the site does not have", async () => {
    const app = await fixture();
    expect((await app.request(`/api/devices/${DEVICE_ID}/alarms/20260101000000-motion-zzz.jpg`)).status).toBe(404);
    expect((await app.request(`/api/devices/nope/alarms/${FILE}`)).status).toBe(404);
  });
});
