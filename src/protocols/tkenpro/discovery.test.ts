import { describe, expect, test } from "bun:test";
import {
  CAMERA_PROBE_PORTS,
  dedupeDiscoveryObservations,
  discoverCameras,
  enumeratePrivateCidr,
  isCompatiblePetCamera,
  isLocalProbeHost,
  isLikelyCameraObservation,
  parseMeariLanResponse,
  parseSsdpResponse,
  parseWsDiscoveryResponse,
  type DatagramExchange,
  type DatagramTransport,
} from "./discovery";

const encoder = new TextEncoder();

describe("camera discovery parsing", () => {
  test("parses namespace-independent WS-Discovery ProbeMatches", () => {
    const xml = `<?xml version="1.0"?>
      <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
        xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
        xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
        <s:Body><d:ProbeMatches><d:ProbeMatch>
          <a:EndpointReference><a:Address>urn:uuid:camera-one</a:Address></a:EndpointReference>
          <d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
          <d:Scopes>onvif://www.onvif.org/name/TKENPRO onvif://www.onvif.org/type/video_encoder</d:Scopes>
          <d:XAddrs>http://10.77.0.44/onvif/device_service http://camera.local/onvif/device_service</d:XAddrs>
        </d:ProbeMatch></d:ProbeMatches></s:Body>
      </s:Envelope>`;

    expect(parseWsDiscoveryResponse(xml, "10.77.0.44")).toEqual([{
      source: "ws-discovery",
      sourceAddress: "10.77.0.44",
      endpointReference: "urn:uuid:camera-one",
      types: ["dn:NetworkVideoTransmitter", "tds:Device"],
      scopes: ["onvif://www.onvif.org/name/TKENPRO", "onvif://www.onvif.org/type/video_encoder"],
      locations: ["http://10.77.0.44/onvif/device_service", "http://camera.local/onvif/device_service"],
      openPorts: [],
    }]);
  });

  test("parses SSDP headers case-insensitively and ignores requests", () => {
    const response = [
      "HTTP/1.1 200 OK",
      "LOCATION: http://10.77.0.44/device.xml",
      "Usn: uuid:camera-one::urn:schemas-upnp-org:device:Basic:1",
      "SERVER: TKENPRO/1.0 UPnP/1.1",
      "ST: urn:schemas-upnp-org:device:Basic:1",
      "",
      "",
    ].join("\r\n");
    expect(parseSsdpResponse(response, "10.77.0.44")).toMatchObject({
      source: "ssdp",
      sourceAddress: "10.77.0.44",
      usn: "uuid:camera-one::urn:schemas-upnp-org:device:Basic:1",
      locations: ["http://10.77.0.44/device.xml"],
    });
    expect(parseSsdpResponse("M-SEARCH * HTTP/1.1\r\n\r\n", "10.77.0.44")).toBeUndefined();
  });

  test("parses TKENPRO/Meari account-free LAN replies", () => {
    expect(parseMeariLanResponse(JSON.stringify({
      ip: "10.77.0.147",
      sn: "PET3T-1234",
      serialno: "100000001",
      deviceName: "Kitchen treats",
      version: "5.7.3",
      model: "PET3T",
      p2p_uuid: "camera-p2p-one",
      capability: JSON.stringify({ ver: 92, caps: { ovf: 1, ptz: 3 } }),
      mask: "255.255.255.0",
      gw: "10.77.0.1",
      tp: "ipc",
    }), "10.77.0.147")).toEqual({
      source: "meari-lan",
      sourceAddress: "10.77.0.147",
      endpointReference: "urn:uuid:camera-p2p-one",
      server: "PET3T",
      model: "PET3T",
      firmware: "5.7.3",
      serialNumber: "100000001",
      deviceName: "Kitchen treats",
      onvifAdvertised: true,
      types: ["meari:camera"],
      scopes: ["meari://device/serial/100000001", "meari://device/model/PET3T"],
      locations: [],
      openPorts: [],
    });
    expect(parseMeariLanResponse('{"discovery":{}}', "10.77.0.147")).toBeUndefined();
  });

  test("filters unrelated SSDP devices from camera results", () => {
    expect(isLikelyCameraObservation({
      source: "ssdp",
      sourceAddress: "10.77.0.132",
      server: "Linux UPnP/1.0 Sonos/96.1",
      types: ["urn:schemas-upnp-org:device:ZonePlayer:1"],
      scopes: [],
      locations: ["http://10.77.0.132:1400/xml/device_description.xml"],
      openPorts: [],
    })).toBeFalse();
    expect(isLikelyCameraObservation({
      source: "ssdp",
      sourceAddress: "10.77.0.44",
      types: ["urn:schemas-upnp-org:device:Basic:1"],
      scopes: [],
      locations: ["http://10.77.0.44/device.xml"],
      openPorts: [],
    })).toBeTrue();
  });

  test("deduplicates multicast and active-probe observations", () => {
    const cameras = dedupeDiscoveryObservations([
      {
        source: "ws-discovery",
        sourceAddress: "10.77.0.44",
        endpointReference: "urn:uuid:camera-one",
        types: ["dn:NetworkVideoTransmitter"],
        scopes: [],
        locations: ["http://10.77.0.44/onvif/device_service"],
        openPorts: [],
      },
      {
        source: "ssdp",
        sourceAddress: "10.77.0.44",
        usn: "uuid:camera-one::upnp:rootdevice",
        server: "Camera/1.0",
        types: ["upnp:rootdevice"],
        scopes: [],
        locations: ["http://10.77.0.44/device.xml"],
        openPorts: [],
      },
      {
        source: "probe",
        sourceAddress: "10.77.0.44",
        types: [],
        scopes: [],
        locations: ["http://10.77.0.44:8000/onvif/device_service"],
        openPorts: [8000, 8554],
      },
    ]);

    expect(cameras).toHaveLength(1);
    expect(cameras[0]).toMatchObject({
      id: "uuid:camera-one",
      host: "10.77.0.44",
      sources: ["ws-discovery", "ssdp", "probe"],
      openPorts: [8000, 8554],
    });
    expect(cameras[0]?.onvifEndpoints).toEqual([
      "http://10.77.0.44/onvif/device_service",
      "http://10.77.0.44:8000/onvif/device_service",
    ]);
  });
});

