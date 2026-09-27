import { describe, expect, test } from "bun:test";
import type { DatagramExchange, DatagramTransport } from "../tkenpro/discovery";
import { createSonosSsdpSearch, discoverSonosSpeakers } from "./discovery";

const encoder = new TextEncoder();

function sonosSsdpReply(address: string): { address: string; port: number; data: Uint8Array } {
  const response = [
    "HTTP/1.1 200 OK",
    `LOCATION: http://${address}:1400/xml/device_description.xml`,
    "USN: uuid:RINCON_5CAAFD11AA0801400::urn:schemas-upnp-org:device:ZonePlayer:1",
    "SERVER: Linux UPnP/1.0 Sonos/96.1",
    "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
    "",
    "",
  ].join("\r\n");
  return { address, port: 1900, data: encoder.encode(response) };
}

function cameraSsdpReply(address: string): { address: string; port: number; data: Uint8Array } {
  const response = [
    "HTTP/1.1 200 OK",
    `LOCATION: http://${address}/device.xml`,
    "USN: uuid:camera-one::urn:schemas-upnp-org:device:Basic:1",
    "SERVER: TKENPRO/1.0 UPnP/1.1",
    "ST: urn:schemas-upnp-org:device:Basic:1",
    "",
    "",
  ].join("\r\n");
  return { address, port: 1900, data: encoder.encode(response) };
}

describe("createSonosSsdpSearch", () => {
  test("targets the ZonePlayer device type", () => {
    const text = new TextDecoder().decode(createSonosSsdpSearch());
    expect(text).toContain("M-SEARCH * HTTP/1.1");
    expect(text).toContain("ST: urn:schemas-upnp-org:device:ZonePlayer:1");
    expect(text).toContain("HOST: 239.255.255.250:1900");
  });
});

describe("discoverSonosSpeakers", () => {
  test("returns one entry per Sonos player found", async () => {
    const exchanges: DatagramExchange[] = [];
    const datagrams: DatagramTransport = {
      async exchange(request) {
        exchanges.push(request);
        return [sonosSsdpReply("10.77.0.170")];
      },
    };

    const speakers = await discoverSonosSpeakers({}, { datagrams });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.address).toBe("239.255.255.250");
    expect(exchanges[0]?.port).toBe(1900);
    expect(speakers).toEqual([{
      host: "10.77.0.170",
      server: "Linux UPnP/1.0 Sonos/96.1",
      usn: "uuid:RINCON_5CAAFD11AA0801400::urn:schemas-upnp-org:device:ZonePlayer:1",
      location: "http://10.77.0.170:1400/xml/device_description.xml",
    }]);
  });

  test("filters out non-ZonePlayer SSDP replies", async () => {
    const datagrams: DatagramTransport = {
      async exchange() {
        return [cameraSsdpReply("10.77.0.44"), sonosSsdpReply("10.77.0.170")];
      },
    };

    const speakers = await discoverSonosSpeakers({}, { datagrams });

    expect(speakers).toHaveLength(1);
    expect(speakers[0]?.host).toBe("10.77.0.170");
  });

  test("dedupes multiple replies from the same host", async () => {
    const datagrams: DatagramTransport = {
      async exchange() {
        return [sonosSsdpReply("10.77.0.170"), sonosSsdpReply("10.77.0.170")];
      },
    };

    const speakers = await discoverSonosSpeakers({}, { datagrams });

    expect(speakers).toHaveLength(1);
  });
});
