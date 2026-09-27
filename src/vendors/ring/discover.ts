/**
 * bun src/vendors/ring/discover.ts
 *
 * Prints what the Ring account actually has: its locations, the Smart
 * Lighting Bridges on them, and the fixtures paired to each Bridge with the
 * `zid` an entry needs. Ring's ids are not printed on the hardware and the
 * app does not show them, so this is the only way to write a correct entry.
 *
 * Read-only: it opens each location's socket to read the device list and
 * closes it again. It never switches anything on.
 */
import { FileSecretStore } from "../../config/secrets";
import { isBeamsLightType } from "../../protocols/ring/asset-socket";
import { RingError } from "../../protocols/ring/client";
import { createRingSiteService, RING_REFRESH_TOKEN_SECRET } from "./site-service";

const store = new FileSecretStore();
const service = createRingSiteService(await store.load(), { store, onError: message => console.error(message) });
if (!service) {
  console.error(`No Ring account is configured. Mint a token with \`npx -p ring-client-api ring-auth-cli\`, then:\n  ht secrets set ${RING_REFRESH_TOKEN_SECRET}`);
  process.exit(1);
}

try {
  const [locations, bridges] = await Promise.all([service.client.listLocations(), service.client.listBridges()]);
  const report = [];
  for (const location of locations) {
    const here = bridges.filter(bridge => bridge.locationId === location.locationId);
    if (!here.length) {
      report.push({ ...location, bridges: [], fixtures: [], note: "No Smart Lighting Bridge at this location" });
      continue;
    }
    const connection = service.connectionFor(location.locationId);
    let fixtures: unknown[] = [];
    let note: string | undefined;
    try {
      await connection.ready();
      fixtures = [...connection.state().devices.values()]
        .filter(device => device.deviceType.endsWith(".beams"))
        .map(device => ({
          zid: device.zid,
          name: device.name,
          deviceType: device.deviceType,
          light: isBeamsLightType(device.deviceType),
          ...(device.batteryLevel !== undefined ? { batteryLevel: device.batteryLevel } : {}),
        }));
    } catch (error) {
      note = error instanceof RingError ? error.message : String(error);
    }
    report.push({ ...location, bridges: here.map(bridge => ({ id: bridge.id, description: bridge.description, kind: bridge.kind })), fixtures, ...(note ? { note } : {}) });
  }

  console.log(JSON.stringify({ locations: report }, null, 2));

  // A ready-to-paste entry beats copying ids by hand out of the JSON above.
  const suggestions = report.flatMap(location => {
    if (!location.bridges.length) return [];
    const bridgeId = `ring-bridge-${location.locationId.slice(0, 8)}`;
    const lights = (location.fixtures as { zid: string; name: string; light: boolean }[]).filter(fixture => fixture.light);
    return [
      `  - id: ${bridgeId}`,
      `    name: ${JSON.stringify(location.name)}`,
      `    model: ring-bridge`,
      `    config: { locationId: ${location.locationId} }`,
      ...lights.flatMap(fixture => [
        `  - id: ${fixture.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || fixture.zid}`,
        `    name: ${JSON.stringify(fixture.name)}`,
        `    model: ring-smart-light`,
        `    config: { bridge: ${bridgeId}, zid: ${fixture.zid} }`,
      ]),
    ];
  });
  if (suggestions.length) console.log(`\n# devices.yml entries for the above\n${suggestions.join("\n")}`);
} finally {
  service.stop();
}
