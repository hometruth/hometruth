import { describe, expect, test } from "bun:test";
import { MeariLocalCloudEmulator, type MeariLocalCloudEvent } from "./cloud-emulator.ts";
import {
  decodeMeariRoutedPayload,
  encodeMeariRoutedPayload,
  encodeMeariRoutedPayloads,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  type MeariRouteContact,
} from "./msgsvr.ts";
import { MeariMsgSvrTcpTransport } from "./signaling.ts";

type UnknownRecord = Record<string, unknown>;

const CAMERA_UUID = "0123456789abcdef";
const CAMERA_PASSWORD = "camera-registration-proof";
const CAMERA_CONTACT: MeariRouteContact = {
  node: "dev",
  domain: CAMERA_UUID,
  transport: "tcp",
  type: "binary",
};
const DATA_CONTACT: MeariRouteContact = {
  node: "datasvr",
  domain: "hometruth.local",
  transport: "tcp",
  type: "binary",
  ip: "127.0.0.1",
  port: 18_665,
};

function cameraFrame(content: unknown, payload?: Record<string, unknown>): Buffer {
  return encodeMsgSvrFrame({
    node: MSGSVR_NODES.CAMERA,
    method: MSGSVR_METHODS.ROUTED,
    command: MSGSVR_COMMANDS.WEBRTC,
    payload: payload ?? encodeMeariRoutedPayload({
      from: CAMERA_CONTACT,
      to: DATA_CONTACT,
      content,
    }),
  });
}

function settingsContent(framePayload: unknown): UnknownRecord {
  return decodeMeariRoutedPayload<UnknownRecord>(framePayload).content;
}

async function registerCamera(
  transport: MeariMsgSvrTcpTransport,
  password = CAMERA_PASSWORD,
): Promise<UnknownRecord> {
  await transport.send(encodeMsgSvrFrame({
    node: MSGSVR_NODES.CAMERA,
    method: MSGSVR_METHODS.DIRECT,
    command: MSGSVR_COMMANDS.REGISTER,
    payload: {
      action: "register",
      uuid: CAMERA_UUID,
      transport: "tcp",
      type: "binary",
      nat: { local_port: 40_000, medium: [{ mode: "xts", transport: "udp", type: "binary" }] },
      ver: 15_213,
      runtime: 29,
      password,
      t: "1700000000.125",
      extra_params: { clientid: "camera-model" },
    },
  }));
  return (await transport.receive()).payload as UnknownRecord;
}

