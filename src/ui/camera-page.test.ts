import { describe, expect, test } from "bun:test";
import { cameraSchema } from "../schemas";
import type { RegisteredDevice } from "../site";
import { CAMERA_API, renderCameraPage } from "./camera-page";
import { testPageContext } from "./test-context";

const wyze: RegisteredDevice = {
  id: "wyze/porch",
  name: 'Porch <cam> "v3"',
  kind: "camera",
  model: "wyze-cam-v3",
  modelTitle: "Wyze Cam v3",
  capabilities: ["camera"],
  host: "10.77.0.250",
  page: "/devices/wyze%2Fporch",
  schemaId: cameraSchema.$id,
  enabled: true,
};

describe("camera page", () => {
  test("renders the live view and snapshot controls for a plain camera", () => {
    const html = renderCameraPage({ ctx: testPageContext({ nonce: 'n"once' }), device: wyze });
    expect(html).toContain("<title>Porch &lt;cam&gt; &quot;v3&quot; · HomeTruth</title>");
    expect(html).toContain('<style id="ht-css" nonce="n&quot;once">');
    expect(html).toContain('<script nonce="n&quot;once">');
    expect(html).toContain('data-device-id="wyze/porch"');
    expect(html).toContain(JSON.stringify(CAMERA_API).replaceAll('"', "&quot;"));
    expect(html).toContain('data-action="live"');
    expect(html).toContain('data-action="snapshot"');
    expect(html).toContain('href="/devices/wyze%2Fporch/settings"');
    expect(html).not.toContain("<cam>");
  });

  test("names the generic camera media routes", () => {
    expect(CAMERA_API.stream).toBe("/api/cameras/:id/stream.mjpeg");
    expect(CAMERA_API.snapshot).toBe("/api/cameras/:id/snapshot");
    expect(CAMERA_API.state).toBe("/api/devices/:id");
  });
});
