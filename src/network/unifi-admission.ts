import type { UniFiClient } from "./unifi";
import { validAdmissionMac, type AdmissionClient, type AdmissionWlan, type WifiAdmissionApi } from "./wifi-admission";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed UniFi admission response");
  return value as Record<string, unknown>;
}

function rows(body: unknown): Record<string, unknown>[] {
  const result = object(body);
  if ((result.meta && object(result.meta).rc === "error") || !Array.isArray(result.data)) throw new Error("UniFi rejected the Wi-Fi admission request");
  return result.data.map(object);
}

/** Sanitizes Wi-Fi records: passwords and unrelated settings never leave the adapter. */
export class UniFiAdmissionClient implements WifiAdmissionApi {
  constructor(private readonly client: UniFiClient) {}
  async listWlans(): Promise<AdmissionWlan[]> {
    return rows(await this.client.admissionRequest("rest/wlanconf")).map(row => {
      if (typeof row._id !== "string" || typeof row.name !== "string") throw new Error("UniFi WLAN identity is missing");
      if (!Array.isArray(row.mac_filter_list) || row.mac_filter_list.some(m => typeof m !== "string" || !validAdmissionMac(m))) {
        // Unsupported WLAN configurations remain enumerable, but fail the enabled-allowlist prerequisite.
        return { id: row._id, ssid: row.name, enabled: row.enabled === true, filterEnabled: false, policy: "unsupported", macs: [] };
      }
      return { id: row._id, ssid: row.name, enabled: row.enabled === true, filterEnabled: row.mac_filter_enabled === true,
        policy: typeof row.mac_filter_policy === "string" ? row.mac_filter_policy : "", macs: row.mac_filter_list as string[] };
    });
  }

  async listAdmissionClients(): Promise<AdmissionClient[]> {
    return rows(await this.client.admissionRequest("stat/sta")).flatMap(row => {
      if (row.is_wired !== false || typeof row.essid !== "string" || typeof row.mac !== "string" || !validAdmissionMac(row.mac)) return [];
      return [{ mac: row.mac.toLowerCase(), ssid: row.essid,
        ...(typeof row.wlanconf_id === "string" ? { wlanId: row.wlanconf_id } : {}),
        ...(typeof row.ip === "string" ? { address: row.ip } : {}),
        ...(typeof row.name === "string" ? { name: row.name } : typeof row.hostname === "string" ? { name: row.hostname } : {}),
      }];
    });
  }

  async setMacFilter(id: string, enabled: boolean, macs?: string[]): Promise<void> {
    if (macs?.some(mac => !validAdmissionMac(mac))) throw new Error("Invalid allowlist MAC address");
    rows(await this.client.admissionRequest(`rest/wlanconf/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify({ mac_filter_enabled: enabled, ...(macs ? { mac_filter_list: macs } : {}) }),
    }));
  }
}
