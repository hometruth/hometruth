import { describe, expect, test } from "bun:test";
import {
  OnvifClient,
  buildRtspCandidates,
  createDigestAuthorization,
  createUsernameToken,
  parseWwwAuthenticate,
  redactRtspUri,
  type OnvifFetch,
} from "./client";

function soap(body: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe("ONVIF authentication", () => {
  test("creates a deterministic WS-Security UsernameToken digest", () => {
    const token = createUsernameToken(
      "camera-user",
      "verySecret",
      new Date("2003-07-16T01:24:32.000Z"),
      Uint8Array.from(Buffer.from("WScqanjCEAC4mQoBE07sAQ==", "base64")),
    );
    expect(token).toEqual({
      username: "camera-user",
      created: "2003-07-16T01:24:32.000Z",
      nonce: "WScqanjCEAC4mQoBE07sAQ==",
      passwordDigest: "kCoii/cHIVf0+FVa6MKqtEu6RvE=",
    });
  });

  test("parses combined challenges and matches the RFC HTTP Digest example", () => {
    const challenges = parseWwwAuthenticate(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41", Basic realm="fallback"',
    );
    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({ scheme: "Digest", parameters: { realm: "testrealm@host.com", qop: "auth,auth-int" } });
    const challenge = challenges[0];
    if (challenge === undefined) throw new Error("missing challenge");
    const authorization = createDigestAuthorization({
      username: "Mufasa",
      password: "Circle Of Life",
      method: "GET",
      url: "http://www.example.com/dir/index.html",
      challenge,
      nonceCount: 1,
      clientNonce: "0a4f113b",
    });
    expect(authorization).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(authorization).toContain("qop=auth");
    expect(authorization).toContain("nc=00000001");
  });

  test("retries an HTTP Digest challenge without also sending WS-Security", async () => {
    const requests: RequestInit[] = [];
    const responses = [
      new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Digest realm="camera", nonce="abcdef", qop="auth", algorithm=MD5' },
      }),
      new Response(soap(`<tds:GetDeviceInformationResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
        <tds:Manufacturer>TKENPRO</tds:Manufacturer><tds:Model>Pet Cam</tds:Model>
        <tds:FirmwareVersion>1.2.3</tds:FirmwareVersion><tds:SerialNumber>SN1</tds:SerialNumber><tds:HardwareId>HW1</tds:HardwareId>
      </tds:GetDeviceInformationResponse>`)),
    ];
    const fakeFetch: OnvifFetch = async (_input, init) => {
      requests.push(init ?? {});
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    };
    const client = new OnvifClient({
      deviceServiceUrl: "http://10.77.0.44/onvif/device_service",
      username: "admin",
      password: "correct-password",
    }, {
      fetch: fakeFetch,
      nonce: () => new Uint8Array([1, 2, 3, 4]),
    });

    expect(await client.getDeviceInformation()).toEqual({
      manufacturer: "TKENPRO",
      model: "Pet Cam",
      firmwareVersion: "1.2.3",
      serialNumber: "SN1",
      hardwareId: "HW1",
    });
    expect(requests).toHaveLength(2);
    expect(requestHeader(requests[0], "authorization")).toBeNull();
    expect(requestHeader(requests[1], "authorization")).toStartWith("Digest ");
    expect(String(requests[1]?.body)).not.toContain("UsernameToken");
  });

  test("falls back to UsernameToken after an HTTP 400 SOAP authorization fault", async () => {
    const bodies: string[] = [];
    const responses = [
      new Response(soap(`<s:Fault xmlns:s="http://www.w3.org/2003/05/soap-envelope">
        <s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text>ter:NotAuthorized</s:Text></s:Reason>
      </s:Fault>`), { status: 400 }),
      new Response(soap(`<tds:GetDeviceInformationResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
        <tds:Manufacturer>TKENPRO</tds:Manufacturer><tds:Model>Pet Cam</tds:Model>
        <tds:FirmwareVersion>1</tds:FirmwareVersion><tds:SerialNumber>2</tds:SerialNumber><tds:HardwareId>3</tds:HardwareId>
      </tds:GetDeviceInformationResponse>`)),
    ];
    const client = new OnvifClient({
      deviceServiceUrl: "http://camera.local/onvif/device_service",
      username: "owner",
      password: "secret-value",
    }, {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      nonce: () => new Uint8Array([9, 8, 7, 6]),
    });

    await client.getDeviceInformation();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toContain("UsernameToken");
    expect(bodies[1]).toContain("<wsse:Username>owner</wsse:Username>");
    expect(bodies[1]).toContain("#PasswordDigest");
    expect(bodies[1]).not.toContain("secret-value");
  });
});

