import { describe, expect, test } from "bun:test";
import { mergeConnections } from "./camera-service";

describe("mergeConnections", () => {
  test("prefers the local emulator when it is connected", () => {
    const merged = mergeConnections(
      { via: "none", cloud: { state: "online" }, problems: [] },
      { via: "local", local: { state: "connected" }, problems: [] },
    );
    expect(merged.via).toBe("local");
    expect(merged.local?.state).toBe("connected");
    expect(merged.cloud?.state).toBe("online");
    expect(merged.problems).toEqual([]);
  });

  test("falls back to the cloud while the camera is not registered locally, keeping the local problem", () => {
    const merged = mergeConnections(
      { via: "cloud", cloud: { state: "online" }, problems: [] },
      { via: "none", local: { state: "waiting" }, problems: ["Not registered with the local emulator yet"] },
    );
    expect(merged.via).toBe("cloud");
    expect(merged.problems).toEqual(["Not registered with the local emulator yet"]);
  });

  test("explains an unreachable camera when neither side reported a problem", () => {
    const merged = mergeConnections({ via: "none", problems: [] }, undefined);
    expect(merged.via).toBe("none");
    expect(merged.problems[0]).toContain("not reachable through the local emulator or the vendor cloud");
  });

  test("deduplicates problems reported by both sides", () => {
    const merged = mergeConnections(
      { via: "none", problems: ["same"] },
      { via: "none", problems: ["same", "other"] },
    );
    expect(merged.problems).toEqual(["same", "other"]);
  });
});
