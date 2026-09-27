import { describe, expect, test } from "bun:test";
import { PcapStreamDecoder, type PacketFact } from "./pcap-stream";

/** Builds a little-endian pcap file (Ethernet link type) from raw frames. */
function pcap(frames: readonly Uint8Array[]): Uint8Array {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0xa1b2c3d4, true); view.setUint16(4, 2, true); view.setUint16(6, 4, true); view.setUint32(16, 65_535, true); view.setUint32(20, 1, true);
  const parts: Uint8Array[] = [header];
  for (const frame of frames) {
    const record = new Uint8Array(16);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(8, frame.length, true); recordView.setUint32(12, frame.length, true);
    parts.push(record, frame);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function ip(text: string): number[] { return text.split(".").map(Number); }

/** An Ethernet + 802.1Q(vlan 3) + IPv4 frame with the given L4 protocol and payload. */
function frame(source: string, destination: string, protocol: 6 | 17, l4: Uint8Array): Uint8Array {
  const total = 14 + 4 + 20 + l4.length;
  const out = new Uint8Array(total);
  out.set([0x8c, 0x30, 0x66, 0, 0, 1, 0x1c, 0x4e, 0xa2, 0, 0, 2, 0x81, 0x00, 0x00, 0x03, 0x08, 0x00], 0);
  const ipOffset = 18;
  out[ipOffset] = 0x45; out[ipOffset + 2] = ((20 + l4.length) >> 8) & 0xff; out[ipOffset + 3] = (20 + l4.length) & 0xff; out[ipOffset + 8] = 64; out[ipOffset + 9] = protocol;
  out.set(ip(source), ipOffset + 12); out.set(ip(destination), ipOffset + 16);
  out.set(l4, ipOffset + 20);
  return out;
}

function udp(destinationPort: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0xc0; out[1] = 0x01; out[2] = (destinationPort >> 8) & 0xff; out[3] = destinationPort & 0xff; out[4] = (out.length >> 8) & 0xff; out[5] = out.length & 0xff;
  out.set(payload, 8);
  return out;
}

function tcp(destinationPort: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(20 + payload.length);
  out[0] = 0xc0; out[1] = 0x02; out[2] = (destinationPort >> 8) & 0xff; out[3] = destinationPort & 0xff; out[12] = 0x50; out[13] = flags;
  out.set(payload, 20);
  return out;
}

function dnsQuery(name: string): Uint8Array {
  const labels = name.split(".").flatMap((label) => [label.length, ...new TextEncoder().encode(label)]);
  return new Uint8Array([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, 1, 0, 1]);
}

function clientHello(serverName: string): Uint8Array {
  const name = new TextEncoder().encode(serverName);
  const sni = [0, 0, 0, name.length + 5, 0, name.length + 3, 0, 0, name.length, ...name];
  const body = [3, 3, ...new Array<number>(32).fill(7), 0, 0, 2, 0x13, 0x01, 1, 0, 0, sni.length, ...sni];
  const handshake = [1, 0, 0, body.length, ...body];
  return new Uint8Array([0x16, 3, 1, 0, handshake.length, ...handshake]);
}

describe("PcapStreamDecoder", () => {
  const CAMERA = "10.78.0.147";

  function decode(frames: readonly Uint8Array[], chunk = 5): PacketFact[] {
    const facts: PacketFact[] = [];
    const decoder = new PcapStreamDecoder({ clientAddress: CAMERA, onFact: (fact) => facts.push(fact) });
    const bytes = pcap(frames);
    for (let offset = 0; offset < bytes.length; offset += chunk) decoder.push(bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
    return facts;
  }

  test("reports DNS lookups, TLS server names, plain HTTP requests and first-seen destinations from the client only", () => {
    const facts = decode([
      frame(CAMERA, "10.78.0.1", 17, udp(53, dnsQuery("meari-oss-us.oss-us-west-1.aliyuncs.com"))),
      frame("10.78.0.1", CAMERA, 17, udp(53, dnsQuery("ignored.answer.example"))), // inbound: skipped
      frame(CAMERA, "47.88.37.113", 6, tcp(80, 0x02)),
      frame(CAMERA, "47.88.37.113", 6, tcp(80, 0x18, new TextEncoder().encode("PUT /7e/v/1/2/x.jpgx3 HTTP/1.1\r\nHost: meari-oss-us.oss-us-west-1.aliyuncs.com\r\nContent-Length: 0\r\n\r\n"))),
      frame(CAMERA, "3.136.187.63", 6, tcp(443, 0x02)),
      frame(CAMERA, "3.136.187.63", 6, tcp(443, 0x02)), // repeat SYN: reported once
      frame(CAMERA, "3.136.187.63", 6, tcp(443, 0x18, clientHello("apis-us-west.cloudedge360.com"))),
      frame(CAMERA, "17.253.4.125", 17, udp(123, new Uint8Array(48))),
    ]);
    expect(facts).toEqual([
      { kind: "dns_query", name: "meari-oss-us.oss-us-west-1.aliyuncs.com", server: "10.78.0.1" },
      { kind: "tcp_connect", destination: "47.88.37.113", port: 80 },
      { kind: "http_request", method: "PUT", host: "meari-oss-us.oss-us-west-1.aliyuncs.com", path: "/7e/v/1/2/x.jpgx3", destination: "47.88.37.113", port: 80 },
      { kind: "tcp_connect", destination: "3.136.187.63", port: 443 },
      { kind: "tls_client_hello", serverName: "apis-us-west.cloudedge360.com", destination: "3.136.187.63", port: 443 },
      { kind: "udp_send", destination: "17.253.4.125", port: 123 },
    ]);
  });

  test("gives the same facts whatever the chunk boundaries", () => {
    const frames = [frame(CAMERA, "10.78.0.1", 17, udp(53, dnsQuery("usce.mearicloud.com"))), frame(CAMERA, "1.2.3.4", 6, tcp(18665, 0x02))];
    for (const chunk of [1, 3, 64, 100_000]) expect(decode(frames, chunk)).toEqual(decode(frames, 7));
  });

  test("rejects a stream that is not a pcap", () => {
    const decoder = new PcapStreamDecoder({ clientAddress: CAMERA, onFact: () => undefined });
    expect(() => decoder.push(new Uint8Array(30))).toThrow(/Not a pcap stream/u);
  });
});
