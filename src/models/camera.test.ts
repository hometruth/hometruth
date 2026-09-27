import { describe, expect, test } from "bun:test";
import { validators } from "../validation";
import { Camera, DEFAULT_MOVEMENT_LEASE, type CameraActions, type CameraState } from "./camera";
import { CapabilityError } from "./capability";

class FakeCamera extends Camera {
  moves: string[] = [];
  privacy = false;
  constructor(private readonly offered: CameraActions, private readonly current: CameraState = { availability: "online", streamAvailable: true, snapshotAvailable: true }) {
    super("cam");
  }
  async state() { return this.current; }
  async actions() { return this.offered; }
  override async pan(direction: "left" | "right", leaseMs: number) { this.moves.push(`pan:${direction}:${leaseMs}`); }
  override async tilt(direction: "up" | "down", leaseMs: number) { this.moves.push(`tilt:${direction}:${leaseMs}`); }
  override async stopMovement() { this.moves.push("stop"); }
  override async setPrivacy(enabled: boolean) { this.privacy = enabled; }
}

describe("Camera", () => {
  test("describes exactly the declared actions as a valid Camera document", async () => {
    const full = new FakeCamera({ snapshot: { mediaTypes: ["image/jpeg"] }, pan: { lease: DEFAULT_MOVEMENT_LEASE, home: true }, tilt: { lease: DEFAULT_MOVEMENT_LEASE }, setPrivacy: true });
    const document = await full.describe();
    expect(validators.camera(document)).toBe(true);
    expect(Object.keys(document.actions ?? {}).sort()).toEqual(["pan", "setPrivacy", "snapshot", "stopMovement", "tilt"]);
    expect(document.actions?.pan).toEqual({ left: DEFAULT_MOVEMENT_LEASE, right: DEFAULT_MOVEMENT_LEASE, home: {} });
    expect(document.state).toEqual({ availability: "online", streamAvailable: true, snapshotAvailable: true });

    const still = new FakeCamera({ snapshot: { mediaTypes: ["image/jpeg"] } });
    const stillDocument = await still.describe();
    expect(Object.keys(stillDocument.actions ?? {})).toEqual(["snapshot"]);
  });

  test("routes movement controls with a bounded lease and refuses undeclared ones", async () => {
    const camera = new FakeCamera({ snapshot: { mediaTypes: ["image/jpeg"] }, pan: { lease: DEFAULT_MOVEMENT_LEASE }, tilt: { lease: { minLeaseMs: 200, maxLeaseMs: 1000 } } });
    await camera.invoke("pan.left");
    await camera.invoke("tilt.up", 500);
    await camera.invoke("stopMovement");
    expect(camera.moves).toEqual(["pan:left:3000", "tilt:up:500", "stop"]);
    await expect(camera.invoke("tilt.down", 5000)).rejects.toMatchObject({ code: "invalid_value" });
    await expect(camera.invoke("pan.home")).rejects.toMatchObject({ code: "not_supported" });
    await expect(camera.invoke("setPrivacy", true)).rejects.toMatchObject({ code: "not_supported" });
    await expect(camera.invoke("explode")).rejects.toMatchObject({ code: "unknown_control" });
  });

  test("setPrivacy takes a boolean once declared", async () => {
    const camera = new FakeCamera({ snapshot: { mediaTypes: ["image/jpeg"] }, setPrivacy: true });
    await camera.invoke("setPrivacy", true);
    expect(camera.privacy).toBe(true);
    const error = await camera.invoke("setPrivacy", "yes").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe("invalid_value");
  });
});
