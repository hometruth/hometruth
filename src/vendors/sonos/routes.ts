/**
 * Serves clips registered by a Sonos speaker's `say()` control so the
 * speaker can fetch them back over HTTP. No constructor args: this only
 * touches the in-memory clip registry in `devices/speakers/sonos/say.ts`.
 */
import { Hono } from "hono";
import { sayClip } from "../../devices/speakers/sonos/say";
import type { AppEnvironment } from "../../server/http";

const SAY_CLIP_FILENAME = /^[0-9a-f-]{36}\.wav$/u;

export function sonosMediaRoutes(): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  app.get("/local-media/say/:file", (context) => {
    const file = context.req.param("file");
    if (!SAY_CLIP_FILENAME.test(file)) return context.notFound();
    const bytes = sayClip(file.slice(0, -".wav".length));
    if (!bytes) return context.notFound();
    // Content-Length is not derived automatically from a Uint8Array body —
    // it comes back null on a HEAD response otherwise, and Sonos issues a
    // HEAD to size the resource before playing; without it Sonos treats the
    // clip as empty and silently never starts, most visibly on very short
    // clips.
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
      },
    });
  });

  return app;
}
