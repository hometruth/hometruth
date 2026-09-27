import { describe, expect, test } from "bun:test";
import type { MeariAlarmEvent } from "../../../vendors/tkenpro/alarm-upload";
import { TkenproMotionSensor, levelToPercent, percentToLevel, type TkenproAlarmSource } from "./motion";

function alarms(hearing: boolean) {
  const listeners = new Set<(event: MeariAlarmEvent) => void>();
  const source: TkenproAlarmSource = {
    onAlarm(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    lastAlarm() { return undefined; },
    hears() { return hearing; },
  };
  const raise = (sourceAddress: string, kind: "motion" | "other" = "motion") => {
    const event: MeariAlarmEvent = { at: new Date().toISOString(), sourceAddress, eventType: kind === "motion" ? 1 : 3, kind, bytes: 10 };
    for (const listener of listeners) listener(event);
  };
  return { source, raise };
}

function sensor(source: TkenproAlarmSource | undefined, camera: "online" | "offline" = "online") {
  const levels: number[] = [];
  const motion = new TkenproMotionSensor("motion", "10.78.0.147", source, {
    sensitivityLevel: () => 3,
    setSensitivityLevel: async (level) => { levels.push(level); },
    cameraAvailability: () => camera,
  });
  return { motion, levels };
}

describe("TkenproMotionSensor", () => {
  test("is online with motion false until this camera's own alarm arrives, then true for the pulse", async () => {
    const { source, raise } = alarms(true);
    const { motion } = sensor(source);
    expect(await motion.state()).toMatchObject({ availability: "online", motion: false, sensitivityPercent: 60 });
    raise("10.78.0.64"); // another camera
    expect((await motion.state()).motion).toBe(false);
    raise("10.78.0.147", "other"); // a non-motion alarm
    expect((await motion.state()).motion).toBe(false);
    raise("10.78.0.147");
    const state = await motion.state();
    expect(state.motion).toBe(true);
    expect(state.lastMotionAt).toBeDefined();
    expect(motion.lastAlarm?.kind).toBe("motion");
  });

  test("says unknown while the camera's alarms still go to the vendor, and follows the camera offline", async () => {
    const { source } = alarms(false);
    expect((await sensor(source).motion.state()).availability).toBe("unknown");
    expect((await sensor(undefined).motion.state()).availability).toBe("unknown");
    expect((await sensor(alarms(true).source, "offline").motion.state()).availability).toBe("offline");
  });

  test("maps the percent control onto the camera's 1..5 sensitivity levels", async () => {
    const { motion, levels } = sensor(alarms(true).source);
    expect(await motion.actions()).toEqual({ setSensitivity: { minimumPercent: 20, maximumPercent: 100, stepPercent: 20 } });
    await motion.invoke("setSensitivity", 100);
    await motion.invoke("setSensitivity", 20);
    await motion.invoke("setSensitivity", 50);
    expect(levels).toEqual([5, 1, 3]);
    expect(percentToLevel(0)).toBe(1);
    expect(levelToPercent(4)).toBe(80);
  });
});
