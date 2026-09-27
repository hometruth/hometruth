import { describe, expect, test } from "bun:test";
import { decodeMsgSvrFrame, encodeMsgSvrFrame, MSGSVR_COMMANDS, MSGSVR_METHODS, MSGSVR_NODES } from "./msgsvr.ts";
import { buildMeariLocalRootDiscoveryResponse } from "./root-emulator.ts";

describe("Meari local root discovery", () => {
  test("redirects an app or camera root query to the local platform server", () => {
    for (const node of [MSGSVR_NODES.APP, MSGSVR_NODES.CAMERA]) {
      const query = encodeMsgSvrFrame({
        node,
        method: MSGSVR_METHODS.DIRECT,
        command: MSGSVR_COMMANDS.STATUS,
        payload: { action: "conf", uuid: "0123456789abcdef", ver: 15_259, t: "1700000000.125" },
      });
      const response = decodeMsgSvrFrame(buildMeariLocalRootDiscoveryResponse(query, {
        advertisedHost: "192.0.2.20",
        signalingPort: 18_665,
      }));
      expect(response).toMatchObject({
        node: MSGSVR_NODES.DNS_SERVER,
        method: MSGSVR_METHODS.ROUTED,
        command: MSGSVR_COMMANDS.STATUS,
        payload: {
          action: "conf",
          uuid: "0123456789abcdef",
          contact: {
            node: "pssvr",
            domain: "hometruth.local",
            transport: "tcp",
            type: "binary",
            ip: "192.0.2.20",
            port: 18_665,
          },
          host: "hometruth.local",
          dns: { ip: "192.0.2.20", port: 18_661 },
          dnssvr: {
            node: "dnssvr",
            domain: "hometruth.local",
            transport: "udp",
            type: "binary",
            ip: "192.0.2.20",
            port: 9_255,
          },
          dnssvr_host: "hometruth.local",
        },
      });
    }
  });

  test("rejects unrelated datagrams", () => {
    const query = encodeMsgSvrFrame({
      node: MSGSVR_NODES.CAMERA,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.HEARTBEAT,
      payload: { action: "heartbeat" },
    });
    expect(() => buildMeariLocalRootDiscoveryResponse(query, {
      advertisedHost: "192.0.2.20",
      signalingPort: 18_665,
    })).toThrow("Unexpected root discovery request");
  });

  test("mirrors the camera's two-stage regional root topology", () => {
    const query = encodeMsgSvrFrame({
      node: MSGSVR_NODES.CAMERA,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.STATUS,
      payload: { action: "conf", uuid: "0123456789abcdef", ver: 15_259 },
    });
    const root = decodeMsgSvrFrame(buildMeariLocalRootDiscoveryResponse(query, {
      advertisedHost: "192.0.2.20",
      signalingPort: 18_665,
      nestedDnsPort: 9_255,
      domain: "natsvr.us",
      dnsDomain: "dnssvr.us",
      responseKind: "root",
    }));
    expect(root.payload).toEqual({
      action: "conf",
      uuid: "0123456789abcdef",
      dnssvr: {
        node: "dnssvr",
        domain: "dnssvr.us",
        transport: "udp",
        type: "binary",
        ip: "192.0.2.20",
        port: 9_255,
      },
      dnssvr_host: "dnssvr.us",
    });

    const parent = decodeMsgSvrFrame(buildMeariLocalRootDiscoveryResponse(query, {
      advertisedHost: "192.0.2.20",
      signalingPort: 18_665,
      dnsPort: 18_661,
      domain: "natsvr.us",
      dnsDomain: "dnssvr.us",
      responseKind: "parent",
    }));
    expect(parent.payload).toEqual({
      action: "conf",
      uuid: "0123456789abcdef",
      contact: {
        node: "natsvr",
        domain: "natsvr.us",
        transport: "tcp",
        type: "binary",
        ip: "192.0.2.20",
        port: 18_665,
      },
      host: "natsvr.us",
      dns: { ip: "192.0.2.20", port: 18_661 },
    });
  });
});
