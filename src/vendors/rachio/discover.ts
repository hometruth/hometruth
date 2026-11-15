/**
 * bun src/vendors/rachio/discover.ts
 *
 * Prints the controllers on the Rachio account with the `deviceId` a
 * `rachio-controller` entry needs and every zone's number, then suggests
 * entries to paste. Read-only: two API calls, nothing is switched.
 */
import { FileSecretStore } from "../../config/secrets";
import { RachioError } from "../../protocols/rachio/client";
import { createRachioSiteService, RACHIO_API_KEY_SECRET } from "./site-service";

const service = createRachioSiteService(await new FileSecretStore().load());
if (!service) {
  console.error(`No Rachio API key is configured. In the Rachio app open Account settings → Get API key, then:\n  ht secrets set ${RACHIO_API_KEY_SECRET}`);
  process.exit(1);
}

try {
  const controllers = await service.client.controllers();
  console.log(JSON.stringify({
    controllers: controllers.map(controller => ({
      deviceId: controller.id, name: controller.name, status: controller.status, model: controller.model,
      zones: controller.zones.map(zone => ({ zoneNumber: zone.zoneNumber, name: zone.name, enabled: zone.enabled })),
    })),
  }, null, 2));
  for (const [index, controller] of controllers.entries()) {
    const id = index === 0 ? "sprinklers" : `sprinklers-${index + 1}`;
    console.log(`\n# ${controller.name}\n  - id: ${id}\n    name: ${JSON.stringify(controller.name)}\n    model: rachio-controller\n    config: { deviceId: ${JSON.stringify(controller.id)} }`);
    console.log(`  - id: ${id}-rain-delay\n    name: Rain delay\n    model: rachio-rain-delay\n    config: { controller: ${id} }`);
    for (const zone of controller.zones.filter(candidate => candidate.enabled)) {
      console.log(`  - id: ${id}-zone-${zone.zoneNumber}\n    name: ${JSON.stringify(zone.name)}\n    model: rachio-zone\n    config: { controller: ${id}, zoneNumber: ${zone.zoneNumber} }`);
    }
  }
} catch (error) {
  console.error(error instanceof RachioError ? error.message : String(error));
  process.exit(1);
}
