import type { IotValue } from "./types.ts";

export const MEARI_ROI_WIDTH = 16;
export const MEARI_ROI_HEIGHT = 9;
export const MEARI_ROI_CELL_COUNT = MEARI_ROI_WIDTH * MEARI_ROI_HEIGHT;
export const MEARI_ROI_HEX_LENGTH = MEARI_ROI_CELL_COUNT / 4;

export interface MeariGridRegionView {
  readonly enabled: boolean;
  readonly width: typeof MEARI_ROI_WIDTH;
  readonly height: typeof MEARI_ROI_HEIGHT;
  readonly selectedCells: readonly number[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function binaryFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  return undefined;
}

function validBitmap(value: unknown): value is string {
  return typeof value === "string"
    && new RegExp(`^[0-9A-F]{${MEARI_ROI_HEX_LENGTH}}$`, "iu").test(value);
}

function bitmapToCells(bitmap: string): number[] {
  const selected: number[] = [];
  for (let nibbleIndex = 0; nibbleIndex < bitmap.length; nibbleIndex += 1) {
    const nibble = Number.parseInt(bitmap[nibbleIndex]!, 16);
    for (let bit = 0; bit < 4; bit += 1) {
      if ((nibble & (1 << (3 - bit))) !== 0) selected.push(nibbleIndex * 4 + bit);
    }
  }
  return selected;
}

function selectedCells(value: unknown): number[] {
  if (!Array.isArray(value)) throw new TypeError("Detection region selectedCells must be a list");
  const result = value.map((cell) => {
    if (!Number.isInteger(cell) || Number(cell) < 0 || Number(cell) >= MEARI_ROI_CELL_COUNT) {
      throw new RangeError(`Detection region cells must be numbered 0 through ${MEARI_ROI_CELL_COUNT - 1}`);
    }
    return Number(cell);
  });
  if (new Set(result).size !== result.length) {
    throw new RangeError("Detection region cannot contain duplicate cells");
  }
  return result.sort((left, right) => left - right);
}

function cellsToBitmap(cells: readonly number[]): string {
  const selected = new Set(cells);
  let bitmap = "";
  for (let index = 0; index < MEARI_ROI_CELL_COUNT; index += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      if (selected.has(index + bit)) nibble |= 1 << (3 - bit);
    }
    bitmap += nibble.toString(16).toUpperCase();
  }
  return bitmap;
}

/** Decode Meari property 177's 16x9, row-major, most-significant-bit-first mask. */
export function decodeMeariGridRegion(value: IotValue | undefined): MeariGridRegionView | undefined {
  const candidate = parsed(value);
  if (!isRecord(candidate)) return undefined;
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  const enabled = binaryFlag(candidate.enable ?? candidate.enabled);
  if (width !== MEARI_ROI_WIDTH || height !== MEARI_ROI_HEIGHT || enabled === undefined || !validBitmap(candidate.bitmap)) {
    return undefined;
  }
  const selected = bitmapToCells(candidate.bitmap);
  if (enabled !== (selected.length > 0)) return undefined;
  return {
    enabled,
    width: MEARI_ROI_WIDTH,
    height: MEARI_ROI_HEIGHT,
    selectedCells: selected,
  };
}

/** Encode the friendly grid editor into the exact property-177 object used by CloudEdge. */
export function encodeMeariGridRegion(value: unknown): IotValue {
  const candidate = parsed(value);
  if (!isRecord(candidate)) throw new TypeError("Detection region must be an object");
  if (candidate.width !== undefined && Number(candidate.width) !== MEARI_ROI_WIDTH) {
    throw new RangeError(`Detection region width must be ${MEARI_ROI_WIDTH}`);
  }
  if (candidate.height !== undefined && Number(candidate.height) !== MEARI_ROI_HEIGHT) {
    throw new RangeError(`Detection region height must be ${MEARI_ROI_HEIGHT}`);
  }

  let cells: number[];
  if (candidate.selectedCells !== undefined) {
    cells = selectedCells(candidate.selectedCells);
  } else if (candidate.cells !== undefined) {
    if (!Array.isArray(candidate.cells) || candidate.cells.length !== MEARI_ROI_CELL_COUNT
      || !candidate.cells.every((cell) => typeof cell === "boolean")) {
      throw new TypeError(`Detection region cells must contain ${MEARI_ROI_CELL_COUNT} true/false values`);
    }
    cells = candidate.cells.flatMap((cell, index) => cell ? [index] : []);
  } else if (validBitmap(candidate.bitmap)) {
    cells = bitmapToCells(candidate.bitmap);
  } else {
    throw new TypeError(`Detection region needs selectedCells or a ${MEARI_ROI_HEX_LENGTH}-digit bitmap`);
  }

  const enabled = cells.length > 0;
  const suppliedEnabled = candidate.enable === undefined && candidate.enabled === undefined
    ? undefined
    : binaryFlag(candidate.enable ?? candidate.enabled);
  if (suppliedEnabled === undefined && (candidate.enable !== undefined || candidate.enabled !== undefined)) {
    throw new TypeError("Detection region enabled must be true or false");
  }
  if (suppliedEnabled !== undefined && suppliedEnabled !== enabled) {
    throw new RangeError("Detection region enabled must match whether any grid cells are selected");
  }

  return {
    enable: enabled ? 1 : 0,
    width: MEARI_ROI_WIDTH,
    height: MEARI_ROI_HEIGHT,
    bitmap: cellsToBitmap(cells),
  };
}
