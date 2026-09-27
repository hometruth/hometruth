import { loadProxyConfig, bridgeCredentials } from "./config";
import { HueProxyService } from "./service";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run hue:proxy [--config hue-proxy.yml] [--check]\nBuild Entertainment transport first with bun run hue:proxy:build.\nCredentials: vendors.hue in .hometruth/secrets.yml, or environment variables named in config.");
} else {
  let service: HueProxyService | undefined;
  try {
    const configIndex = args.indexOf("--config");
    const path = configIndex >= 0 ? args[configIndex + 1] : process.env.HUE_PROXY_CONFIG ?? "hue-proxy.yml";
    if (!path || path.startsWith("--") || args.some((arg, i) => !["--config", "--check"].includes(arg) && !(configIndex >= 0 && i === configIndex + 1))) throw new Error("Use --config <path> and/or --check; see --help");
    const config = await loadProxyConfig(path);
    const credentials = await bridgeCredentials(config);
    if (args.includes("--check")) {
      console.log(JSON.stringify({ valid: true, targets: config.targets.length, routes: config.routes.length, entertainment: config.entertainment.enabled }));
    } else {
      service = new HueProxyService({ config, ...credentials });
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await service?.stop(); process.exit(0); };
      process.once("SIGINT", () => { void stop(); });
      process.once("SIGTERM", () => { void stop(); });
      await service.start();
      console.log(JSON.stringify({ event: "hue_proxy_started", ...service.snapshot() }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Hue proxy failed");
    await service?.stop();
    process.exitCode = 1;
  }
}
