import { createSocket, type Socket } from "node:dgram";
import type { ProxyConfig } from "./config";

export interface BridgeIdentity { bridgeId: string; mac: string; uuid: string }
const escapeXml = (value: string) => value.replace(/[<>&"']/gu, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
export function description(config: ProxyConfig, identity: BridgeIdentity): string {
  return `<?xml version="1.0" encoding="UTF-8"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><URLBase>http://${config.listen.advertiseAddress}:${config.listen.httpPort}/</URLBase><device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType><friendlyName>${escapeXml(config.name)}</friendlyName><manufacturer>Signify</manufacturer><manufacturerURL>https://www.philips-hue.com</manufacturerURL><modelDescription>HomeTruth Hue bridge proxy</modelDescription><modelName>Philips hue bridge 2015</modelName><modelNumber>BSB002</modelNumber><serialNumber>${identity.mac.replaceAll(":", "")}</serialNumber><UDN>uuid:${identity.uuid}</UDN><presentationURL>index.html</presentationURL></device></root>`;
}
export function ssdpResponse(config: ProxyConfig, identity: BridgeIdentity, st: string, notify = false, alive = true): string {
  const usn = `uuid:${identity.uuid}${st.startsWith("uuid:") ? "" : `::${st}`}`;
  return [notify ? "NOTIFY * HTTP/1.1" : "HTTP/1.1 200 OK", "HOST: 239.255.255.250:1900", "CACHE-CONTROL: max-age=120", `LOCATION: http://${config.listen.advertiseAddress}:${config.listen.httpPort}/description.xml`, "SERVER: Linux/1.0 UPnP/1.0 IpBridge/1.0", `hue-bridgeid: ${identity.bridgeId}`, ...(notify ? [`NT: ${st}`, `NTS: ssdp:${alive ? "alive" : "byebye"}`] : [`ST: ${st}`, "EXT:"]), `USN: ${usn}`, "", ""].join("\r\n");
}
const dnsName = (name: string): Buffer => Buffer.concat([...name.split(".").filter(Boolean).map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
/** Uncompressed DNS records keep this small responder independent of DNS libraries. */
export function mdnsAnnouncement(config: ProxyConfig, identity: BridgeIdentity, ttl = 120, queryId = 0): Buffer {
  const type = "_hue._tcp.local";
  const instance = `HomeTruth-${identity.bridgeId}.${type}`;
  const host = `hometruth-hue-${identity.bridgeId.toLowerCase()}.local`;
  const record = (name: string, kind: number, data: Buffer, shared = false) => Buffer.concat([dnsName(name), u16(kind), u16(shared ? 1 : 0x8001), u32(ttl), u16(data.length), data]);
  const txt = [`bridgeid=${identity.bridgeId}`, "modelid=BSB002"];
  const records = [record("_services._dns-sd._udp.local", 12, dnsName(type), true), record(type, 12, dnsName(instance), true), record(instance, 33, Buffer.concat([u16(0), u16(0), u16(config.listen.httpsPort), dnsName(host)])), record(instance, 16, Buffer.concat(txt.map(t => Buffer.concat([Buffer.from([t.length]), Buffer.from(t)])))), record(host, 1, Buffer.from(config.listen.advertiseAddress.split(".").map(Number)))];
  return Buffer.concat([u16(queryId), u16(0x8400), u16(0), u16(records.length), u16(0), u16(0), ...records]);
}

export class Discovery {
  private sockets: Socket[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private announce: ((alive: boolean) => void) | undefined;
  constructor(private readonly config: ProxyConfig, private readonly identity: BridgeIdentity, private readonly error: () => void) {}
  async start(): Promise<void> {
    const ssdp = createSocket({ type: "udp4", reuseAddr: true });
    const mdns = createSocket({ type: "udp4", reuseAddr: true });
    this.sockets = [ssdp, mdns];
    const bind = async (socket: Socket, port: number, multicast: string) => {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(port, "0.0.0.0", () => { socket.off("error", reject); resolve(); });
      });
      socket.on("error", this.error);
      socket.addMembership(multicast, this.config.listen.advertiseAddress);
      socket.setMulticastInterface(this.config.listen.advertiseAddress);
      socket.setMulticastTTL(1);
    };
    try {
      await bind(ssdp, 1900, "239.255.255.250");
      await bind(mdns, 5353, "224.0.0.251");
    } catch (error) { this.stop(); throw error; }
    const types = ["upnp:rootdevice", `uuid:${this.identity.uuid}`, "urn:schemas-upnp-org:device:basic:1"];
    ssdp.on("message", (data, remote) => {
      if (data.length > 8192) return;
      const message = data.toString();
      if (!/^M-SEARCH \* HTTP\/1\.1\r?\n/iu.test(message) || !/ssdp:discover/iu.test(message)) return;
      const st = /^ST:\s*(.+)\r?$/imu.exec(message)?.[1]?.trim();
      const match = types.filter(type => st?.toLowerCase() === type.toLowerCase() || st === "ssdp:all");
      for (const type of match) ssdp.send(ssdpResponse(this.config, this.identity, type), remote.port, remote.address);
    });
    // DNS questions can use compression. A Hue service or this unique host
    // label necessarily occurs in the packet, including compressed queries.
    mdns.on("message", (data, remote) => {
      if (data.length < 12 || data.length > 9000 || data[2]! & 0x80) return;
      if (!data.includes(Buffer.from("_hue")) && !data.includes(Buffer.from("_services")) && !data.includes(Buffer.from(`hometruth-hue-${this.identity.bridgeId.toLowerCase()}`)) && !data.includes(Buffer.from(`HomeTruth-${this.identity.bridgeId}`))) return;
      const legacy = remote.port !== 5353;
      mdns.send(mdnsAnnouncement(this.config, this.identity, 120, legacy ? data.readUInt16BE(0) : 0), legacy ? remote.port : 5353, legacy ? remote.address : "224.0.0.251");
    });
    this.announce = alive => {
      for (const type of types) ssdp.send(ssdpResponse(this.config, this.identity, type, true, alive), 1900, "239.255.255.250");
      mdns.send(mdnsAnnouncement(this.config, this.identity, alive ? 120 : 0), 5353, "224.0.0.251");
    };
    this.announce(true);
    this.timer = setInterval(() => this.announce?.(true), 60_000);
  }
  stop(): void {
    clearInterval(this.timer);
    this.announce?.(false); this.announce = undefined;
    for (const socket of this.sockets) { try { socket.close(); } catch {} }
    this.sockets = [];
  }
}
