import { describe, expect, test } from "bun:test";
import { createApp } from "../server/app";
import { Site } from "../site";

const SITE = {
  schemaVersion: 2 as const,
  rooms: ["Lounge"],
  devices: [
    { id: "relay", name: "Gate relay", room: "Lounge", model: "shelly-plus-1", config: { host: "10.77.0.228" } },
  ],
};

const app = () => createApp(undefined, Site.fromConfig(SITE));

describe("the API description", () => {
  test("is served as an OpenAPI document for this install", async () => {
    const response = await app().request("/api/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const document = await response.json();
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/api/switches/{id}/toggle"].post["x-hometruth-permission"]).toBe("write");
    expect(document.paths["/api/devices/{id}/enabled"].get["x-hometruth-permission"]).toBe("read");
    for (const action of ["enable", "disable", "reboot"]) {
      const operation = document.paths[`/api/devices/{id}/${action}`].post;
      expect(operation["x-hometruth-permission"]).toBe("admin");
      expect(operation["x-hometruth-target"]).toBe("device");
    }
  });

  test("describes itself, so nothing about the surface is hidden from it", async () => {
    const document = await (await app().request("/api/openapi.json")).json();
    expect(document.paths["/api/openapi.json"].get).toBeDefined();
  });

  test("names the origin it was asked through, so the examples are runnable", async () => {
    const document = await (await app().request("http://hometruth.localhost:3100/api/openapi.json")).json();
    expect(document.servers[0].url).toBe("http://hometruth.localhost:3100");
  });

  test("enumerates the devices this install actually has", async () => {
    const document = await (await app().request("/api/openapi.json")).json();
    const parameter = document.paths["/api/switches/{id}"].get.parameters
      .find((entry: { name: string }) => entry.name === "id");
    expect(parameter.schema.enum).toEqual(["relay"]);
    expect(parameter["x-hometruth-labels"]).toEqual({ relay: "Gate relay" });
  });

  test("has a page that lists every operation before it is painted", async () => {
    const response = await app().request("/api-docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    // Server-rendered: the operations are in the first response, not fetched.
    expect(html).toContain('data-path="/api/switches/{id}/toggle"');
    expect(html).toContain("Gate relay");
    // And the page links the schema documents rather than restating them.
    expect(html).toContain('href="/schemas/binary-switch"');
  });

  test("the page offers a body to start from, built from the request schema", async () => {
    const html = await (await app().request("/api-docs")).text();
    expect(html).toContain("&quot;percent&quot;: 0");
  });
});
