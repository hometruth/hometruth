/**
 * Roborock `get_status` vocabulary: state codes, error codes, fan power
 * codes, and the parser that turns one reply into typed values. Codes follow
 * the tables python-roborock publishes for the S5/S6/S7 family; a code not
 * listed here is reported as its number, never guessed.
 */

export const ROBOROCK_STATES: Readonly<Record<number, string>> = {
  0: "Unknown",
  1: "Starting",
  2: "Charger disconnected",
  3: "Idle",
  4: "Remote control",
  5: "Cleaning",
  6: "Returning to dock",
  7: "Manual mode",
  8: "Charging",
  9: "Charging problem",
  10: "Paused",
  11: "Spot cleaning",
  12: "Error",
  13: "Shutting down",
  14: "Updating",
  15: "Docking",
  16: "Going to target",
  17: "Zone cleaning",
  18: "Room cleaning",
  22: "Emptying the bin",
  23: "Washing the mop",
  26: "Going to wash the mop",
  28: "In call",
  29: "Mapping",
  100: "Fully charged",
};

/** States in which the robot is out cleaning (paused and returning are not). */
export const ROBOROCK_CLEANING_STATES: ReadonlySet<number> = new Set([1, 4, 5, 7, 11, 16, 17, 18, 29]);

export const ROBOROCK_ERRORS: Readonly<Record<number, string>> = {
  0: "None",
  1: "LiDAR turret or laser blocked",
  2: "Bumper stuck",
  3: "Wheels suspended",
  4: "Cliff sensor error",
  5: "Main brush jammed",
  6: "Side brush jammed",
  7: "Wheels jammed",
  8: "Robot trapped",
  9: "No dustbin",
  12: "Low battery",
  13: "Charging error",
  14: "Battery error",
  15: "Wall sensor dirty",
  16: "Robot tilted",
  17: "Side brush error",
  18: "Fan error",
  21: "Vertical bumper pressed",
  22: "Dock locator error",
  23: "Could not return to the dock",
  24: "No-go zone or invisible wall detected",
  27: "VibraRise system jammed",
  28: "Robot on carpet",
  29: "Filter blocked or wet",
  30: "No-go zone or invisible wall detected",
  31: "Cannot cross carpet",
  32: "Internal error",
  34: "Clean the auto-empty dock",
  35: "Auto-empty dock voltage error",
  38: "Clean water tank empty",
  39: "Dirty water tank full",
};

export const ROBOROCK_FAN_POWERS: Readonly<Record<number, string>> = {
  101: "Quiet",
  102: "Balanced",
  103: "Turbo",
  104: "Max",
  105: "Off",
  106: "Custom",
  108: "Max+",
};

export interface RoborockStatus {
  readonly state: number;
  readonly stateText: string;
  readonly cleaning: boolean;
  readonly batteryPercent: number;
  readonly errorCode: number;
  readonly errorText: string;
  /** This (or the last) run's area, square metres to one decimal. */
  readonly cleanAreaSquareMetres?: number;
  /** This (or the last) run's duration in seconds. */
  readonly cleanTimeSeconds?: number;
  readonly fanPower?: number;
  readonly fanPowerText?: string;
}

export class RoborockStatusError extends Error {
  readonly code = "protocol" as const;
  constructor(message: string) {
    super(message);
    this.name = "RoborockStatusError";
  }
}

export function stateText(code: number): string {
  return ROBOROCK_STATES[code] ?? `State ${code}`;
}

export function errorText(code: number): string {
  return ROBOROCK_ERRORS[code] ?? `Error ${code}`;
}

export function fanPowerText(code: number): string {
  return ROBOROCK_FAN_POWERS[code] ?? `Fan power ${code}`;
}

const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** `get_status` answers `[{state, battery, …}]`; some firmware answers the object bare. */
export function parseStatus(result: unknown): RoborockStatus {
  const body = Array.isArray(result) ? result[0] : result;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RoborockStatusError("get_status returned no status object");
  const value = body as Record<string, unknown>;
  const { state, battery } = value;
  if (!whole(state) || state < 0) throw new RoborockStatusError("get_status reported no state");
  if (!whole(battery) || battery < 0 || battery > 100) throw new RoborockStatusError("get_status reported no battery level");
  const error = whole(value.error_code) && value.error_code >= 0 ? value.error_code : 0;
  const area = value.clean_area;
  const time = value.clean_time;
  const fan = value.fan_power;
  return {
    state,
    stateText: stateText(state),
    cleaning: ROBOROCK_CLEANING_STATES.has(state),
    batteryPercent: battery,
    errorCode: error,
    errorText: errorText(error),
    ...(whole(area) && area >= 0 ? { cleanAreaSquareMetres: Math.round(area / 100_000) / 10 } : {}),
    ...(whole(time) && time >= 0 ? { cleanTimeSeconds: time } : {}),
    ...(whole(fan) && fan >= 0 ? { fanPower: fan, fanPowerText: fanPowerText(fan) } : {}),
  };
}
