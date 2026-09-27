import { describe, expect, test } from "bun:test";
import {
  decodeMsgSvrFrame,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  type MsgSvrFrame,
} from "./msgsvr.ts";
import {
  buildMeariLanOffer,
  createMeariSignalingSessionId,
  decodeMeariRootDiscoveryResponse,
  encodeMeariRootDiscoveryQuery,
  formatMeariDeviceUuid,
  meariClientUuid,
  MeariSignalingClient,
  parseMeariSdp,
  type MeariSignalingTransport,
} from "./signaling.ts";

class FakeTransport implements MeariSignalingTransport {
  readonly localPort = 31_337;
  readonly sent: Buffer[] = [];
  readonly responses: MsgSvrFrame[] = [];

  send(frame: Uint8Array): void {
    this.sent.push(Buffer.from(frame));
  }

  async receive(): Promise<MsgSvrFrame> {
    const response = this.responses.shift();
    if (!response) throw new Error("fake response queue empty");
    return response;
  }

  close(): void {}

  queue(payload: unknown): void {
    this.responses.push(decodeMsgSvrFrame(encodeMsgSvrFrame({
      node: MSGSVR_NODES.SERVER,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.REGISTER,
      payload,
    })));
  }
}

function webRtcEnvelope(inner: unknown, from?: unknown): unknown {
  return {
    ...(from === undefined ? {} : { from }),
    content: Buffer.from(JSON.stringify(inner)).toString("base64"),
  };
}

describe("Meari signaling protocol", () => {
  test("encodes root discovery and parses the current root response shape", () => {
    const query = decodeMsgSvrFrame(encodeMeariRootDiscoveryQuery({
      clientId: "client-1",
      now: () => 1_000,
    }));
    expect(query).toMatchObject({
      node: MSGSVR_NODES.APP,
      command: MSGSVR_COMMANDS.STATUS,
      payload: { action: "conf", ver: 15_259, uuid: "client-1", t: "1.000" },
    });

    const response = encodeMsgSvrFrame({
      node: MSGSVR_NODES.DNS_SERVER,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.STATUS,
      payload: {
        action: "conf",
        contact: {
          node: "pssvr",
          domain: "pssvr.us",
          transport: "tcp",
          type: "binary",
          ip: "192.0.2.10",
          port: 18_843,
        },
        host: "pssvr.example",
      },
    });
    expect(decodeMeariRootDiscoveryResponse(response)).toMatchObject({
      contact: { ip: "192.0.2.10", port: 18_843 },
      host: "pssvr.example",
    });

    const dnsOnly = encodeMsgSvrFrame({
      node: MSGSVR_NODES.DNS_SERVER,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.STATUS,
      payload: {
        action: "conf",
        dnssvr: {
          node: "dnssvr",
          domain: "dnssvr.us",
          transport: "udp",
          type: "binary",
          ip: "192.0.2.53",
          port: 9_255,
        },
      },
    });
    expect(decodeMeariRootDiscoveryResponse(dnsOnly)).toMatchObject({
      dnsServer: { ip: "192.0.2.53", port: 9_255 },
    });
  });

  test("recreates registration, hello, status, and offer envelopes", async () => {
    const transport = new FakeTransport();
    const client = new MeariSignalingClient(transport, { sessionIndex: 2 });
    transport.queue({ result: "OK", uuid: "client-session", token: "token", hb: 20 });
    await client.register({ clientId: "42", clientUuid: "0123456789abcdef" });
    expect(decodeMsgSvrFrame(transport.sent.shift() as Buffer)).toMatchObject({
      command: MSGSVR_COMMANDS.REGISTER,
      payload: {
        action: "register",
        uuid: "0123456789abcdef",
        nat: { local_port: 31_337 },
        extra_params: { brand: "8", clientid: "42" },
      },
    });

    transport.queue(webRtcEnvelope(
      { cmd: "hello", tag: "tag-" },
      {
        node: "webrtcsvr",
        domain: "webrtcsvr.us",
        transport: "tcp",
        type: "binary",
        ip: "192.0.2.20",
        port: 9_371,
      },
    ));
    await client.hello();
    expect(client.webRtcServer).toMatchObject({ ip: "192.0.2.20", tag: "tag-" });

    transport.queue({ action: "status", uuid: "camera", status: "online" });
    expect(await client.queryDeviceStatus("camera")).toMatchObject({ status: "online" });

    transport.queue(webRtcEnvelope({ cmd: "offer", sdp: "answer" }));
    await client.sendOffer("camera", "offer");
    const offerFrame = decodeMsgSvrFrame(transport.sent.at(-1) as Buffer);
    const outer = offerFrame.payload as { content: string };
    expect(JSON.parse(Buffer.from(outer.content, "base64").toString("utf8"))).toMatchObject({
      cmd: "offer",
      sid: "client-session:02",
      callee: "camera",
      tag: "tag-02",
      sdp: "offer",
    });
  });

  test("builds and parses direct-only SDP and stable protocol identities", () => {
    expect(formatMeariDeviceUuid("100000001")).toBe("0000000100000001");
    expect(meariClientUuid("42")).toHaveLength(16);
    const offer = buildMeariLanOffer("10.78.0.231", 59_354);
    expect(parseMeariSdp(offer.sdp)).toMatchObject({
      usernameFragment: offer.usernameFragment,
      password: offer.password,
      candidates: [{ ip: "10.78.0.231", port: 59_354, type: "relay" }],
    });
    expect(offer.sdp).toContain("typ host");
  });

  test("creates fresh timestamp-shaped WebRTC session IDs", () => {
    const now = 1_788_315_913_000;
    const first = createMeariSignalingSessionId(now);
    const second = createMeariSignalingSessionId(now);
    expect(first).toMatch(/^\d{10}$/u);
    expect(second).toBe(String(Number(first) + 1));
  });
});
