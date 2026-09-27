import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DevProject,
  HubDiscovery,
  RegistrationResponse,
  UnregisterResponse,
} from "./schemas";
import { describeValidationErrors, validators } from "./validation";

const heartbeatMs = 5_000;
const requestTimeoutMs = 1_500;

type RegistrationState = "registered" | "unavailable";

export interface DevHubRegistration {
  project: DevProject;
  stop: () => Promise<void>;
}

export function getDevHubDiscoveryPath(env: Record<string, string | undefined> = Bun.env): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return env.DEV_HUB_DISCOVERY_FILE ?? join(tmpdir(), `bun-hono-dev-hub-${uid}`, "hub.json");
}

async function readDiscovery(path: string): Promise<HubDiscovery | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;

  try {
    const value: unknown = await file.json();
    return validators.hubDiscovery(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readProjectName(): Promise<string> {
  const value: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json();
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.length > 0
  ) {
    return value.name;
  }
  return "bun-hono-site";
}

async function createProject(url: string): Promise<DevProject> {
  const name = await readProjectName();
  const root = process.cwd();
  const project: unknown = {
    schemaVersion: 1,
    id: `${name}:${String(Bun.hash(root))}`,
    name,
    localHostname: "hometruth.localhost",
    kind: "bun-hono",
    url,
    healthUrl: new URL("/api/health", url).toString(),
    root,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runtime: { name: "bun", version: Bun.version },
  };

  if (!validators.devProject(project)) {
    throw new Error(`Invalid dev project registration: ${describeValidationErrors(validators.devProject.errors)}`);
  }
  return project;
}

async function postJson<T>(
  discovery: HubDiscovery,
  pathname: string,
  body: unknown,
  validate: ((value: unknown) => value is T) & { errors?: Parameters<typeof describeValidationErrors>[0] },
): Promise<T> {
  const response = await fetch(new URL(pathname, discovery.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${discovery.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const value: unknown = await response.json();
  if (!response.ok || !validate(value)) {
    throw new Error(`Dev Hub rejected ${pathname}: ${describeValidationErrors(validate.errors)}`);
  }
  return value;
}

export async function startDevHubRegistration({ url }: { url: string }): Promise<DevHubRegistration> {
  const project = await createProject(url);
  const discoveryPath = getDevHubDiscoveryPath();
  let activeDiscovery: HubDiscovery | undefined;
  let lastState: RegistrationState | undefined;
  let stopped = false;

  const report = (state: RegistrationState, detail?: Record<string, unknown>) => {
    if (state === lastState) return;
    lastState = state;
    console.log(JSON.stringify({ event: `dev_hub_${state}`, projectId: project.id, ...detail }));
  };

  const checkIn = async () => {
    if (stopped) return;
    try {
      const discovery = await readDiscovery(discoveryPath);
      if (!discovery) {
        activeDiscovery = undefined;
        report("unavailable", { discoveryPath });
        return;
      }
      const result = await postJson<RegistrationResponse>(
        discovery,
        "/api/projects/register",
        project,
        validators.registrationResponse,
      );
      activeDiscovery = discovery;
      report("registered", { hubUrl: discovery.url, lastSeen: result.lastSeen });
    } catch (error) {
      activeDiscovery = undefined;
      report("unavailable", { message: error instanceof Error ? error.message : "Registration failed" });
    }
  };

  await checkIn();
  const timer = setInterval(() => void checkIn(), heartbeatMs);
  timer.unref();

  return {
    project,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (!activeDiscovery) return;
      try {
        await postJson<UnregisterResponse>(
          activeDiscovery,
          "/api/projects/unregister",
          { id: project.id },
          validators.unregisterResponse,
        );
      } catch {
        // Heartbeat expiry removes registrations when graceful unregister is unavailable.
      }
    },
  };
}
