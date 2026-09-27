import { describe, expect, test } from "bun:test";
import {
  decodeStunMessage,
  encodeStunMessage,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
} from "./ice.ts";
import { MeariKcpTunnel } from "./kcp-tunnel.ts";
import { decodeMsgSvrFrame, MSGSVR_COMMANDS } from "./msgsvr.ts";
import {
  decodeVvpCommandFrame,
  encodeVvpCommandFrame,
  VVP_COMMAND_RESPONSE,
} from "./p2p-command.ts";
import { MeariPeerCommandSession } from "./peer-command-session.ts";

const auth = {
  hostKey: "0123456789abcdef0123456789abcdef",
  protocolVersion: 2,
  licenceId: "00000000000100000001",
};

describe("Meari peer command session", () => {
  test("performs LAN punch and ICE request/response on one datagram interface", () => {
    const sent: Buffer[] = [];
    const session = new MeariPeerCommandSession({ ...auth, send: (value) => sent.push(value) });

    expect(decodeMsgSvrFrame(session.sendLanConnect("0123abcd"))).toMatchObject({
      command: MSGSVR_COMMANDS.LAN_CONNECT,
      payload: { sid: "0123abcd00000001" },
    });
    const check = session.sendIceCheck({
      localUsernameFragment: "local123",
      remoteUsernameFragment: "camera45",
      remotePassword: "camera-password",
      transactionId: Buffer.alloc(12, 3),
      tieBreaker: 1n,
    });
    expect(decodeStunMessage(check).type).toBe(STUN_BINDING_REQUEST);

    const cameraCheck = encodeStunMessage(STUN_BINDING_REQUEST, [], Buffer.alloc(12, 9));
    expect(session.processDatagram(cameraCheck)[0]).toMatchObject({ type: "ice-check" });
    expect(decodeStunMessage(sent.at(-1) as Buffer)).toMatchObject({
      type: STUN_BINDING_SUCCESS,
      transactionId: Buffer.alloc(12, 9),
    });
  });

  test("runs handshake, authenticated common command, KCP response, and ACK end to end", () => {
    const clientOutbound: Buffer[] = [];
    const cameraOutbound: Buffer[] = [];
    const session = new MeariPeerCommandSession({
      ...auth,
      initialRequestSequence: 20,
      sessionId1: 1,
      sessionId2: 2,
      send: (value) => clientOutbound.push(value),
    });
    const camera = new MeariKcpTunnel({
      sessionId1: 3,
      sessionId2: 4,
      send: (value) => cameraOutbound.push(value),
    });

    const request = session.sendCommonRequest({
      action: "GET",
      deviceurl: "http://127.0.0.1/devices/settings",
    });
    expect(request.sequence).toBe(20);
    expect(clientOutbound).toHaveLength(2);
    for (const datagram of clientOutbound.splice(0)) camera.processDatagram(datagram);
    camera.flushAcks();

    const wireRequest = decodeVvpCommandFrame(camera.pollMessage() as Buffer);
    expect(wireRequest).toMatchObject({ sequence: 20, command: 0x8000 });
    const [header, body] = wireRequest.payload.toString("utf8").split("\r\n\r\n");
    expect(header).toContain("GET /devices/settings HTTP/1.1");
    expect(header).toContain("Content-Length: 0");
    expect(body).toBe("");

    const httpResponse = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n{\"led_enable\":1}",
    );
    camera.sendHandshake();
    camera.sendIvaData(encodeVvpCommandFrame(httpResponse, {
      ...auth,
      sequence: 20,
      command: VVP_COMMAND_RESPONSE,
    }));

    const events = cameraOutbound.splice(0).flatMap((datagram) => session.processDatagram(datagram));
    const response = events.find((event) => event.type === "command-response");
    expect(response).toMatchObject({
      type: "command-response",
      response: {
        requestSequence: 20,
        http: { status: 200, bodyText: '{"led_enable":1}' },
      },
    });
    expect(session.pendingRequestCount).toBe(0);
    expect(clientOutbound.length).toBeGreaterThan(0);
  });
});
