/**
 * The TKENPRO camera routes: setup, discovery, network mode, the camera
 * dashboard's control surface, and media streams. Mounted by the server; the
 * generic device routes live in `server/app.ts`.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CameraMediaError,
  captureCameraSnapshot,
  createCameraAudioStreamResponse,
  createMjpegStreamResponse,
  createPlaybackMjpegStreamResponse,
} from "../../camera-media";
import { localFeedSoundWav } from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/feed-sound";
import type { MeariCommonRequest } from "../../protocols/tkenpro/p2p-command";
import type {
  CameraActionResponse,
  CameraControlRequest,
  CameraDiscoverRequest,
  CameraPtzRequest,
  CameraNetworkReconnectRequest,
  CameraRebootRequest,
  CameraNetworkToggleRequest,
  CameraSelectRequest,
  CameraSetupRequest,
} from "../../schemas";
import { checkedJson, errorDetail, errorJson, requestJson, type AppEnvironment } from "../../server/http";
import { describeValidationErrors, validators } from "../../validation";
import { CameraService, CameraServiceError } from "./camera-service";

const MAX_TALKBACK_PCM_BYTES = 16_000;

/** Request bodies that are raw audio rather than JSON. */
export const TKENPRO_RAW_UPLOAD_PATH = /\/api\/camera\/devices\/[^/]+\/talkback\/audio$/u;

function actionJson(
  context: Context<AppEnvironment>,
  state: ReturnType<CameraService["state"]>,
  message?: string,
) {
  const body: CameraActionResponse = {
    ok: true,
    state,
    ...(message ? { message } : {}),
  };
  return checkedJson(context, validators.cameraActionResponse, body);
}


