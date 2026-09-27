import { parseArgs } from "node:util";
import { FileSecretStore, secretsFor } from "../../config/secrets";
import { RevealClient } from "../../protocols/reveal/client";
import { downloadRevealPhotos } from "./download";
import { revealCredentials } from "./credentials";

const HELP = `Read photos already uploaded to a Tactacam REVEAL account.

  bun src/vendors/reveal/cli.ts cameras [--device <hometruth-id>]
  bun src/vendors/reveal/cli.ts download --camera-id <reveal-id> --output <directory> [--device <hometruth-id>] [--all | --max-pages 100]

Credentials: devices.<hometruth-id>.email and .password in the HomeTruth secrets file.
Or REVEAL_TATACAM_USER / REVEAL_TATACAM_PASSWORD in .env.local (TACTACAM spelling also supported).
HOMETRUTH_SECRETS overrides .hometruth/secrets.yml. Downloads can be rerun; saved photos are skipped.
This reads existing cloud JPEGs; it never requests HD, on-demand photos, or changes the camera.
`;

export async function runRevealCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    device: { type: "string" }, "camera-id": { type: "string" }, output: { type: "string" },
    "max-pages": { type: "string" }, all: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "cameras" && command !== "download")) throw new Error("REVEAL command must be cameras or download (see --help)");
  if (command === "download" && (!values["camera-id"] || !values.output)) throw new Error("Provide --camera-id and --output for download");
  const maxPages = Number(values["max-pages"] ?? 100);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error("--max-pages must be an integer from 1 to 10000");
  if (values.all && values["max-pages"]) throw new Error("Choose --all or --max-pages");
  const store = new FileSecretStore(env.HOMETRUTH_SECRETS?.trim() || undefined);
  const credentials = revealCredentials(values.device ? secretsFor(await store.load(), "devices", values.device) : {}, env);
  if (!credentials.email.trim() || !credentials.password) throw new Error("Configure the REVEAL email and password in .env.local or the device secrets (see docs/REVEAL.md)");
  const client = new RevealClient(credentials);
  const result = command === "cameras"
    ? await client.listCameras()
    : await downloadRevealPhotos(client, { cameraId: values["camera-id"]!, output: values.output!, maxPages: values.all ? "all" : maxPages });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  runRevealCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "REVEAL operation failed");
    process.exitCode = 1;
  });
}