describe("ONVIF services and controls", () => {
  test("parses capabilities, services, profiles, URIs, PTZ, presets, and imaging", async () => {
    const calls: string[] = [];
    const fakeFetch: OnvifFetch = async (_input, init) => {
      const action = requestHeader(init, "soapaction") ?? "";
      calls.push(action);
      if (action.includes("GetCapabilities")) return new Response(soap(`<tds:GetCapabilitiesResponse xmlns:tds="${"http://www.onvif.org/ver10/device/wsdl"}" xmlns:tt="http://www.onvif.org/ver10/schema"><tds:Capabilities>
        <tt:Device><tt:XAddr>http://camera/onvif/device_service</tt:XAddr></tt:Device>
        <tt:Media><tt:XAddr>http://camera/onvif/media_service</tt:XAddr></tt:Media>
        <tt:PTZ><tt:XAddr>http://camera/onvif/ptz_service</tt:XAddr></tt:PTZ>
        <tt:Imaging><tt:XAddr>http://camera/onvif/imaging_service</tt:XAddr></tt:Imaging>
      </tds:Capabilities></tds:GetCapabilitiesResponse>`));
      if (action.includes("GetServices")) return new Response(soap(`<tds:GetServicesResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><tds:Service>
        <tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>http://camera/onvif/media_service</tds:XAddr>
        <tds:Version><tt:Major>2</tt:Major><tt:Minor>4</tt:Minor></tds:Version>
      </tds:Service></tds:GetServicesResponse>`));
      if (action.includes("GetProfiles")) return new Response(soap(`<trt:GetProfilesResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><trt:Profiles token="main" fixed="true">
        <tt:Name>Main stream</tt:Name><tt:VideoSourceConfiguration token="source-1"><tt:Name>sensor</tt:Name></tt:VideoSourceConfiguration>
        <tt:VideoEncoderConfiguration token="encoder-1"><tt:Name>H264 main</tt:Name><tt:Encoding>H264</tt:Encoding>
          <tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality>
          <tt:RateControl><tt:FrameRateLimit>20</tt:FrameRateLimit><tt:BitrateLimit>2048</tt:BitrateLimit></tt:RateControl>
        </tt:VideoEncoderConfiguration><tt:PTZConfiguration token="ptz-1"><tt:Name>PTZ</tt:Name></tt:PTZConfiguration>
      </trt:Profiles></trt:GetProfilesResponse>`));
      if (action.includes("GetStreamUri")) return new Response(soap(`<trt:GetStreamUriResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:MediaUri>
        <trt:Uri>rtsp://camera:8554/profile0?x=1&amp;y=2</trt:Uri><trt:InvalidAfterConnect>false</trt:InvalidAfterConnect>
        <trt:InvalidAfterReboot>true</trt:InvalidAfterReboot><trt:Timeout>PT60S</trt:Timeout>
      </trt:MediaUri></trt:GetStreamUriResponse>`));
      if (action.includes("GetSnapshotUri")) return new Response(soap(`<trt:GetSnapshotUriResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:MediaUri><trt:Uri>http://camera/snapshot.jpg</trt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`));
      if (action.includes("GetNodes")) return new Response(soap(`<tptz:GetNodesResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><tptz:PTZNode token="node-1">
        <tt:Name>Motor</tt:Name><tt:HomeSupported>true</tt:HomeSupported><tt:MaximumNumberOfPresets>8</tt:MaximumNumberOfPresets>
        <tt:AuxiliaryCommands>tt:Wiper|On</tt:AuxiliaryCommands>
      </tptz:PTZNode></tptz:GetNodesResponse>`));
      if (action.includes("GetStatus")) return new Response(soap(`<tptz:GetStatusResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><tptz:PTZStatus>
        <tt:Position><tt:PanTilt x="0.25" y="-0.5" space="position-space"/><tt:Zoom x="0.75"/></tt:Position>
        <tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>MOVING</tt:Zoom></tt:MoveStatus><tt:UtcTime>2026-08-31T12:00:00Z</tt:UtcTime>
      </tptz:PTZStatus></tptz:GetStatusResponse>`));
      if (action.includes("GetPresets")) return new Response(soap(`<tptz:GetPresetsResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><tptz:Preset token="bed">
        <tt:Name>Pet bed</tt:Name><tt:PTZPosition><tt:PanTilt x="0.1" y="0.2"/></tt:PTZPosition>
      </tptz:Preset></tptz:GetPresetsResponse>`));
      if (action.includes("GetImagingSettings")) return new Response(soap(`<timg:GetImagingSettingsResponse xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><timg:ImagingSettings>
        <tt:Brightness>55</tt:Brightness><tt:ColorSaturation>42</tt:ColorSaturation><tt:Contrast>60</tt:Contrast><tt:Sharpness>3</tt:Sharpness>
        <tt:Focus><tt:AutoFocusMode>AUTO</tt:AutoFocusMode><tt:DefaultSpeed>0.5</tt:DefaultSpeed></tt:Focus>
        <tt:WhiteBalance><tt:Mode>MANUAL</tt:Mode><tt:CrGain>1.2</tt:CrGain><tt:CbGain>1.3</tt:CbGain></tt:WhiteBalance>
      </timg:ImagingSettings></timg:GetImagingSettingsResponse>`));
      if (action.includes("GetOptions")) return new Response(soap(`<timg:GetOptionsResponse xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><timg:ImagingOptions>
        <tt:Brightness><tt:Min>0</tt:Min><tt:Max>100</tt:Max></tt:Brightness><tt:Contrast><tt:Min>1</tt:Min><tt:Max>99</tt:Max></tt:Contrast>
      </timg:ImagingOptions></timg:GetOptionsResponse>`));
      throw new Error(`unexpected action ${action}`);
    };
    const client = new OnvifClient({
      deviceServiceUrl: "http://camera/onvif/device_service",
      authMode: "none",
      serviceUrls: {
        media: "http://camera/onvif/media_service",
        ptz: "http://camera/onvif/ptz_service",
        imaging: "http://camera/onvif/imaging_service",
      },
    }, { fetch: fakeFetch });

    expect(await client.getCapabilities()).toMatchObject({ media: "http://camera/onvif/media_service", ptz: "http://camera/onvif/ptz_service" });
    expect(await client.getServices()).toEqual([{
      namespace: "http://www.onvif.org/ver10/media/wsdl",
      xAddr: "http://camera/onvif/media_service",
      version: { major: 2, minor: 4 },
    }]);
    expect(await client.getProfiles()).toMatchObject([{
      token: "main",
      fixed: true,
      name: "Main stream",
      videoSourceConfigurationToken: "source-1",
      ptzConfigurationToken: "ptz-1",
      videoEncoderConfiguration: { encoding: "H264", resolution: { width: 1920, height: 1080 }, frameRateLimit: 20 },
    }]);
    expect(await client.getStreamUri("main")).toEqual({
      uri: "rtsp://camera:8554/profile0?x=1&y=2",
      invalidAfterConnect: false,
      invalidAfterReboot: true,
      timeout: "PT60S",
    });
    expect((await client.getSnapshotUri("main")).uri).toBe("http://camera/snapshot.jpg");
    expect(await client.getPtzNodes()).toMatchObject([{ token: "node-1", homeSupported: true, maximumNumberOfPresets: 8 }]);
    expect(await client.getPtzStatus("main")).toMatchObject({
      position: { panTilt: { x: 0.25, y: -0.5, space: "position-space" }, zoom: { x: 0.75 } },
      moveStatus: { panTilt: "IDLE", zoom: "MOVING" },
    });
    expect(await client.getPresets("main")).toMatchObject([{ token: "bed", name: "Pet bed", position: { panTilt: { x: 0.1, y: 0.2 } } }]);
    expect(await client.getImagingSettings("source-1")).toMatchObject({
      brightness: 55,
      focus: { autoFocusMode: "AUTO", defaultSpeed: 0.5 },
      whiteBalance: { mode: "MANUAL", crGain: 1.2, cbGain: 1.3 },
    });
    expect(await client.getImagingOptions("source-1")).toMatchObject({ brightness: { min: 0, max: 100 }, contrast: { min: 1, max: 99 } });
    expect(calls).toHaveLength(10);
  });

  test("serializes the standard PTZ and imaging control operations", async () => {
    const bodies: string[] = [];
    const fakeFetch: OnvifFetch = async (_input, init) => {
      const body = String(init?.body);
      bodies.push(body);
      if (body.includes("<tptz:SetPreset>")) {
        return new Response(soap(`<tptz:SetPresetResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:PresetToken>new-token</tptz:PresetToken></tptz:SetPresetResponse>`));
      }
      return new Response(soap("<ok/>"));
    };
    const client = new OnvifClient({
      deviceServiceUrl: "http://camera/onvif/device_service",
      authMode: "none",
      serviceUrls: { ptz: "http://camera/onvif/ptz_service", imaging: "http://camera/onvif/imaging_service" },
    }, { fetch: fakeFetch });

    await client.continuousMove("main", { panTilt: { x: 0.5, y: -0.25 }, zoom: { x: 0.1 } }, "PT2S");
    await client.relativeMove("main", { panTilt: { x: 0.1, y: 0.2 } }, { panTilt: { x: 0.4, y: 0.4 } });
    await client.absoluteMove("main", { panTilt: { x: -0.2, y: 0.7 }, zoom: { x: 0.5 } });
    await client.stop("main");
    await client.gotoHomePosition("main", { panTilt: { x: 0.2, y: 0.2 } });
    await client.setHomePosition("main");
    expect(await client.setPreset("main", "Sofa")).toBe("new-token");
    await client.gotoPreset("main", "new-token");
    await client.removePreset("main", "new-token");
    await client.setImagingSettings("source-1", {
      brightness: 50,
      exposure: { mode: "AUTO", minGain: 1, maxGain: 10 },
      focus: { autoFocusMode: "AUTO", nearLimit: 0.1 },
      whiteBalance: { mode: "AUTO" },
    });

    expect(bodies).toHaveLength(10);
    expect(bodies[0]).toContain('<tt:PanTilt x="0.5" y="-0.25"');
    expect(bodies[0]).toContain("<tptz:Timeout>PT2S</tptz:Timeout>");
    expect(bodies[3]).toContain("<tptz:PanTilt>true</tptz:PanTilt>");
    expect(bodies[9]).toContain("<tt:Brightness>50</tt:Brightness>");
    expect(bodies[9]).toContain("<tt:MinGain>1</tt:MinGain>");
    expect(bodies[9]).toContain("<timg:ForcePersistence>true</timg:ForcePersistence>");
  });
});

