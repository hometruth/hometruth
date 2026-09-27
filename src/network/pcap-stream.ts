/**
 * An incremental decoder for a libpcap byte stream (what `tcpdump -w -`
 * writes), reporting structural facts about one client's traffic and never
 * payload bytes: DNS lookups and their answers, TLS server names, plain HTTP
 * request lines, and new TCP/UDP destinations. It is what turns an
 * access-point capture into the isolation log a person can read.
 *
 * Feed it chunks in arrival order with `push()`; it buffers partial records
 * across chunk boundaries. Ethernet (link type 1) with any number of 802.1Q
 * VLAN tags, and raw IPv4 (link type 101), are understood; anything else is
 * counted and skipped. IPv6 is counted as `other` for now.
 */

export type PacketFact =
  | { readonly kind: "dns_query"; readonly name: string; readonly server: string }
  | { readonly kind: "dns_answer"; readonly name: string; readonly addresses: readonly string[] }
  | { readonly kind: "tls_client_hello"; readonly serverName: string; readonly destination: string; readonly port: number }
  | { readonly kind: "http_request"; readonly method: string; readonly host: string; readonly path: string; readonly destination: string; readonly port: number }
  /** A new connection (SYN), or `resumed` when the first thing seen is data on a flow that predates the capture. */
  | { readonly kind: "tcp_connect"; readonly destination: string; readonly port: number; readonly resumed?: boolean }
  | { readonly kind: "udp_send"; readonly destination: string; readonly port: number };

export interface PcapStreamOptions {
  /** Only this address's outbound packets produce facts (its answers and inbound traffic are ignored). */
  readonly clientAddress: string;
  readonly onFact: (fact: PacketFact) => void;
}

const MAGICS = new Map<number, { little: boolean }>([
  [0xa1b2c3d4, { little: true }], [0xa1b23c4d, { little: true }],
  [0xd4c3b2a1, { little: false }], [0x4d3cb2a1, { little: false }],
]);

function ipv4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function dnsName(message: Uint8Array, start: number): { name: string; end: number } {
  const labels: string[] = [];
  let offset = start;
  let end = start;
  let jumped = false;
  for (let guard = 0; guard < 128 && offset < message.length; guard += 1) {
    const length = message[offset]!;
    if (length === 0) {
      if (!jumped) end = offset + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | (message[offset + 1] ?? 0);
      if (!jumped) end = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }
    labels.push(new TextDecoder().decode(message.subarray(offset + 1, offset + 1 + length)));
    offset += 1 + length;
    if (!jumped) end = offset;
  }
  return { name: labels.join("."), end };
}