describe("bounded active probing", () => {
  test("enumerates private CIDRs without network and rejects broad/public ranges", () => {
    expect(enumeratePrivateCidr("192.168.7.0/30")).toEqual(["192.168.7.1", "192.168.7.2"]);
    expect(enumeratePrivateCidr("10.0.0.8/31")).toEqual(["10.0.0.8", "10.0.0.9"]);
    expect(() => enumeratePrivateCidr("192.168.0.0/16", 64)).toThrow("contains 65534 hosts");
    expect(() => enumeratePrivateCidr("8.8.8.0/30")).toThrow("Refusing non-local CIDR");
    expect(isLocalProbeHost("camera.local")).toBeTrue();
    expect(isLocalProbeHost("172.31.2.4")).toBeTrue();
    expect(isLocalProbeHost("172.32.2.4")).toBeFalse();
  });

  test("combines injected multicast replies and bounded port probes", async () => {
    const exchanges: DatagramExchange[] = [];
    const datagrams: DatagramTransport = {
      async exchange(request) {
        exchanges.push(request);
        if (request.port !== 3702) return [];
        return [{
          address: "10.77.0.44",
          port: 3702,
          data: encoder.encode(`<ProbeMatch xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery">
            <EndpointReference><Address>urn:uuid:camera-one</Address></EndpointReference>
            <Types>NetworkVideoTransmitter</Types>
            <XAddrs>http://10.77.0.44/onvif/device_service</XAddrs>
          </ProbeMatch>`),
        }];
      },
    };
    const probes: Array<{ host: string; port: number; timeoutMs: number }> = [];
    const endpointProbes: string[] = [];
    const report = await discoverCameras({
      hosts: ["10.77.0.44", "8.8.8.8"],
      ports: CAMERA_PROBE_PORTS,
      multicastTimeoutMs: 123,
      probeTimeoutMs: 234,
      probeConcurrency: 3,
    }, {
      datagrams,
      async probePort(host, port, timeoutMs) {
        probes.push({ host, port, timeoutMs });
        return port === 80 || port === 8554;
      },
      async probeOnvifEndpoint(url) {
        endpointProbes.push(url);
        return true;
      },
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });

    expect(exchanges.map((exchange) => exchange.port).sort()).toEqual([1900, 3702, 3702, 3703]);
    expect(exchanges.every((exchange) => exchange.timeoutMs === 123)).toBeTrue();
    expect(probes).toHaveLength(CAMERA_PROBE_PORTS.length);
    expect(probes.every((probe) => probe.host === "10.77.0.44" && probe.timeoutMs === 234)).toBeTrue();
    expect(endpointProbes).toEqual(["http://10.77.0.44:80/onvif/device_service"]);
    expect(report.errors).toContain("Probe: refusing non-local host 8.8.8.8");
    expect(report.cameras).toHaveLength(1);
    expect(report.cameras[0]?.openPorts).toEqual([80, 8554]);
  });

  test("probes the first complete subnet instead of cancelling when later interface CIDRs exceed the total cap", async () => {
    const probedHosts: string[] = [];
    const report = await discoverCameras({
      wsDiscovery: false,
      meariLan: false,
      ssdp: false,
      cidrs: ["10.78.0.0/30", "192.168.97.0/30"],
      ports: [554],
      maxProbeHosts: 3,
    }, {
      async probePort(host) {
        probedHosts.push(host);
        return false;
      },
    });

    expect(probedHosts).toEqual(["10.78.0.1", "10.78.0.2"]);
    expect(report.errors).toContain("Probe: later CIDRs skipped to keep active discovery within the 3-host limit.");
    expect(report.cameras).toEqual([]);
  });

  test("discovers a camera through the TKENPRO/Meari JSON broadcast", async () => {
    const requests: DatagramExchange[] = [];
    const report = await discoverCameras({
      wsDiscovery: false,
      ssdp: false,
      meariLan: true,
    }, {
      datagrams: {
        async exchange(request) {
          requests.push(request);
          if (request.port !== 3703) return [];
          return [{
            address: "10.77.0.147",
            port: 3703,
            data: encoder.encode('{"ip":"10.77.0.147","sn":"PET3T-1234","model":"PET3T"}'),
          }];
        },
      },
    });

    expect(report.errors).toEqual([]);
    expect(report.cameras).toHaveLength(1);
    expect(report.cameras[0]).toMatchObject({
      id: "uuid:pet3t-1234",
      host: "10.77.0.147",
      sources: ["meari-lan"],
      server: "PET3T",
    });
    expect(requests.find((request) => request.port === 3703)?.bindPort).toBe(6969);
  });
});

