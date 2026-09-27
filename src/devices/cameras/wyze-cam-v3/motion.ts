/**
 * Motion for Wyze Cam v3 through Thingino's "Send to MQTT" target and
 * HomeTruth's embedded broker. This adapter does not use ONVIF events.
 *
 * The camera publishes `{"camera_id": "...", "timestamp": <unix seconds>}`
 * to its configured topic on every motion event (no "motion cleared"
 * message — Motion Guard is edge-triggered, not level-triggered). This
 * capability treats each publish as one motion pulse and reports `motion`
 * as true only while the pulse is fresh (`PushedMotionState`'s
 * `staleAfterMs`), so `describe()` does not claim ongoing motion forever
 * after a single event.
 */
import { MotionSensor, PushedMotionState, type MotionSensorActions, type MotionSensorState } from "../../../models/motion-sensor";

/** The shared broker HomeTruth runs; a product only ever subscribes, never manages the server. */
export interface WyzeCamV3MqttBroker {
  readonly hostname: string;
  readonly port: number;
  onMessage(topic: string, handler: (topic: string, payload: Buffer) => void): () => void;
}

declare module "../../../models/device" {
  interface SiteServices {
    mqttBroker?: WyzeCamV3MqttBroker;
  }
}

/** How long a motion pulse is reported as "currently true" before falling back to false. Matches the camera's own cooldown default (5 s) with headroom for network jitter. */
export const WYZE_CAM_V3_MOTION_PULSE_MS = 15_000;

/** `thingino/<device id>`: stable, unique per configured instance, and what the camera's own `mqtt.topic` field should be set to. */
export function wyzeCamV3MqttTopic(deviceId: string): string {
  return `thingino/${deviceId}`;
}

export class WyzeCamV3MotionSensor extends MotionSensor {
  /** Neither setting is offered: the camera has no exposed sensitivity or clear-after control. */
  override readonly controlIds: readonly string[] = [];

  private readonly pushed = new PushedMotionState(WYZE_CAM_V3_MOTION_PULSE_MS);
  private readonly unsubscribe: (() => void) | undefined;

  constructor(id: string, broker: WyzeCamV3MqttBroker | undefined, topic: string) {
    super(id);
    this.unsubscribe = broker?.onMessage(topic, () => this.pushed.report(true));
  }

  override async state(): Promise<MotionSensorState> {
    return this.unsubscribe ? this.pushed.state() : { availability: "unknown" };
  }

  override async actions(): Promise<MotionSensorActions> {
    return {};
  }

  /** Stops listening; call when the device is torn down (there is no site-level device lifecycle hook for this yet, so products call it directly). */
  close(): void {
    this.unsubscribe?.();
  }
}
