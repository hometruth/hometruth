/** A bounded, one-client Wi-Fi admission window. Only MAC filtering is changed. */
export interface AdmissionWlan {
  id: string;
  ssid: string;
  enabled: boolean;
  filterEnabled: boolean;
  policy: string;
  macs: string[];
}

export interface AdmissionClient {
  mac: string;
  ssid: string;
  wlanId?: string;
  address?: string;
  name?: string;
}

export interface WifiAdmissionApi {
  listWlans(): Promise<AdmissionWlan[]>;
  listAdmissionClients(): Promise<AdmissionClient[]>;
  setMacFilter(id: string, enabled: boolean, macs?: string[]): Promise<void>;
}

export interface AdmissionJournal {
  save(wlan: AdmissionWlan): Promise<void>;
  clear(): Promise<void>;
}

export interface AdmissionResult {
  status: "accepted" | "timeout" | "cancelled" | "dry-run" | "restored";
  ssid: string;
  allowedCount: number;
  filterEnabled: true;
  client?: AdmissionClient;
}

export interface AdmissionOptions {
  ssid: string;
  timeoutMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  report?: (message: string) => void;
  /** Inject clocks and sleep for deterministic failure-path tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu;
export function validAdmissionMac(mac: string): boolean {
  return MAC.test(mac) && !(parseInt(mac.slice(0, 2), 16) & 1) && mac !== "00:00:00:00:00:00";
}

function requireAllowlist(wlan: AdmissionWlan): void {
  if (!wlan.enabled || !wlan.filterEnabled || wlan.policy !== "allow" || wlan.macs.some(mac => !validAdmissionMac(mac))) {
    throw new Error(`${wlan.ssid} must be enabled with an active MAC allowlist`);
  }
}

function sameWlan(a: AdmissionWlan, b: AdmissionWlan): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readWlan(api: WifiAdmissionApi, original: AdmissionWlan): Promise<AdmissionWlan> {
  const wlan = (await api.listWlans()).find(w => w.id === original.id);
  if (!wlan || wlan.ssid !== original.ssid) throw new Error(`Wi-Fi network ${original.ssid} was removed or renamed`);
  return wlan;
}

/** Close and add the admitted MAC together. Failed reads still trigger a close request. */
export async function restoreMacFilter(api: WifiAdmissionApi, original: AdmissionWlan, client?: AdmissionClient,
  sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms)): Promise<AdmissionWlan> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let current: AdmissionWlan;
      try { current = await readWlan(api, original); }
      catch (error) {
        // A read outage must not stop us from trying the narrow restoration write.
        await api.setMacFilter(original.id, true);
        throw error;
      }
      if (current.policy !== "allow") {
        await api.setMacFilter(original.id, true);
        throw new Error("MAC policy changed during admission; inspect the saved allowlist");
      }
      // Preserve both the original entries and additions made by another administrator.
      const macs = [...new Set([...current.macs, ...original.macs, ...(client ? [client.mac] : [])].map(m => m.toLowerCase()))];
      const additions = macs.some(m => !current.macs.map(value => value.toLowerCase()).includes(m));
      await api.setMacFilter(original.id, true, additions ? macs : undefined);
      const verified = await readWlan(api, original);
      if (!verified.filterEnabled || verified.policy !== "allow" || macs.some(m => !verified.macs.map(value => value.toLowerCase()).includes(m))) {
        throw new Error("The router did not retain the restored MAC allowlist");
      }
      return verified;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1000);
    }
  }
  throw new Error(`Could not verify MAC restriction restoration for ${original.ssid}; recovery snapshot retained. ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function acceptNextWifiClient(api: WifiAdmissionApi, journal: AdmissionJournal, options: AdmissionOptions): Promise<AdmissionResult> {
  if (!options.ssid.trim() || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 600_000) {
    throw new Error("Specify an SSID and a timeout of 10..600 seconds");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const matches = (await api.listWlans()).filter(w => w.ssid === options.ssid);
  if (matches.length !== 1) throw new Error(`Cannot uniquely identify Wi-Fi network ${options.ssid}`);
  const original = matches[0]!;
  requireAllowlist(original);
  const onTarget = (client: AdmissionClient) => client.ssid === original.ssid && (!client.wlanId || client.wlanId === original.id);
  const baseline = new Set([
    ...original.macs.map(mac => mac.toLowerCase()),
    ...(await api.listAdmissionClients()).filter(onTarget).map(client => client.mac.toLowerCase()),
  ]);
  if (options.dryRun) return { status: "dry-run", ssid: original.ssid, allowedCount: original.macs.length, filterEnabled: true };
  if (options.signal?.aborted) return { status: "cancelled", ssid: original.ssid, allowedCount: original.macs.length, filterEnabled: true };
  // The exclusive journal is acquired before any mutation. An uncertain PUT still requires restoration.
  await journal.save(original);
  let mayBeOpen = false;
  let accepted: AdmissionClient | undefined;
  let restored = original;
  let status: AdmissionResult["status"] = "timeout";
  try {
    const live = await readWlan(api, original);
    if (!sameWlan(live, original)) throw new Error("MAC allowlist changed during preparation; retry using its current settings");
    if (options.signal?.aborted) return { status: "cancelled", ssid: original.ssid, allowedCount: original.macs.length, filterEnabled: true };
    const deadline = now() + options.timeoutMs;
    mayBeOpen = true;
    await api.setMacFilter(original.id, false);
    if ((await readWlan(api, original)).filterEnabled) throw new Error("The router did not open the MAC admission window");
    options.report?.(`${original.ssid}: MAC restriction is off for up to ${options.timeoutMs / 1000} seconds. Start joining the device now; Wi-Fi password is still required.`);
    while (now() < deadline && !options.signal?.aborted) {
      const candidates = new Map((await api.listAdmissionClients())
        .filter(c => onTarget(c) && validAdmissionMac(c.mac) && !baseline.has(c.mac.toLowerCase()))
        .map(c => [c.mac.toLowerCase(), { ...c, mac: c.mac.toLowerCase() }]));
      if (options.signal?.aborted || now() >= deadline) break;
      if (candidates.size > 1) throw new Error(`Multiple new clients joined ${original.ssid}; closing without adding any MACs: ${[...candidates.keys()].join(", ")}`);
      if (candidates.size === 1) {
        accepted = [...candidates.values()][0]!;
        options.report?.(`Found ${accepted.name ?? "new device"}: ${accepted.mac}${accepted.address ? ` at ${accepted.address}` : " (awaiting DHCP)"}. Closing admission.`);
        status = "accepted";
        break;
      }
      await sleep(Math.min(1000, Math.max(0, deadline - now())));
    }
    if (options.signal?.aborted) status = "cancelled";
  } finally {
    if (mayBeOpen) {
      restored = await restoreMacFilter(api, original, accepted, sleep);
      options.report?.(`${original.ssid}: MAC restriction restored and verified (${restored.macs.length} allowed devices).`);
    }
    // Keep the recovery journal if any restoration or verification above failed.
    await journal.clear();
  }
  return { status, ssid: original.ssid, allowedCount: restored.macs.length, filterEnabled: true, ...(accepted ? { client: accepted } : {}) };
}
