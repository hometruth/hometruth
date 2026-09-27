import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RevealClient } from "../../protocols/reveal/client";

/** Save existing cloud JPEGs. Atomic files make interrupted runs safe to resume. */
export async function downloadRevealPhotos(
  client: Pick<RevealClient, "photos" | "downloadPhoto">,
  options: { cameraId: string; output: string; maxPages?: number | "all" },
): Promise<{ downloaded: number; skipped: number; directory: string }> {
  const directory = resolve(options.output);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let downloaded = 0;
  let skipped = 0;
  for await (const photo of client.photos(options.cameraId, options.maxPages)) {
    // IDs are opaque upstream data, not filesystem paths. Include the camera to avoid cross-camera collisions.
    const name = createHash("sha256").update(JSON.stringify([photo.cameraId, photo.photoId])).digest("hex");
    const target = join(directory, `${name}.jpg`);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.size === 0) throw new Error("A REVEAL download destination is not a nonempty regular file");
      skipped++;
      continue;
    }
    const bytes = await client.downloadPhoto(photo);
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
    downloaded++;
  }
  return { downloaded, skipped, directory };
}
