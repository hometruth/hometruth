import { describe, expect, test } from "bun:test";
import { SonosSoapClient, SonosSoapError, type SonosFetch } from "./soap-client";

function soapResponse(bodyXml: string, status = 200): Response {
  return new Response(
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${bodyXml}</s:Body></s:Envelope>`,
    { status },
  );
}

describe("SonosSoapClient", () => {
  test("rejects a non-LAN host", () => {
    expect(() => new SonosSoapClient({ host: "sonos.example.com" })).toThrow(SonosSoapError);
  });

  test("play/pause/stop send the right SOAPACTION and InstanceID", async () => {
    const calls: { url: string; soapaction: string | null; body: string }[] = [];
    const fakeFetch: SonosFetch = async (input, init) => {
      calls.push({ url: String(input), soapaction: new Headers(init?.headers).get("SOAPACTION"), body: String(init?.body) });
      return soapResponse("<u:PlayResponse/>");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    await client.play();
    await client.pause();
    await client.stop();

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("http://10.77.0.170:1400/MediaRenderer/AVTransport/Control");
    expect(calls[0]?.soapaction).toBe('"urn:schemas-upnp-org:service:AVTransport:1#Play"');
    expect(calls[0]?.body).toContain("<InstanceID>0</InstanceID>");
    expect(calls[1]?.soapaction).toBe('"urn:schemas-upnp-org:service:AVTransport:1#Pause"');
    expect(calls[2]?.soapaction).toBe('"urn:schemas-upnp-org:service:AVTransport:1#Stop"');
  });

  test("setAvTransportUri escapes special characters in the URI and metadata", async () => {
    const bodies: string[] = [];
    const fakeFetch: SonosFetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return soapResponse("<u:SetAVTransportURIResponse/>");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    await client.setAvTransportUri("http://host/clip.wav?a=1&b=2", '<Title value="x">say</Title>');

    expect(bodies[0]).toContain("<CurrentURI>http://host/clip.wav?a=1&amp;b=2</CurrentURI>");
    expect(bodies[0]).toContain("&lt;Title value=&quot;x&quot;&gt;say&lt;/Title&gt;");
  });

  test("getVolume/setVolume/getMute/setMute hit RenderingControl with Channel=Master", async () => {
    const calls: { url: string; soapaction: string | null; body: string }[] = [];
    const fakeFetch: SonosFetch = async (input, init) => {
      const soapaction = new Headers(init?.headers).get("SOAPACTION");
      calls.push({ url: String(input), soapaction, body: String(init?.body) });
      if (soapaction?.includes("GetVolume")) {
        return soapResponse("<u:GetVolumeResponse><CurrentVolume>42</CurrentVolume></u:GetVolumeResponse>");
      }
      if (soapaction?.includes("GetMute")) {
        return soapResponse("<u:GetMuteResponse><CurrentMute>1</CurrentMute></u:GetMuteResponse>");
      }
      return soapResponse("<ok/>");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    expect(await client.getVolume()).toBe(42);
    await client.setVolume(200);
    expect(await client.getMute()).toBe(true);
    await client.setMute(true);

    expect(calls[0]?.url).toBe("http://10.77.0.170:1400/MediaRenderer/RenderingControl/Control");
    expect(calls[0]?.body).toContain("<Channel>Master</Channel>");
    expect(calls[1]?.soapaction).toBe('"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"');
    expect(calls[1]?.body).toContain("<DesiredVolume>100</DesiredVolume>");
    expect(calls[3]?.body).toContain("<DesiredMute>1</DesiredMute>");
  });

  test("getTransportInfo/getPositionInfo/getMediaInfo parse response bodies", async () => {
    const fakeFetch: SonosFetch = async (_input, init) => {
      const soapaction = new Headers(init?.headers).get("SOAPACTION") ?? "";
      if (soapaction.includes("GetTransportInfo")) {
        return soapResponse("<u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus></u:GetTransportInfoResponse>");
      }
      if (soapaction.includes("GetPositionInfo")) {
        return soapResponse("<u:GetPositionInfoResponse><Track>1</Track><TrackDuration>0:03:30</TrackDuration><TrackURI>http://host/clip.wav</TrackURI><RelTime>0:00:42</RelTime></u:GetPositionInfoResponse>");
      }
      return soapResponse("<u:GetMediaInfoResponse><CurrentURI>http://host/clip.wav</CurrentURI></u:GetMediaInfoResponse>");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    expect(await client.getTransportInfo()).toEqual({ state: "PLAYING", status: "OK" });
    expect(await client.getPositionInfo()).toEqual({
      track: 1,
      duration: "0:03:30",
      relTime: "0:00:42",
      uri: "http://host/clip.wav",
    });
    expect(await client.getMediaInfo()).toEqual({ currentUri: "http://host/clip.wav" });
  });

  test("getZoneGroupState parses coordinator and members", async () => {
    const zoneGroupStateXml = `&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator="RINCON_AAA" ID="RINCON_AAA:1"&gt;&lt;ZoneGroupMember UUID="RINCON_AAA" Location="http://10.77.0.170:1400/xml/device_description.xml"/&gt;&lt;ZoneGroupMember UUID="RINCON_BBB" Location="http://10.77.0.171:1400/xml/device_description.xml"/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;`;
    const fakeFetch: SonosFetch = async () =>
      soapResponse(`<u:GetZoneGroupStateResponse><ZoneGroupState>${zoneGroupStateXml}</ZoneGroupState></u:GetZoneGroupStateResponse>`);
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    const groups = await client.getZoneGroupState();
    expect(groups).toEqual([{
      coordinatorUuid: "RINCON_AAA",
      members: [
        { uuid: "RINCON_AAA", host: "10.77.0.170" },
        { uuid: "RINCON_BBB", host: "10.77.0.171" },
      ],
    }]);
  });

  test("getZoneGroupState resolves satellites nested in a home-theater coordinator's member tag", async () => {
    // A home-theater group (soundbar + surrounds + sub) nests each satellite
    // as <Satellite .../> inside the coordinator's own non-self-closing
    // <ZoneGroupMember>...</ZoneGroupMember>, unlike a plain stereo pair
    // where every member is its own self-closing <ZoneGroupMember/>.
    const zoneGroupStateXml = `&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator="RINCON_SOUNDBAR" ID="x"&gt;&lt;ZoneGroupMember UUID="RINCON_SOUNDBAR" Location="http://10.77.0.142:1400/xml/device_description.xml" ZoneName="LR"&gt;&lt;Satellite UUID="RINCON_SUB" Location="http://10.77.0.195:1400/xml/device_description.xml" ZoneName="LR"/&gt;&lt;Satellite UUID="RINCON_RIGHT_REAR" Location="http://10.77.0.232:1400/xml/device_description.xml" ZoneName="LR"/&gt;&lt;Satellite UUID="RINCON_LEFT_REAR" Location="http://10.77.0.132:1400/xml/device_description.xml" ZoneName="LR"/&gt;&lt;/ZoneGroupMember&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;`;
    const fakeFetch: SonosFetch = async () =>
      soapResponse(`<u:GetZoneGroupStateResponse><ZoneGroupState>${zoneGroupStateXml}</ZoneGroupState></u:GetZoneGroupStateResponse>`);
    const client = new SonosSoapClient({ host: "10.77.0.142", fetch: fakeFetch });

    const groups = await client.getZoneGroupState();

    expect(groups).toEqual([{
      coordinatorUuid: "RINCON_SOUNDBAR",
      members: [
        { uuid: "RINCON_SOUNDBAR", host: "10.77.0.142" },
        { uuid: "RINCON_SUB", host: "10.77.0.195" },
        { uuid: "RINCON_RIGHT_REAR", host: "10.77.0.232" },
        { uuid: "RINCON_LEFT_REAR", host: "10.77.0.132" },
      ],
    }]);
  });

  test("becomeCoordinatorOfStandaloneGroup sends the right action", async () => {
    const calls: (string | null)[] = [];
    const fakeFetch: SonosFetch = async (_input, init) => {
      calls.push(new Headers(init?.headers).get("SOAPACTION"));
      return soapResponse("<ok/>");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    await client.becomeCoordinatorOfStandaloneGroup();
    expect(calls[0]).toBe('"urn:schemas-upnp-org:service:AVTransport:1#BecomeCoordinatorOfStandaloneGroup"');
  });

  test("getSpeakerUuid extracts the UDN from device_description.xml", async () => {
    const fakeFetch: SonosFetch = async (input) => {
      expect(String(input)).toBe("http://10.77.0.170:1400/xml/device_description.xml");
      return new Response("<root><device><UDN>uuid:RINCON_5CAAFD11AA0801400</UDN></device></root>");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    expect(await client.getSpeakerUuid()).toBe("RINCON_5CAAFD11AA0801400");
  });

  test("throws SonosSoapError with code fault on a non-2xx SOAP response", async () => {
    const fakeFetch: SonosFetch = async () =>
      soapResponse('<s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorDescription>Invalid InstanceID</errorDescription></UPnPError></detail></s:Fault>', 500);
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    await expect(client.play()).rejects.toThrow(SonosSoapError);
    await expect(client.play()).rejects.toMatchObject({ code: "fault" });
  });

  test("throws SonosSoapError with code unreachable when fetch rejects", async () => {
    const fakeFetch: SonosFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const client = new SonosSoapClient({ host: "10.77.0.170", fetch: fakeFetch });

    await expect(client.play()).rejects.toMatchObject({ code: "unreachable" });
  });
});