describe("RTSP candidate policy", () => {
  test("uses the camera URI only unless Meari fallbacks are explicitly enabled", () => {
    const returnedUri = "rtsp://camera.local:554/generated/token";
    expect(buildRtspCandidates({ returnedUri })).toEqual([{ uri: returnedUri, source: "onvif", label: "camera-reported" }]);

    const candidates = buildRtspCandidates({
      returnedUri,
      username: "owner",
      password: "correct-password",
      includeMeariFallbacks: true,
    });
    expect(candidates[0]?.uri).toBe(returnedUri);
    expect(candidates.slice(1).every((candidate) => candidate.source === "meari-fallback")).toBeTrue();
    expect(candidates[1]?.uri).toBe("rtsp://owner:correct-password@camera.local:8554/profile0");
    expect(redactRtspUri(candidates[1]?.uri ?? "")).toBe("rtsp://redacted:redacted@camera.local:8554/profile0");
  });
});

describe("OnvifClient.systemReboot", () => {
  test("sends SystemReboot to the device service and returns the camera's message", async () => {
    const bodies: string[] = [];
    const fakeFetch: OnvifFetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(soap(`<tds:SystemRebootResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Message>Rebooting</tds:Message></tds:SystemRebootResponse>`));
    };
    const client = new OnvifClient({
      deviceServiceUrl: "http://10.78.0.147:8000/onvif/device_service",
      username: "admin",
      password: "admin",
    }, { fetch: fakeFetch, nonce: () => new Uint8Array([1, 2, 3, 4]) });
    expect(await client.systemReboot()).toBe("Rebooting");
    expect(bodies.at(-1)).toContain("<tds:SystemReboot/>");
  });
});
