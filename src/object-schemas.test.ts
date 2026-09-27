import { describe, expect, test } from "bun:test";
import {
  binarySwitchSchema,
  buttonSchema,
  cameraSchema,
  homeTruthObjectSchema,
  infraredBlasterSchema,
  infraredReceiverSchema,
  lightSchema,
  motionSensorSchema,
  petTreatDispenserCameraSchema,
  radioFrequencyBlasterSchema,
  radioFrequencyReceiverSchema,
  treatDispenserSchema,
} from "./schemas";
import { validators } from "./validation";

const observedAt = "2026-09-01T20:00:00Z";

const camera = {
  id: "main-camera",
  state: {
    availability: "online",
    streamAvailable: true,
    snapshotAvailable: true,
    observedAt,
  },
  actions: {
    snapshot: {},
    pan: {
      left: { minLeaseMs: 100, maxLeaseMs: 3_000 },
      right: { minLeaseMs: 100, maxLeaseMs: 3_000 },
    },
  },
} as const;

const treatDispenser = {
  id: "main-dispenser",
  actions: {
    dispense: {
      minimumPortions: 1,
      maximumPortions: 10,
      step: 1,
    },
  },
} as const;

const light = {
  id: "porch-light",
  state: {
    availability: "online",
    on: true,
    brightnessPercent: 65,
    colorTemperatureKelvin: 3_000,
    observedAt,
  },
} as const;

const binarySwitch = {
  id: "porch-relay",
  state: { availability: "online", value: "off", observedAt },
  actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} },
} as const;

const button = {
  id: "candles-on",
  state: { availability: "online", observedAt },
  actions: { press: { maximumDurationMs: 60_000 } },
} as const;

const motionSensor = {
  id: "porch-motion",
  state: {
    availability: "online",
    motion: false,
    lastMotionAt: "2026-09-01T19:59:30Z",
    observedAt,
  },
} as const;

const infraredBlaster = {
  id: "living-room-ir-transmitter",
  state: { availability: "online", observedAt },
  channels: [{
    id: "ir-38khz",
    carrierFrequencyHz: 38_000,
    formats: ["nec", "raw-pulses"],
  }],
  actions: {
    send: {
      maxPulseCount: 4_096,
      minRepeatCount: 1,
      maxRepeatCount: 10,
    },
  },
} as const;

const infraredReceiver = {
  id: "living-room-ir-receiver",
  state: { availability: "online", observedAt },
  channels: [{
    id: "ir-38khz",
    carrierFrequencyHz: 38_000,
    formats: ["nec", "raw-pulses"],
  }],
  events: {
    signalReceived: {
      includesRawPulsesMicroseconds: true,
      includesDecodedPayload: true,
    },
  },
  actions: {
    learn: {
      minCaptureMs: 100,
      maxCaptureMs: 10_000,
    },
  },
} as const;

const radioFrequencyBlaster = {
  id: "garage-rf-transmitter",
  state: { availability: "online", observedAt },
  channels: [{
    id: "rf-433mhz",
    centerFrequencyHz: 433_920_000,
    bandwidthHz: 200_000,
    modulations: ["ook"],
    formats: ["raw-pulses"],
  }],
  actions: {
    send: {
      maxPulseCount: 4_096,
      minRepeatCount: 1,
      maxRepeatCount: 20,
    },
  },
} as const;

const radioFrequencyReceiver = {
  id: "garage-rf-receiver",
  state: { availability: "online", observedAt },
  channels: [{
    id: "rf-433mhz",
    centerFrequencyHz: 433_920_000,
    bandwidthHz: 200_000,
    modulations: ["ook"],
    formats: ["raw-pulses"],
  }],
  events: {
    signalReceived: {
      includesRawPulsesMicroseconds: true,
      includesDecodedPayload: false,
    },
  },
  actions: {
    learn: {
      minCaptureMs: 100,
      maxCaptureMs: 30_000,
    },
  },
} as const;

const petTreatDispenserCamera = {
  schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null },
  id: "kitchen-pet-camera",
  name: "Kitchen pet camera",
  capabilities: { camera, treatDispenser },
} as const;

function expectValid(validatorName: keyof typeof validators, value: unknown): void {
  const validator = validators[validatorName];
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
}

function expectInvalid(validatorName: keyof typeof validators, value: unknown): void {
  expect(validators[validatorName](value)).toBe(false);
}