export function tkenproRoutes(cameraService: CameraService): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  app.get("/local-media/pet_msg0.wav", () => new Response(localFeedSoundWav() as unknown as BodyInit, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "audio/wav",
    },
  }));

  app.get("/api/camera/state", (context) =>
    checkedJson(context, validators.cameraDashboardModel, cameraService.state()),
  );

  app.post("/api/camera/setup", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraSetupRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraSetupRequest.errors));
    }
    const state = await cameraService.setup(input as CameraSetupRequest);
    return actionJson(context, state, "Camera connection settings are saved privately in .hometruth/camera-setup.json and active");
  });

  app.post("/api/camera/disconnect", async (context) => {
    const state = await cameraService.disconnect();
    return actionJson(context, state, "Saved camera settings removed from .hometruth/camera-setup.json");
  });

  app.post("/api/camera/discover", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraDiscoverRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraDiscoverRequest.errors));
    }
    const state = await cameraService.discover(input as CameraDiscoverRequest);
    return actionJson(context, state);
  });

  app.get("/api/camera/network", async (context) =>
    checkedJson(context, validators.cameraDashboardModel, await cameraService.refreshNetwork()),
  );

  app.post("/api/camera/network/dns-override", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraNetworkToggleRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraNetworkToggleRequest.errors));
    }
    const { action, reconnect } = input as CameraNetworkToggleRequest;
    const result = await cameraService.setNetworkMode(action, reconnect === undefined ? {} : { reconnect });
    return actionJson(context, result.state, result.message);
  });

  app.post("/api/camera/network/reconnect", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraNetworkReconnectRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraNetworkReconnectRequest.errors));
    }
    const { deviceId } = input as CameraNetworkReconnectRequest;
    const result = await cameraService.reconnectCameras(deviceId ? { deviceId } : {});
    return actionJson(context, result.state, result.message);
  });

  app.post("/api/camera/reboot", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraRebootRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraRebootRequest.errors));
    }
    const { deviceId, host, timeoutSeconds } = input as CameraRebootRequest;
    const result = await cameraService.rebootCamera({
      ...(deviceId ? { deviceId } : {}),
      ...(host ? { host } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1000 } : {}),
    });
    return actionJson(context, result.state, result.message);
  });

  app.post("/api/camera/select", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraSelectRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraSelectRequest.errors));
    }
    const request = input as CameraSelectRequest;
    return actionJson(context, await cameraService.select(request.deviceId));
  });

  app.post("/api/camera/control", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraControlRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraControlRequest.errors));
    }
    return actionJson(context, await cameraService.control(input as CameraControlRequest));
  });

  app.post("/api/camera/ptz", async (context) => {
    const input = await requestJson(context);
    if (!validators.cameraPtzRequest(input)) {
      return errorJson(context, 400, "invalid_request", describeValidationErrors(validators.cameraPtzRequest.errors));
    }
    return actionJson(context, await cameraService.ptz(input as CameraPtzRequest));
  });

  app.post("/api/camera/devices/:id/local-command", async (context) => {
    const input = await requestJson(context);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return errorJson(context, 400, "invalid_request", "Local command must be a JSON object");
    }
    const record = input as Record<string, unknown>;
    if ((record.action !== "GET" && record.action !== "POST") || typeof record.deviceurl !== "string") {
      return errorJson(context, 400, "invalid_request", "Local command requires action and deviceurl");
    }
    if (record.confirmed !== undefined && typeof record.confirmed !== "boolean") {
      return errorJson(context, 400, "invalid_request", "Local command confirmed must be true or false");
    }
    const { confirmed, ...request } = record;
    const response = await cameraService.localCommand(
      context.req.param("id"),
      request as MeariCommonRequest,
      confirmed === true,
    );
    let body: unknown = response.http.bodyText;
    if (response.http.bodyText.trim()) {
      try { body = JSON.parse(response.http.bodyText) as unknown; } catch { /* Keep text responses as text. */ }
    }
    return context.json({
      ok: true,
      status: response.http.status,
      statusText: response.http.statusText,
      body,
    });
  });

  app.post("/api/camera/devices/:id/local-iot", async (context) => {
    const input = await requestJson(context);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return errorJson(context, 400, "invalid_request", "Local IoT write must be a JSON object");
    }
    const record = input as Record<string, unknown>;
    if (record.values === undefined || typeof record.values !== "object" || record.values === null || Array.isArray(record.values)) {
      return errorJson(context, 400, "invalid_request", "Local IoT write requires a values object");
    }
    if (record.confirmed !== undefined && typeof record.confirmed !== "boolean") {
      return errorJson(context, 400, "invalid_request", "Local IoT confirmed must be true or false");
    }
    const result = await cameraService.localIot(
      context.req.param("id"),
      record.values,
      record.confirmed === true,
    );
    return context.json({ ok: true, result });
  });

  app.post("/api/camera/devices/:id/talkback/start", async (context) =>
    actionJson(
      context,
      await cameraService.startTalkback(context.req.param("id")),
      "Local talkback is ready",
    ),
  );

  app.post("/api/camera/devices/:id/talkback/audio", async (context) => {
    const declaredLength = Number(context.req.header("content-length") ?? 0);
    if (declaredLength > MAX_TALKBACK_PCM_BYTES) {
      return errorJson(context, 413, "invalid_request", "Talkback audio chunk is too large");
    }
    const bytes = Buffer.from(await context.req.arrayBuffer());
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_TALKBACK_PCM_BYTES || bytes.byteLength % 2 !== 0) {
      return errorJson(context, 400, "invalid_request", "Talkback audio must be 1–8000 signed 16-bit samples");
    }
    const pcm = new Int16Array(bytes.byteLength / 2);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = bytes.readInt16LE(index * 2);
    }
    await cameraService.sendTalkbackPcm(context.req.param("id"), pcm);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });

  app.post("/api/camera/devices/:id/talkback/stop", async (context) =>
    actionJson(context, await cameraService.stopTalkback(context.req.param("id"))),
  );

  app.post("/api/camera/devices/:id/playback/pause", async (context) =>
    actionJson(context, await cameraService.controlPlayback(context.req.param("id"), "pause")),
  );

  app.post("/api/camera/devices/:id/playback/resume", async (context) =>
    actionJson(context, await cameraService.controlPlayback(context.req.param("id"), "resume")),
  );

  app.post("/api/camera/devices/:id/playback/seek", async (context) => {
    const body = await requestJson(context);
    const timestamp = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).timestamp
      : undefined;
    if (typeof timestamp !== "string") {
      return errorJson(context, 400, "invalid_request", "Playback seek requires a timestamp");
    }
    return actionJson(
      context,
      await cameraService.controlPlayback(context.req.param("id"), "seek", timestamp),
    );
  });

  app.post("/api/camera/devices/:id/playback/stop", async (context) =>
    actionJson(context, await cameraService.stopPlayback(context.req.param("id"))),
  );

  app.get("/api/camera/devices/:id/stream.mjpeg", (context) => {
    const source = cameraService.media(context.req.param("id"));
    return createMjpegStreamResponse(source, context.req.raw.signal);
  });

  app.get("/api/camera/devices/:id/audio.mp3", (context) => {
    const source = cameraService.media(context.req.param("id"));
    return createCameraAudioStreamResponse(source, context.req.raw.signal);
  });

  app.get("/api/camera/devices/:id/playback.mjpeg", async (context) => {
    const deviceId = context.req.param("id");
    const frames = await cameraService.startPlayback(deviceId, context.req.query("at") ?? "");
    return await createPlaybackMjpegStreamResponse(
      frames,
      context.req.raw.signal,
      async () => { await cameraService.stopPlayback(deviceId); },
    );
  });

  app.get("/api/camera/devices/:id/snapshot", async (context) => {
    const source = cameraService.media(context.req.param("id"));
    const bytes = await captureCameraSnapshot(source);
    return new Response(bytes.buffer as ArrayBuffer, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return app;
}

/** Maps this vendor's errors to responses; undefined for errors it does not own. */
export function tkenproErrorResponse(error: unknown, context: Context<AppEnvironment>): Response | undefined {
  if (error instanceof CameraServiceError) {
      const status: ContentfulStatusCode = error.code === "not_found"
        ? 404
        : error.code === "invalid_control"
          ? 400
          : error.code === "camera_error"
            ? 502
            : 409;
      return errorJson(context, status, error.code, error.message, errorDetail(error));
    }
  if (error instanceof CameraMediaError) {
      const status: ContentfulStatusCode = error.code === "invalid_uri"
        ? 400
        : error.code === "ffmpeg_failed"
          ? 502
          : 409;
      return errorJson(context, status, `media_${error.code}`, "The local camera video is unavailable");
    }
  return undefined;
}
