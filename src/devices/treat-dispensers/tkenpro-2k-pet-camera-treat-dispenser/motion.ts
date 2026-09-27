/**
 * Motion for the Pet 3T, from the camera's own on-device detection. The
 * firmware reports an alarm only by uploading a thumbnail to the vendor's
 * bucket (see `src/vendors/tkenpro/alarm-upload.ts`); while the camera is
 * isolated that upload lands on HomeTruth's interceptor, which hands the
 * event here. Each alarm is one motion pulse (there is no "motion cleared"
 * message), reported as current for `TKENPRO_MOTION_PULSE_MS`.
 *
 * Sensitivity is the camera's own `motionSensitivity` setting (1..5 over the
 * MsgSvr link), exposed as the generic percent control; there is no
 * clear-after setting on this firmware.
 */
import type { Availability } from "../../../models/capability";
import { MotionSensor, PushedMotionState, type MotionSensorActions, type MotionSensorState } from "../../../models/motion-sensor";
import type { MeariAlarmEvent } from "../../../vendors/tkenpro/alarm-upload";

/** The alarm source a device subscribes to; a fake in tests. */
export interface TkenproAlarmSource {
  onAlarm(listener: (event: MeariAlarmEvent) => void): () => void;
  lastAlarm(sourceAddress: string): MeariAlarmEvent | undefined;
  /** Whether a camera at this address currently uploads its alarms here (it is isolated); false means its alarms still go to the vendor. */
  hears(sourceAddress: string): boolean;
}

export interface TkenproMotionControls {
  /** The camera's motion sensitivity level 1..5 as the link last saw it; undefined when not reached. */
  sensitivityLevel(): number | undefined;
  setSensitivityLevel(level: number): Promise<void>;
  /** The camera itself, as the link sees it. */
  cameraAvailability(): Availability;
}

export const TKENPRO_MOTION_PULSE_MS = 15_000;
const LEVELS = 5;

export function percentToLevel(percent: number): number {
  return Math.min(LEVELS, Math.max(1, Math.round(percent / (100 / LEVELS))));
}

export function levelToPercent(level: number): number {
  return Math.round((level / LEVELS) * 100);
}

export class TkenproMotionSensor extends MotionSensor {
  override readonly controlIds: readonly string[] = ["setSensitivity"];
  private readonly pushed = new PushedMotionState(TKENPRO_MOTION_PULSE_MS);
  private readonly unsubscribe: (() => void) | undefined;
  /** The last alarm this camera raised, for the device page. */
  lastAlarm: MeariAlarmEvent | undefined;

  constructor(id: string, private readonly host: string, private readonly alarms: TkenproAlarmSource | undefined, private readonly controls: TkenproMotionControls) {
    super(id);
    this.lastAlarm = alarms?.lastAlarm(host);
    this.unsubscribe = alarms?.onAlarm((event) => {
      if (event.sourceAddress !== this.host) return;
      this.lastAlarm = event;
      if (event.kind === "motion") this.pushed.report(true);
    });
  }

  /**
   * Online only while the camera is online *and* its alarms reach HomeTruth
   * (it is isolated): then `motion` is true for a fresh pulse and false
   * otherwise. When its alarms still go to the vendor, nothing can be known
   * and the sensor says so rather than reporting a false "no motion".
   */
  override async state(): Promise<MotionSensorState> {
    const level = this.controls.sensitivityLevel();
    const sensitivity = level !== undefined ? { sensitivityPercent: levelToPercent(level) } : {};
    const pushed = this.pushed.state();
    const hearing = this.alarms?.hears(this.host) === true;
    const camera = this.controls.cameraAvailability();
    if (!hearing || camera !== "online") {
      return { availability: !hearing ? "unknown" : camera, ...(pushed.lastMotionAt ? { lastMotionAt: pushed.lastMotionAt } : {}), ...sensitivity };
    }
    return {
      availability: "online",
      motion: pushed.availability === "online" ? pushed.motion === true : false,
      observedAt: pushed.observedAt ?? new Date().toISOString(),
      ...(pushed.lastMotionAt ? { lastMotionAt: pushed.lastMotionAt } : {}),
      ...sensitivity,
    };
  }

  override async actions(): Promise<MotionSensorActions> {
    return this.controls.sensitivityLevel() !== undefined
      ? { setSensitivity: { minimumPercent: levelToPercent(1), maximumPercent: 100, stepPercent: 100 / LEVELS } }
      : {};
  }

  override async setSensitivity(percent: number): Promise<void> {
    await this.controls.setSensitivityLevel(percentToLevel(percent));
  }

  close(): void {
    this.unsubscribe?.();
  }
}