describe("isCompatiblePetCamera", () => {
  const base = {
    id: "host:10.78.0.147",
    host: "10.78.0.147",
    sources: [] as ("ws-discovery" | "meari-lan" | "ssdp" | "probe")[],
    types: [] as string[],
    scopes: [] as string[],
    locations: [] as string[],
    onvifEndpoints: [] as string[],
    openPorts: [] as number[],
  };

  test("accepts a Meari LAN broadcast responder", () => {
    expect(isCompatiblePetCamera({ ...base, sources: ["meari-lan"] })).toBe(true);
  });

  test("accepts a meari:camera type or meari:// scope", () => {
    expect(isCompatiblePetCamera({ ...base, types: ["meari:camera"] })).toBe(true);
    expect(isCompatiblePetCamera({ ...base, scopes: ["meari://device/model/Pet3T"] })).toBe(true);
  });

  test("accepts vendor evidence in the server banner or model", () => {
    expect(isCompatiblePetCamera({ ...base, server: "TKENPRO-IPC" })).toBe(true);
    expect(isCompatiblePetCamera({ ...base, model: "Meari Pet 3T" })).toBe(true);
    expect(isCompatiblePetCamera({ ...base, model: "Pet 3T" })).toBe(true);
  });

  test("rejects an unrelated ONVIF camera", () => {
    expect(isCompatiblePetCamera({
      ...base,
      sources: ["ws-discovery"],
      server: "Hikvision-DS",
      model: "DS-2CD2042",
      locations: ["http://10.78.0.50/onvif/device_service"],
    })).toBe(false);
  });
});
