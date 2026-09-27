/** Inspect the bridge owned by HomeTruth, or reopen its initial pairing window. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileMatterSettingsSource } from "./settings.ts";

const storage = resolve(process.env.HOMETRUTH_MATTER_STORAGE || ".hometruth/matter");
const mode = process.argv[2] ?? "status";

if (mode === "status") {
  const settings = await new FileMatterSettingsSource(storage).read();
  if (settings) {
    const { qrCodeDataUrl: _image, ...status } = settings;
    console.log(JSON.stringify(status, null, 2));
  } else console.log("No Matter bridge status yet. The bridge starts with bun run dev or bun run start.");
} else if (mode === "pair") {
  const settings = await new FileMatterSettingsSource(storage).read();
  if (!settings?.running) throw new Error("The Apple Home bridge is stopped. Start HomeTruth with bun run dev.");
  if (settings.commissioned) console.log("Already paired. Use Apple Home sharing to add another administrator.");
  else {
    const pid = Number(await readFile(join(storage, "bridge.pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid bridge process ID");
    process.kill(pid, "SIGUSR1");
    console.log(`Pairing page: ${join(storage, "pairing.html")}`);
  }
} else throw new Error("Usage: service.ts status|pair");
