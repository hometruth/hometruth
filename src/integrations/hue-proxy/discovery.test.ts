import { expect, test } from "bun:test";
import { description, mdnsAnnouncement, ssdpResponse } from "./discovery";
import { parseProxyConfig } from "./config";
const config = parseProxyConfig({ name: "Hue & Home", bridge: { url: "https://10.77.0.2" }, listen: { advertiseAddress: "10.77.0.80" } });
const identity = { bridgeId: "021122FFFE334455", mac: "02:11:22:33:44:55", uuid: "2f402f80-da50-11e1-9b23-021122334455" };
test("SSDP and description consistently advertise the proxy's stable identity", () => {
  const xml = description(config, identity);
  expect(xml).toContain("Hue &amp; Home");
  expect(xml).toContain(`uuid:${identity.uuid}`);
  expect(xml).toContain("http://10.77.0.80:80/");
  const ssdp = ssdpResponse(config, identity, "upnp:rootdevice");
  expect(ssdp).toContain(`hue-bridgeid: ${identity.bridgeId}`);
  expect(ssdp).toContain(`USN: uuid:${identity.uuid}::upnp:rootdevice`);
  expect(ssdp).toContain("LOCATION: http://10.77.0.80:80/description.xml");
  expect(ssdpResponse(config, identity, "upnp:rootdevice", true, false)).toContain("NTS: ssdp:byebye");
});
test("mDNS advertises PTR, SRV, TXT and IPv4 records including a zero-TTL goodbye", () => {
  const packet = mdnsAnnouncement(config, identity);
  expect(packet.readUInt16BE(2)).toBe(0x8400);
  expect(packet.readUInt16BE(6)).toBe(5);
  expect(packet.includes(Buffer.from(`bridgeid=${identity.bridgeId}`))).toBe(true);
  expect(packet.includes(Buffer.from("modelid=BSB002"))).toBe(true);
  expect(packet.subarray(-4)).toEqual(Buffer.from([10, 77, 0, 80]));
  expect(mdnsAnnouncement(config, identity, 0, 123).readUInt16BE(0)).toBe(123);
});
