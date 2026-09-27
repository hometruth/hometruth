import { type AppConfig } from "./schemas";
import { describeValidationErrors, validators } from "./validation";

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const rawMode = env.NODE_ENV ?? "development";
  const candidate: unknown = {
    devHubEnabled: env.DEV_HUB === "on" || env.DEV_HUB === "true" || env.DEV_HUB === "1",
    hostname: env.HOST ?? "127.0.0.1",
    preferredPort: Number(env.PORT ?? 3000),
    mode: rawMode,
  };

  if (!validators.appConfig(candidate)) {
    throw new Error(`Invalid application configuration: ${describeValidationErrors(validators.appConfig.errors)}`);
  }

  return candidate;
}
