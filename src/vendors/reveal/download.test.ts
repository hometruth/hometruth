import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jpeg, samplePhoto } from "../../protocols/reveal/test-fixtures";
import { downloadRevealPhotos } from "./download";

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "hometruth-reveal-")); directories.push(path); return path; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("REVEAL photo downloader", () => {
  test("resumes without re-downloading and never treats upstream IDs as paths", async () => {
    const output = await directory();
    let downloads = 0;
    const client = {
      async *photos() { yield { ...samplePhoto, photoId: "../../outside" }; },
      async downloadPhoto() { downloads++; return jpeg; },
    };
    expect(await downloadRevealPhotos(client, { cameraId: "camera-1", output })).toMatchObject({ downloaded: 1, skipped: 0 });
    expect(await downloadRevealPhotos(client, { cameraId: "camera-1", output })).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(downloads).toBe(1);
    const files = await readdir(output);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.jpg$/u);
    expect(new Uint8Array(await readFile(join(output, files[0]!)))).toEqual(jpeg);
    expect((await stat(join(output, files[0]!))).mode & 0o777).toBe(0o600);
  });

  test("leaves no completed file after a failed download; a later run recovers", async () => {
    const output = await directory();
    let fail = true;
    const client = {
      async *photos() { yield samplePhoto; },
      async downloadPhoto() { if (fail) throw new Error("download failed"); return jpeg; },
    };
    await expect(downloadRevealPhotos(client, { cameraId: "camera-1", output })).rejects.toThrow("download failed");
    expect(await readdir(output)).toEqual([]);
    fail = false;
    expect((await downloadRevealPhotos(client, { cameraId: "camera-1", output })).downloaded).toBe(1);
  });
});