describe("HomeTruth object schemas", () => {
  test("exports each capability and object schema as a distinct JSON Schema", () => {
    const schemas = [
      cameraSchema,
      lightSchema,
      binarySwitchSchema,
      buttonSchema,
      motionSensorSchema,
      infraredBlasterSchema,
      infraredReceiverSchema,
      radioFrequencyBlasterSchema,
      radioFrequencyReceiverSchema,
      treatDispenserSchema,
      homeTruthObjectSchema,
      petTreatDispenserCameraSchema,
    ];

    expect(schemas.every((schema) => schema.$schema === "https://json-schema.org/draft/2020-12/schema")).toBe(true);
    expect(new Set(schemas.map((schema) => schema.$id)).size).toBe(schemas.length);
  });

  test("accepts representative capability definitions", () => {
    expectValid("camera", camera);
    expectValid("light", light);
    expectValid("binarySwitch", binarySwitch);
    expectValid("button", button);
    expectValid("motionSensor", motionSensor);
    expectValid("infraredBlaster", infraredBlaster);
    expectValid("infraredReceiver", infraredReceiver);
    expectValid("radioFrequencyBlaster", radioFrequencyBlaster);
    expectValid("radioFrequencyReceiver", radioFrequencyReceiver);
    expectValid("treatDispenser", treatDispenser);
  });

  test("allows a camera to advertise pan left and right without tilt", () => {
    expectValid("camera", camera);
    expect(camera.actions.pan).toHaveProperty("left");
    expect(camera.actions.pan).toHaveProperty("right");
    expect(camera.actions).not.toHaveProperty("tilt");
  });

  test("does not make an offline motion sensor fabricate an observation", () => {
    expectValid("motionSensor", {
      id: "new-motion-sensor",
      state: { availability: "offline" },
    });
    expectInvalid("motionSensor", {
      id: "incomplete-motion-sensor",
      state: { availability: "online", motion: true },
    });
  });

  test("composes camera and treat-dispenser capabilities on a generic object", () => {
    expectValid("homeTruthObject", petTreatDispenserCamera);
  });

  test("composes a binary switch on a generic object", () => {
    expectValid("homeTruthObject", {
      schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null },
      id: "porch-relay-box",
      name: "Porch relay",
      capabilities: { binarySwitch },
    });
    expectInvalid("homeTruthObject", {
      schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null },
      id: "porch-relay-box",
      name: "Porch relay",
      capabilities: { binarySwitch: { ...binarySwitch, state: { ...binarySwitch.state, value: "half" } } },
    });
  });

  test("composes a stateless button on a generic object", () => {
    expectValid("homeTruthObject", {
      schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null },
      id: "candles-on-button",
      name: "Candles on",
      capabilities: { button },
    });
    expectInvalid("button", { ...button, state: { value: "on" } });
  });

  test("requires both capabilities on the pet treat dispenser camera composite", () => {
    expectValid("petTreatDispenserCamera", petTreatDispenserCamera);

    expectInvalid("petTreatDispenserCamera", {
      ...petTreatDispenserCamera,
      capabilities: { camera },
    });
    expectInvalid("petTreatDispenserCamera", {
      ...petTreatDispenserCamera,
      capabilities: { treatDispenser },
    });
  });

  test("rejects unexpected properties at capability and physical-object boundaries", () => {
    expectInvalid("camera", { ...camera, vendorExtension: true });
    expectInvalid("camera", {
      ...camera,
      state: { ...camera.state, vendorState: "surprise" },
    });
    expectInvalid("homeTruthObject", {
      ...petTreatDispenserCamera,
      unexpected: true,
    });
  });

  test("rejects values outside advertised ranges", () => {
    expectInvalid("light", {
      ...light,
      state: { ...light.state, brightnessPercent: 101 },
    });
    expectInvalid("camera", {
      ...camera,
      actions: {
        ...camera.actions,
        pan: {
          ...camera.actions.pan,
          left: { minLeaseMs: 0, maxLeaseMs: 3_000 },
        },
      },
    });
    expectInvalid("treatDispenser", {
      ...treatDispenser,
      actions: {
        dispense: { minimumPortions: 0, maximumPortions: 10, step: 1 },
      },
    });
  });

  test("rejects inverted advertised ranges", () => {
    expectInvalid("camera", {
      ...camera,
      actions: { pan: { left: { minLeaseMs: 3_000, maxLeaseMs: 100 } } },
    });
    expectInvalid("light", {
      ...light,
      actions: {
        setBrightness: { minimumPercent: 80, maximumPercent: 20 },
        setColorTemperature: { minimumKelvin: 6_500, maximumKelvin: 2_000 },
      },
    });
    expectInvalid("motionSensor", {
      ...motionSensor,
      actions: { setClearAfter: { minimumMs: 10_000, maximumMs: 1_000 } },
    });
    expectInvalid("infraredBlaster", {
      ...infraredBlaster,
      actions: { send: { minRepeatCount: 10, maxRepeatCount: 1 } },
    });
    expectInvalid("infraredReceiver", {
      ...infraredReceiver,
      actions: { learn: { minCaptureMs: 10_000, maxCaptureMs: 1_000 } },
    });
    const invertedDispenser = {
      ...treatDispenser,
      actions: {
        dispense: { minimumPortions: 10, maximumPortions: 1, step: 1 },
      },
    };
    expectInvalid("treatDispenser", invertedDispenser);
    expectInvalid("homeTruthObject", {
      ...petTreatDispenserCamera,
      capabilities: { camera, treatDispenser: invertedDispenser },
    });
  });
});
