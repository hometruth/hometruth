import type { Site } from "../site";
import type { Speaker } from "../models/speaker";
import type { DogConfig } from "./dog-config";
import type { DogFrameLabeler } from "../vendors/frigate/frame-labeler";
import { LatestCameraFrames } from "../camera-frames";
import { DogFrameDetector } from "./dog-frame-detector";
import { createMjpegStreamResponse, isSafeCameraUri, type CameraMediaSource } from "../camera-media";
import { secretsFor, type SecretStore, type SecretsFile } from "../config/secrets";

/** Read the recorder's private restream; frame capture and preview must not compete with its camera connection. */
export function dogPreviewSource(secrets: SecretsFile, cameraId: string): CameraMediaSource {
  const streams = secretsFor(secrets, "vendors", "unifiProtect").streams;
  const uri = streams && typeof streams === "object" && Object.hasOwn(streams, cameraId)
    ? (streams as Record<string, unknown>)[cameraId] : undefined;
  if (typeof uri !== "string" || !/^rtsps?:\/\//u.test(uri) || !isSafeCameraUri(uri)) {
    throw new Error("Configure a local Protect restream for this camera");
  }
  return { streamUri: uri };
}

export function dogSiteDependencies(site: () => Site, labeler?: DogFrameLabeler, secrets?: SecretStore) {
  const frames = new LatestCameraFrames();
  const source = async (cameraId: string) => {
    if (!site().get(cameraId)?.capability("camera")) throw new Error("Choose a camera");
    if (!secrets) throw new Error("Camera frames are unavailable");
    return dogPreviewSource(await secrets.load(), cameraId);
  };
  const detector = labeler ? new DogFrameDetector(async (id, signal) => frames.snapshot(await source(id), signal), labeler) : undefined;
  return {
    validate(config: DogConfig) {
      if (!site().get(config.cameraId)?.capability("camera")) throw new Error("Choose a camera");
      if (!detector) throw new Error("Enable the Frigate frame detector");
      const speaker = site().get(config.speakerId)?.capability("speaker") as Speaker | undefined;
      if (!speaker?.supportsSay()) throw new Error("Choose a speaker with speech support");
    },
    async detect(cameraId: string, signal: AbortSignal) {
      if (!detector) throw new Error("Enable the Frigate frame detector");
      return detector.detect(cameraId, signal);
    },
    release() { frames.stop(); labeler?.close?.(); },
    async stream(cameraId: string, signal: AbortSignal) {
      const cameraSource = await source(cameraId);
      signal.throwIfAborted();
      return createMjpegStreamResponse(cameraSource, signal);
    },
    async speak(speakerId: string, text: string) {
      const speaker = site().get(speakerId)?.capability("speaker") as Speaker | undefined;
      if (!speaker?.supportsSay()) throw new Error("The speaker is unavailable");
      // Avoid broadcasting the selected-speaker announcement into a multi-room group.
      const state = await speaker.getState();
      if (!state.group.isCoordinator || (state.group.memberHosts?.length ?? 1) > 1) {
        throw new Error("Kitchen speaker is grouped; make it standalone for kitchen-only announcements");
      }
      await speaker.say(text);
    },
  };
}
