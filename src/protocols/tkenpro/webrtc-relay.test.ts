import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import {
  decodeMsgSvrFrame,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
} from "./msgsvr.ts";
import {
  MeariLocalWebRtcRelayServer,
  decodeMeariWebRtcRelayConnect,
  encodeMeariWebRtcRelayAccepted,
} from "./webrtc-relay.ts";

const TAG = "ba44acf701";

function connectFrame(): Buffer {
  return encodeMsgSvrFrame({
    node: MSGSVR_NODES.CAMERA,
    method: MSGSVR_METHODS.DIRECT,
    command: MSGSVR_COMMANDS.WEBRTC,
    type: 0xd1,
    payload: Buffer.concat([Buffer.from(TAG), Buffer.from([0x84, 0, 0, 0, 0, 0])]),
    encrypted: false,
  });
}

describe("Meari local WebRTC relay broker", () => {
  test("decodes the captured camera ticket and recreates the acceptance frame", () => {
    expect(decodeMeariWebRtcRelayConnect(decodeMsgSvrFrame(connectFrame()))).toMatchObject({
      tag: TAG,
    });
    expect(decodeMsgSvrFrame(encodeMeariWebRtcRelayAccepted(TAG))).toMatchObject({
      node: MSGSVR_NODES.WEBRTC_SERVER,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.WEBRTC,
      type: 0xd1,
      encrypted: false,
      payloadBytes: Buffer.concat([Buffer.from(TAG), Buffer.from([0x04, 1, 0, 0, 0, 0])]),
    });
  });

  test("accepts only a live tag from an authorized source", async () => {
    const observed: string[] = [];
    const relay = new MeariLocalWebRtcRelayServer({
      host: "127.0.0.1",
      port: 0,
      allowSourceAddress: (address) => address === "127.0.0.1",
      onConnect: (connection) => observed.push(connection.tag),
    });
    relay.authorizeTag(TAG);
    const port = await relay.start();
    const socket = createConnection({ host: "127.0.0.1", port });
    try {
      const response = new Promise<Buffer>((resolve, reject) => {
        socket.once("data", (bytes) => resolve(Buffer.from(bytes)));
        socket.once("error", reject);
      });
      socket.write(connectFrame());
      expect(decodeMsgSvrFrame(await response).payloadBytes.subarray(0, 10).toString("ascii")).toBe(TAG);
      expect(observed).toEqual([TAG]);
      expect(relay.acceptedConnectionCount).toBe(1);
    } finally {
      socket.destroy();
      await relay.stop();
    }
  });
});
