/** Local photo history, independent of a camera's live/snapshot transport. */
export interface CameraPhoto {
  readonly id: string;
  /** Camera-local time as text; do not assume a timezone. */
  readonly capturedAt?: string;
  readonly uploadedAt?: number;
  readonly savedAt: number;
  readonly labeling?: { readonly status: "pending" | "retrying" | "complete"; readonly result?: PhotoLabels; readonly error?: string };
}

export interface PhotoDetection {
  readonly label: string;
  readonly score: number;
  /** Normalized [left, top, right, bottom] coordinates in the original image. */
  readonly box: readonly [number, number, number, number];
}

export interface PhotoLabels {
  readonly engine: string;
  readonly model: string;
  readonly modelHash: string;
  readonly processedAt: number;
  readonly detections: readonly PhotoDetection[];
  readonly imageHash?: string;
  readonly classification?: {
    readonly label: string; readonly score: number; readonly taxonomy: string; readonly uncertain: boolean;
    readonly candidates: readonly { readonly label: string; readonly score: number }[];
  };
}

export interface CameraPhotoPage {
  readonly photos: readonly CameraPhoto[];
  readonly total: number;
  readonly labeling?: { readonly completed: number; readonly pending: number; readonly retrying: number };
  readonly nextCursor?: string;
  readonly sync: {
    readonly running: boolean;
    readonly lastCheckedAt?: number;
    readonly lastSuccessAt?: number;
    readonly nextCheckAt?: number;
    readonly error?: string;
    readonly continuing?: boolean;
    readonly pagesScanned?: number;
    readonly fullSyncQueued?: boolean;
  };
}

export interface CameraPhotoHistory {
  list(cursor?: string, order?: "newest" | "oldest"): Promise<CameraPhotoPage>;
  read(id: string): Promise<Uint8Array | undefined>;
  syncAll?(): Promise<void>;
}