describe("Meari local cloud emulator", () => {
  test("registers, authenticates, syncs state, answers heartbeats, and completes local commands", async () => {
    const events: MeariLocalCloudEvent[] = [];
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      dataPort: 0,
      advertisedHost: "127.0.0.1",
      routedDevicePort: 18_857,
      bootstrapIotKeys: ["124", "238"],
      initialStates: new Map([[CAMERA_UUID, { "103": 0, "124": 1, "238": 1 }]]),
      now: () => 1_700_000_000_000,
      issueToken: () => "local-session-token",
      authorizeRegistration: (registration) => (
        registration.uuid === CAMERA_UUID && registration.password === CAMERA_PASSWORD
      ),
      onEvent: (event) => events.push(event),
    });
    const port = await emulator.start();
    const camera = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    try {
      const registration = await registerCamera(camera);
      expect(registration).toMatchObject({
        action: "register",
        uuid: CAMERA_UUID,
        result: "OK",
        token: "local-session-token",
        ver: 17_516,
        domain: "hometruth.local",
        hb: 35,
        ht: 5,
      });
      expect(emulator.connectedDeviceUuids).toEqual([CAMERA_UUID]);
      expect(emulator.hasRoutedContact(CAMERA_UUID)).toBe(false);

      await camera.send(cameraFrame({
        sid: "1700000000",
        uuid: CAMERA_UUID,
        cmd: "conf",
        action: "req",
        method: "settings",
        params: { code: 100001, action: "get", name: "iot" },
      }));
      expect(settingsContent((await camera.receive()).payload)).toMatchObject({
        sid: "1700000000",
        action: "rsp",
        params: { code: 100001, action: "get", name: "iot", iot: { "124": 1, "238": 1 } },
      });

      // Re-saving an already active server-backed value is a genuine no-op:
      // no direct frame is sent to firmware and no channel recycle is needed.
      expect(await emulator.setIot(CAMERA_UUID, { "124": 1 })).toMatchObject({
        action: "rsp",
        params: { code: 100001, action: "set", name: "iot", iot: { "124": 1 } },
      });

      const sync = {
        sid: "1700000001",
        uuid: CAMERA_UUID,
        cmd: "conf",
        action: "sync",
        method: "settings",
        params: {
          code: 100001,
          action: "sync",
          name: "iot",
          iot: { "103": 1, "843": "x".repeat(1_700) },
        },
      };
      const fragments = encodeMeariRoutedPayloads({
        from: CAMERA_CONTACT,
        to: DATA_CONTACT,
        content: sync,
      }, { tag: 123, fragmentId: 17 });
      expect(fragments.length).toBeGreaterThan(1);
      for (const payload of fragments) await camera.send(cameraFrame(sync, payload));
      expect(settingsContent((await camera.receive()).payload)).toMatchObject({
        sid: "1700000001",
        action: "ack",
        params: { code: 100001, action: "sync", name: "iot" },
      });
      expect(emulator.getDeviceState(CAMERA_UUID)).toMatchObject({ "103": 1 });
      expect(emulator.hasRoutedContact(CAMERA_UUID)).toBe(true);

      await camera.send(encodeMsgSvrFrame({
        node: MSGSVR_NODES.CAMERA,
        method: MSGSVR_METHODS.DIRECT,
        command: MSGSVR_COMMANDS.HEARTBEAT,
        payload: {
          uuid: CAMERA_UUID,
          token: "local-session-token",
          ver: 15_213,
          runtime: 67,
          t: "1700000001.125",
        },
      }));
      expect((await camera.receive()).payload).toMatchObject({
        ver: 17_516,
        domain: "hometruth.local",
        t: "1700000000",
      });

      const commandPromise = emulator.setIot(CAMERA_UUID, { "842": "{}" });
      const commandFrame = await camera.receive();
      expect(commandFrame).toMatchObject({
        node: MSGSVR_NODES.DATA_SERVER,
        method: MSGSVR_METHODS.ROUTED,
        command: MSGSVR_COMMANDS.WEBRTC,
      });
      const command = settingsContent(commandFrame.payload);
      expect(command).toMatchObject({
        uuid: CAMERA_UUID,
        action: "req",
        cmd: "conf",
        method: "settings",
        params: { code: 100001, action: "set", name: "iot", iot: { "842": "{}" } },
      });
      await camera.send(cameraFrame({
        sid: command.sid,
        action: "rsp",
        cmd: "conf",
        method: "settings",
        uuid: CAMERA_UUID,
        params: { code: 100001, name: "iot", action: "set" },
      }));
      expect(await commandPromise).toMatchObject({ sid: command.sid, action: "rsp" });
      expect(emulator.getDeviceState(CAMERA_UUID)).toMatchObject({ "842": "{}" });

      const webRtcContact: MeariRouteContact = {
        node: "webrtcsvr",
        domain: "webrtcsvr.us",
        transport: "tcp",
        type: "binary",
        ip: "127.0.0.1",
        port: 9_371,
      };
      const offerPromise = emulator.requestRouted(CAMERA_UUID, {
        sid: "local-client:01",
        cmd: "offer",
        caller: "local-client",
        callee: CAMERA_UUID,
        sdp: "local-offer",
      }, { from: webRtcContact });
      const offerFrame = await camera.receive();
      expect(offerFrame).toMatchObject({
        node: MSGSVR_NODES.CAMERA_WEBRTC_SERVER,
        method: MSGSVR_METHODS.ROUTED,
        command: MSGSVR_COMMANDS.WEBRTC,
      });
      const offerMessage = decodeMeariRoutedPayload<UnknownRecord>(offerFrame.payload);
      expect(offerMessage.from).toEqual(webRtcContact);
      expect(offerMessage.to).toMatchObject({
        ...CAMERA_CONTACT,
        ip: "127.0.0.1",
        port: emulator.routedDevicePort,
      });
      expect(offerMessage.content).toMatchObject({
        sid: "local-client:01",
        cmd: "offer",
        sdp: "local-offer",
      });
      await camera.send(cameraFrame({
        sid: "local-client:01",
        cmd: "answer",
        sdp: "camera-answer",
      }));
      expect(await offerPromise).toMatchObject({ cmd: "answer", sdp: "camera-answer" });
      expect(events).toContainEqual({ type: "registered", uuid: CAMERA_UUID });
      expect(events.some((event) => event.type === "settings" && event.source === "sync")).toBe(true);
    } finally {
      camera.close();
      await emulator.stop();
    }
  });

  test("rejects a camera whose local registration proof is not authorized", async () => {
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      advertisedHost: "127.0.0.1",
      authorizeRegistration: (registration) => registration.password === CAMERA_PASSWORD,
    });
    expect(emulator.issueToken()).toMatch(/^[0-9a-f]{6}$/u);
    const port = await emulator.start();
    const camera = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    try {
      expect(await registerCamera(camera, "wrong-proof")).toMatchObject({
        action: "register",
        uuid: CAMERA_UUID,
        result: "FAIL",
      });
      expect(emulator.connectedDeviceUuids).toEqual([]);
    } finally {
      camera.close();
      await emulator.stop();
    }
  });

  test("delivers changed server-backed settings through an authenticated bootstrap reconnect", async () => {
    const events: MeariLocalCloudEvent[] = [];
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      dataPort: 0,
      advertisedHost: "127.0.0.1",
      bootstrapIotKeys: ["124", "238"],
      initialStates: new Map([[CAMERA_UUID, { "124": 1, "238": 1 }]]),
      authorizeRegistration: () => true,
      onEvent: (event) => events.push(event),
    });
    const port = await emulator.start();
    const platform = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    const data = await MeariMsgSvrTcpTransport.connect("127.0.0.1", emulator.dataPort);
    let refreshed: MeariMsgSvrTcpTransport | undefined;
    try {
      await registerCamera(platform);
      await registerCamera(data);

      const update = emulator.setIot(CAMERA_UUID, { "124": 0 }, 2_000);
      await Bun.sleep(10);
      refreshed = await MeariMsgSvrTcpTransport.connect("127.0.0.1", emulator.dataPort);
      await registerCamera(refreshed);
      await refreshed.send(cameraFrame({
        sid: "1700000010",
        uuid: CAMERA_UUID,
        cmd: "conf",
        action: "req",
        method: "settings",
        params: { code: 100001, action: "get", name: "iot" },
      }));
      expect(settingsContent((await refreshed.receive()).payload)).toMatchObject({
        sid: "1700000010",
        action: "rsp",
        params: { code: 100001, action: "get", name: "iot", iot: { "124": 0, "238": 1 } },
      });
      expect(await update).toMatchObject({
        action: "rsp",
        params: { code: 100001, action: "set", name: "iot", iot: { "124": 0 } },
      });
      expect(emulator.getDeviceState(CAMERA_UUID)).toMatchObject({ "124": 0, "238": 1 });
      expect(events).toContainEqual({
        type: "settings",
        uuid: CAMERA_UUID,
        source: "response",
        values: { "124": 0 },
      });
    } finally {
      refreshed?.close();
      data.close();
      platform.close();
      await emulator.stop();
    }
  });

  test("keeps parallel platform/data sockets and fails commands over to a surviving socket", async () => {
    const events: MeariLocalCloudEvent[] = [];
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      dataPort: 0,
      advertisedHost: "127.0.0.1",
      authorizeRegistration: () => true,
      onEvent: (event) => events.push(event),
    });
    const port = await emulator.start();
    const platform = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    const dataServer = await MeariMsgSvrTcpTransport.connect("127.0.0.1", emulator.dataPort);
    try {
      await registerCamera(platform);
      await registerCamera(dataServer);
      expect(emulator.connectedDeviceUuids).toEqual([CAMERA_UUID]);

      const firstCommand = emulator.setIot(CAMERA_UUID, { "103": 1 });
      const firstFrame = await dataServer.receive();
      const firstContent = settingsContent(firstFrame.payload);
      await dataServer.send(cameraFrame({
        sid: firstContent.sid,
        action: "rsp",
        cmd: "conf",
        method: "settings",
        uuid: CAMERA_UUID,
        params: { code: 100001, name: "iot", action: "set" },
      }));
      await firstCommand;

      const dataSession = emulator.sessions.get(CAMERA_UUID);
      dataServer.close();
      for (let attempt = 0; attempt < 40 && emulator.sessions.get(CAMERA_UUID) === dataSession; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(emulator.connectedDeviceUuids).toEqual([CAMERA_UUID]);
      expect(events.filter((event) => event.type === "disconnected")).toHaveLength(0);

      const secondCommand = emulator.setIot(CAMERA_UUID, { "103": 0 });
      const secondFrame = await platform.receive();
      const secondContent = settingsContent(secondFrame.payload);
      await platform.send(cameraFrame({
        sid: secondContent.sid,
        action: "rsp",
        cmd: "conf",
        method: "settings",
        uuid: CAMERA_UUID,
        params: { code: 100001, name: "iot", action: "set" },
      }));
      await secondCommand;
    } finally {
      platform.close();
      dataServer.close();
      await emulator.stop();
    }
  });

  test("routes peer negotiation over the oldest authenticated platform socket", async () => {
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      dataPort: 0,
      advertisedHost: "127.0.0.1",
      authorizeRegistration: () => true,
    });
    const port = await emulator.start();
    const platform = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    const dataServer = await MeariMsgSvrTcpTransport.connect("127.0.0.1", emulator.dataPort);
    try {
      await registerCamera(platform);
      await registerCamera(dataServer);
      const request = emulator.requestRouted(CAMERA_UUID, {
        sid: "0123456789abcdef:01",
        cmd: "offer",
      }, { timeoutMs: 1_000 });
      const platformFrame = await platform.receive();
      expect(settingsContent(platformFrame.payload)).toMatchObject({ cmd: "offer" });
      await platform.send(cameraFrame({
        sid: "0123456789abcdef:01",
        cmd: "answer",
        sdp: "camera-answer",
      }));
      expect(await request).toMatchObject({ cmd: "answer", sdp: "camera-answer" });
    } finally {
      platform.close();
      dataServer.close();
      await emulator.stop();
    }
  });

  test("surfaces heartbeat fields beyond uuid/token as a message event, and stays silent when there are none", async () => {
    const events: MeariLocalCloudEvent[] = [];
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      dataPort: 0,
      advertisedHost: "127.0.0.1",
      authorizeRegistration: () => true,
      issueToken: () => "local-session-token",
      onEvent: (event) => events.push(event),
    });
    const port = await emulator.start();
    const camera = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    try {
      await registerCamera(camera);
      events.length = 0;

      // A heartbeat with only identity fields: no message event.
      await camera.send(encodeMsgSvrFrame({
        node: MSGSVR_NODES.CAMERA,
        method: MSGSVR_METHODS.DIRECT,
        command: MSGSVR_COMMANDS.HEARTBEAT,
        payload: { uuid: CAMERA_UUID, token: "local-session-token" },
      }));
      await camera.receive();
      expect(events.filter((event) => event.type === "message")).toEqual([]);

      // A heartbeat carrying extra fields: surfaced, structurally, as a message event.
      await camera.send(encodeMsgSvrFrame({
        node: MSGSVR_NODES.CAMERA,
        method: MSGSVR_METHODS.DIRECT,
        command: MSGSVR_COMMANDS.HEARTBEAT,
        payload: { uuid: CAMERA_UUID, token: "local-session-token", ver: 15_213, alarm: 1, battery: 87 },
      }));
      await camera.receive();
      const messages = events.filter((event) => event.type === "message");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "message",
        uuid: CAMERA_UUID,
        via: "heartbeat",
        content: { ver: 15_213, alarm: 1, battery: 87 },
      });
    } finally {
      camera.close();
      await emulator.stop();
    }
  });

  test("an unrecognized command code is surfaced as a message event, not silently rejected as a protocol error", async () => {
    const events: MeariLocalCloudEvent[] = [];
    const emulator = new MeariLocalCloudEmulator({
      host: "127.0.0.1",
      port: 0,
      dataPort: 0,
      advertisedHost: "127.0.0.1",
      authorizeRegistration: () => true,
      onEvent: (event) => events.push(event),
    });
    const port = await emulator.start();
    const camera = await MeariMsgSvrTcpTransport.connect("127.0.0.1", port);
    try {
      await registerCamera(camera);
      events.length = 0;

      // STATUS (0xc7): documented in the protocol but never handled on this path.
      await camera.send(encodeMsgSvrFrame({
        node: MSGSVR_NODES.CAMERA,
        method: MSGSVR_METHODS.DIRECT,
        command: MSGSVR_COMMANDS.STATUS,
        payload: { uuid: CAMERA_UUID, event: "motion", zone: 2 },
      }));
      // No reply is sent for this path; give the async handler a turn.
      await Bun.sleep(20);

      expect(events.filter((event) => event.type === "protocol-error")).toEqual([]);
      const messages = events.filter((event) => event.type === "message");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "message",
        uuid: CAMERA_UUID,
        via: "unhandled-command",
        content: { uuid: CAMERA_UUID, event: "motion", zone: 2, __unhandledCommand: MSGSVR_COMMANDS.STATUS },
      });
    } finally {
      camera.close();
      await emulator.stop();
    }
  });
});
