import type { CameraFrame } from "../camera-frames";
import { parseDogFrameLabels, type DogFrameLabeler } from "../vendors/frigate/frame-labeler";

export interface DogDetection {
  source: "frigate";
  camera: string;
  dog: boolean;
  capturedAt: number;
  imageHash: string;
  elapsedMs: number;
}

/** A result belongs to one fresh JPEG, never to a retained track or an earlier photo. */
export class DogFrameDetector {
  constructor(private readonly frames: (cameraId: string, signal: AbortSignal) => Promise<CameraFrame>,
    private readonly labeler: DogFrameLabeler, private readonly now = Date.now) {}

  async detect(cameraId: string, signal: AbortSignal): Promise<DogDetection> {
    const frame = await this.frames(cameraId, signal);
    signal.throwIfAborted();
    if (this.now() - frame.at > 1_500) throw new Error("No fresh camera frame arrived");
    const started = this.now();
    const labels = parseDogFrameLabels(await this.labeler.label(frame.bytes, signal), frame.bytes);
    signal.throwIfAborted();
    if (this.now() - frame.at > 3_000) throw new Error("Frigate frame detection took too long");
    return { source: "frigate", camera: cameraId,
      dog: labels.dog,
      capturedAt: frame.at, imageHash: labels.imageHash,
      elapsedMs: this.now() - started };
  }
}