export class PcapStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private little = true;
  private linkType = 1;
  private headerRead = false;
  private readonly seenTcp = new Set<string>();
  private readonly seenUdp = new Set<string>();
  /** Packets that were not IPv4 from the client (inbound, ARP, IPv6, …). */
  skipped = 0;
  packets = 0;

  constructor(private readonly options: PcapStreamOptions) {}

  push(chunk: Uint8Array): void {
    if (this.buffer.length === 0) this.buffer = chunk;
    else {
      const joined = new Uint8Array(this.buffer.length + chunk.length);
      joined.set(this.buffer, 0);
      joined.set(chunk, this.buffer.length);
      this.buffer = joined;
    }
    let offset = 0;
    if (!this.headerRead) {
      if (this.buffer.length < 24) return;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const magic = view.getUint32(0, true);
      const known = MAGICS.get(magic);
      if (!known) throw new Error(`Not a pcap stream (magic 0x${magic.toString(16)})`);
      this.little = known.little;
      this.linkType = view.getUint32(20, this.little);
      this.headerRead = true;
      offset = 24;
    }
    for (;;) {
      if (offset + 16 > this.buffer.length) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 16);
      const captured = view.getUint32(8, this.little);
      if (offset + 16 + captured > this.buffer.length) break;
      this.packet(this.buffer.subarray(offset + 16, offset + 16 + captured));
      offset += 16 + captured;
    }
    this.buffer = offset >= this.buffer.length ? new Uint8Array(0) : this.buffer.slice(offset);
  }

  private packet(frame: Uint8Array): void {
    this.packets += 1;
    let l3 = 0;
    if (this.linkType === 1) {
      if (frame.length < 14) { this.skipped += 1; return; }
      let etherType = (frame[12]! << 8) | frame[13]!;
      l3 = 14;
      while (etherType === 0x8100 || etherType === 0x88a8) {
        if (frame.length < l3 + 4) { this.skipped += 1; return; }
        etherType = (frame[l3 + 2]! << 8) | frame[l3 + 3]!;
        l3 += 4;
      }
      if (etherType !== 0x0800) { this.skipped += 1; return; }
    } else if (this.linkType !== 101) { this.skipped += 1; return; }
    if (frame.length < l3 + 20 || (frame[l3]! >> 4) !== 4) { this.skipped += 1; return; }
    const headerLength = (frame[l3]! & 0x0f) * 4;
    const protocol = frame[l3 + 9]!;
    const source = ipv4(frame, l3 + 12);
    if (source !== this.options.clientAddress) { this.skipped += 1; return; }
    const destination = ipv4(frame, l3 + 16);
    const l4 = l3 + headerLength;
    if (protocol === 17 && frame.length >= l4 + 8) {
      const port = (frame[l4 + 2]! << 8) | frame[l4 + 3]!;
      const payload = frame.subarray(l4 + 8);
      if (port === 53) this.dns(payload, destination);
      else {
        const key = `${destination}:${port}`;
        if (!this.seenUdp.has(key)) {
          this.seenUdp.add(key);
          this.options.onFact({ kind: "udp_send", destination, port });
        }
      }
      return;
    }
    if (protocol === 6 && frame.length >= l4 + 20) {
      const port = (frame[l4 + 2]! << 8) | frame[l4 + 3]!;
      const flags = frame[l4 + 13]!;
      const dataOffset = (frame[l4 + 12]! >> 4) * 4;
      if ((flags & 0x02) !== 0 && (flags & 0x10) === 0) {
        const key = `${destination}:${port}`;
        if (!this.seenTcp.has(key)) {
          this.seenTcp.add(key);
          this.options.onFact({ kind: "tcp_connect", destination, port });
        }
      }
      const payload = frame.subarray(l4 + dataOffset);
      if (payload.length === 0) return;
      const flow = `${destination}:${port}`;
      if (!this.seenTcp.has(flow)) {
        this.seenTcp.add(flow);
        this.options.onFact({ kind: "tcp_connect", destination, port, resumed: true });
      }
      if (payload[0] === 0x16) this.tls(payload, destination, port);
      else this.http(payload, destination, port);
      return;
    }
    this.skipped += 1;
  }

  private dns(payload: Uint8Array, server: string): void {
    if (payload.length < 12) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const isResponse = (payload[2]! & 0x80) !== 0;
    const questions = view.getUint16(4);
    let offset = 12;
    let queried = "";
    for (let index = 0; index < questions && offset < payload.length; index += 1) {
      const { name, end } = dnsName(payload, offset);
      queried = name;
      offset = end + 4;
    }
    if (!queried) return;
    if (!isResponse) {
      this.options.onFact({ kind: "dns_query", name: queried, server });
      return;
    }
    // A response *from* the client is unusual (mDNS); only A answers are reported, as the client-address filter already applied.
    const answers = view.getUint16(6);
    const addresses: string[] = [];
    for (let index = 0; index < answers && offset + 10 <= payload.length; index += 1) {
      const { end } = dnsName(payload, offset);
      offset = end;
      const type = view.getUint16(offset);
      const length = view.getUint16(offset + 8);
      offset += 10;
      if (type === 1 && length === 4 && offset + 4 <= payload.length) addresses.push(ipv4(payload, offset));
      offset += length;
    }
    if (addresses.length > 0) this.options.onFact({ kind: "dns_answer", name: queried, addresses });
  }

  private tls(payload: Uint8Array, destination: string, port: number): void {
    // TLS record (type 22 handshake) carrying a ClientHello (type 1); walk to the SNI extension.
    if (payload.length < 45 || payload[5] !== 0x01) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 43;
    offset += 1 + payload[offset]!;
    if (offset + 2 > payload.length) return;
    offset += 2 + view.getUint16(offset);
    if (offset + 1 > payload.length) return;
    offset += 1 + payload[offset]!;
    if (offset + 2 > payload.length) return;
    const extensionsEnd = Math.min(offset + 2 + view.getUint16(offset), payload.length);
    offset += 2;
    while (offset + 4 <= extensionsEnd) {
      const type = view.getUint16(offset);
      const length = view.getUint16(offset + 2);
      offset += 4;
      if (type === 0 && offset + 5 <= payload.length) {
        const nameType = payload[offset + 2];
        const nameLength = view.getUint16(offset + 3);
        const start = offset + 5;
        if (nameType === 0 && start + nameLength <= payload.length) {
          this.options.onFact({ kind: "tls_client_hello", serverName: new TextDecoder().decode(payload.subarray(start, start + nameLength)), destination, port });
        }
        return;
      }
      offset += length;
    }
  }

  private http(payload: Uint8Array, destination: string, port: number): void {
    const head = new TextDecoder("latin1").decode(payload.subarray(0, Math.min(payload.length, 1_024)));
    const line = /^([A-Z]{3,10}) (\S{1,512}) HTTP\/1\.[01]\r\n/u.exec(head);
    if (!line) return;
    const host = /\r\nhost: ?([^\r\n]{1,253})/iu.exec(head)?.[1]?.trim() ?? "";
    this.options.onFact({ kind: "http_request", method: line[1]!, host, path: line[2]!, destination, port });
  }
}
