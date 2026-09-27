/**
 * How the TKENPRO vendor uses the site's secrets file:
 *
 * - `vendors.tkenpro.account` is the app account (the `CameraSetupStore` the
 *   camera service reads and the settings form writes).
 * - `devices.<id>.onvif` is each camera's own ONVIF/local login; the settings
 *   form's ONVIF fields save to the camera the page is for.
 *
 * `importLegacySecrets` moves what `.env.local` and `.hometruth/camera-setup.json`
 * used to hold into the secrets file once, so the old locations stop mattering.
 */
import { secretsFor, withSecret, type SecretStore, type SecretsFile } from "../../config/secrets";
import { TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER } from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import type { CameraSetupRequest, DevicesConfig } from "../../schemas";
import type { HostCredentials } from "./camera-service";
import { LayeredCameraSetupStore, type CameraSetupStore, type SavedCameraConfiguration } from "./setup-store";

export const TKENPRO_VENDOR_ID = "tkenpro";
const ACCOUNT = `vendors.${TKENPRO_VENDOR_ID}.account`;
const ACCOUNT_FIELDS = ["profile", "email", "password", "countryCode", "phoneCode"] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The saved app account, or undefined when the secrets file has none. */
export function accountFromSecrets(file: SecretsFile): CameraSetupRequest | undefined {
  const account = secretsFor(file, "vendors", TKENPRO_VENDOR_ID).account;
  if (typeof account !== "object" || account === null) return undefined;
  const bag = account as Record<string, unknown>;
  const email = text(bag.email);
  const password = text(bag.password);
  if (!email || !password) return undefined;
  return {
    profile: bag.profile === "tkenpro" ? "tkenpro" : "cloudedge",
    email,
    password,
    ...(text(bag.countryCode) ? { countryCode: text(bag.countryCode)! } : {}),
    ...(text(bag.phoneCode) ? { phoneCode: text(bag.phoneCode)! } : {}),
  };
}

/** The app account as the camera service's setup store, over the secrets file. */
export class SecretsCameraSetupStore implements CameraSetupStore {
  constructor(private readonly store: SecretStore) {}

  async load(): Promise<SavedCameraConfiguration | undefined> {
    const setup = accountFromSecrets(await this.store.load());
    return setup ? { setup } : undefined;
  }

  /** Persists the account fields only; ONVIF fields belong to a device (see `hostCredentialsSaver`). */
  async save(configuration: SavedCameraConfiguration): Promise<void> {
    let file = await this.store.load();
    for (const field of ACCOUNT_FIELDS) {
      file = withSecret(file, `${ACCOUNT}.${field}`, text(configuration.setup[field]));
    }
    await this.store.save(file);
  }

  async clear(): Promise<void> {
    let file = await this.store.load();
    for (const field of ACCOUNT_FIELDS) file = withSecret(file, `${ACCOUNT}.${field}`, undefined);
    await this.store.save(file);
  }
}

/** The id of the TKENPRO device configured at `host`. */
export function deviceIdForHost(config: DevicesConfig, host: string): string | undefined {
  return (config.devices ?? []).find((entry) => entry.model === TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER.id && entry.config.host === host)?.id;
}

/** Saves ONVIF credentials typed into the settings form under the device configured at that address. */
export function hostCredentialsSaver(store: SecretStore, config: DevicesConfig): (host: string, credentials: HostCredentials) => Promise<void> {
  return async (host, credentials) => {
    const id = deviceIdForHost(config, host);
    if (!id) throw new Error(`No camera at ${host} is defined in devices.yml, so its ONVIF login has nowhere to go; add it there first`);
    let file = await store.load();
    file = withSecret(file, `devices.${id}.onvif.username`, credentials.username);
    file = withSecret(file, `devices.${id}.onvif.password`, credentials.password);
    await store.save(file);
  };
}

export interface LegacySecretSources {
  readonly env?: Record<string, string | undefined>;
  /** Reads the app account and ONVIF login from .env.local and camera-setup.json. */
  readonly legacy?: CameraSetupStore;
}

/**
 * One-time import into the secrets file: the app account, every configured
 * camera's ONVIF login (the old single login applies to each), and the UniFi
 * key. Existing entries are kept. Returns the paths written, never values.
 */
export async function importLegacySecrets(store: SecretStore, config: DevicesConfig, sources: LegacySecretSources = {}): Promise<string[]> {
  const env = sources.env ?? process.env;
  const legacy = sources.legacy ?? new LayeredCameraSetupStore();
  const saved = await legacy.load().catch(() => undefined);
  let file = await store.load();
  const written: string[] = [];
  const put = (path: string, value: string | boolean | undefined, present: boolean) => {
    if (value === undefined || present) return;
    file = withSecret(file, path, value);
    written.push(path);
  };

  const account = secretsFor(file, "vendors", TKENPRO_VENDOR_ID).account as Record<string, unknown> | undefined;
  for (const field of ACCOUNT_FIELDS) {
    put(`${ACCOUNT}.${field}`, text(saved?.setup[field]), text(account?.[field]) !== undefined);
  }

  const onvifUsername = text(saved?.setup.onvifUsername);
  const onvifPassword = text(saved?.setup.onvifPassword);
  if (onvifUsername && onvifPassword) {
    for (const entry of config.devices ?? []) {
      if (entry.model !== TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER.id) continue;
      const existing = secretsFor(file, "devices", entry.id).onvif;
      put(`devices.${entry.id}.onvif.username`, onvifUsername, existing !== undefined);
      put(`devices.${entry.id}.onvif.password`, onvifPassword, existing !== undefined);
    }
  }

  const unifi = secretsFor(file, "network", "unifi");
  put("network.unifi.apiKey", text(env.UNIFI_API_KEY?.trim()), text(unifi.apiKey) !== undefined);
  put("network.unifi.baseUrl", text(env.UNIFI_BASE_URL?.trim()), text(unifi.baseUrl) !== undefined);
  put("network.unifi.skipTlsVerify", env.UNIFI_SKIP_TLS_VERIFY === "1" ? true : undefined, unifi.skipTlsVerify !== undefined);

  if (written.length > 0) await store.save(file);
  return written;
}
