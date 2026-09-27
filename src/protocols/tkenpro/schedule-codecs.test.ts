import { describe, expect, test } from "bun:test";
import { decodeMeariSchedule, encodeMeariSchedule } from "./schedule-codecs.ts";

describe("Meari schedule wire codecs", () => {
  test("encodes the shared sleep/alarm/recording interval shape with Monday=1", () => {
    expect(encodeMeariSchedule("weekly-intervals", [{
      enabled: true,
      startTime: "22:30",
      endTime: "07:15",
      days: ["mon", "wed", "sun"],
    }])).toEqual([{
      enable: true,
      start_time: "22:30",
      stop_time: "07:15",
      repeat: [1, 3, 7],
    }]);
  });

  test("encodes and sorts timed PTZ patrol entries", () => {
    expect(encodeMeariSchedule("patrol-times", [
      { enabled: false, time: "18:00" },
      { enabled: true, time: "08:30" },
    ])).toEqual([
      { enable: 1, t: "08:30" },
      { enable: 0, t: "18:00" },
    ]);
  });

  test("encodes feed schedules with exact once/repeat, count, and cue fields", () => {
    expect(encodeMeariSchedule("feed-times", [
      { enabled: true, time: "09:00", portions: 2, days: [1, 3, 0], sound: true },
      { enabled: false, time: "17:00", parts: 1, once: true, days: [], sound: false },
    ])).toEqual([
      { enable: true, time: "09:00", repeat: [1, 3, 7], count: 2, msg_enable: true },
      { enable: false, time: "17:00", once: 1, count: 1, msg_enable: false },
    ]);
  });

  test("encodes deployment and single daily windows without mixing their fields", () => {
    expect(encodeMeariSchedule("deployment-intervals", [
      { startTime: "06:00", endTime: "10:00" },
    ])).toEqual([{ start_time: "06:00", stop_time: "10:00" }]);
    expect(encodeMeariSchedule("daily-window", {
      enabled: true,
      startTime: "19:00",
      endTime: "06:30",
    })).toEqual({ enable: 1, from: "19:00", to: "06:30" });
  });

  test("decodes camera JSON strings for the non-interchangeable editors", () => {
    expect(decodeMeariSchedule(
      "weekly-intervals",
      '[{"enable":true,"start_time":"21:00","stop_time":"06:00","repeat":[1,7]}]',
    )).toEqual({
      mode: "weekly-intervals",
      maxEntries: 20,
      entries: [{ enabled: true, startTime: "21:00", endTime: "06:00", days: ["mon", "sun"] }],
    });
    expect(decodeMeariSchedule("patrol-times", '[{"enable":1,"t":"11:45"}]')).toEqual({
      mode: "patrol-times",
      maxEntries: 10,
      entries: [{ enabled: true, time: "11:45" }],
    });
  });

  test("rejects invalid or ambiguous schedule values before they reach the camera", () => {
    expect(() => encodeMeariSchedule("weekly-intervals", [{
      enabled: true,
      startTime: "09:00",
      endTime: "09:00",
      days: ["mon"],
    }])).toThrow("start and end must differ");
    expect(() => encodeMeariSchedule("patrol-times", [{ enabled: true, time: "25:00" }])).toThrow("valid HH:MM");
    expect(() => encodeMeariSchedule("feed-times", [{ enabled: true, time: "09:00", portions: 11, once: true }])).toThrow("1 to 10 portions");
  });
});
