import type { AppProfileName, MeariAppProfile } from "./types.ts";

export const DEFAULT_REDIRECT_URL = "https://apis.cloudedge360.com";

/** Wire identity from TKENPRO 6.2.0 (com.unibuying.tkenpro). */
export const TKENPRO_PROFILE: MeariAppProfile = Object.freeze({
  name: "tkenpro",
  sourceApp: "124",
  partnerId: "124",
  appVer: "6.2.0",
  appVerCode: "1041",
  redirectUrl: DEFAULT_REDIRECT_URL,
  ttid: "a",
  encryptedLogin: true,
  iotType: "4",
  caKey: "",
  caSecret: "",
});

/** Compatible fallback identity from CloudEdge 6.1.4. */
export const CLOUDEDGE_PROFILE: MeariAppProfile = Object.freeze({
  name: "cloudedge",
  sourceApp: "8",
  partnerId: "8",
  appVer: "6.1.4",
  appVerCode: "616",
  redirectUrl: DEFAULT_REDIRECT_URL,
  ttid: "a",
  encryptedLogin: true,
  iotType: "4",
  caKey: "",
  caSecret: "",
});

export const APP_PROFILES: Readonly<Record<AppProfileName, MeariAppProfile>> =
  Object.freeze({
    tkenpro: TKENPRO_PROFILE,
    cloudedge: CLOUDEDGE_PROFILE,
  });

export const TKENPRO_APP_PROFILE = TKENPRO_PROFILE;
export const CLOUD_EDGE_PROFILE = CLOUDEDGE_PROFILE;

export function resolveAppProfile(
  profile: AppProfileName | MeariAppProfile | undefined,
): MeariAppProfile {
  const base = typeof profile === "object" ? profile : APP_PROFILES[profile ?? "tkenpro"];
  return { ...base, caKey: base.caKey || process.env.MEARI_CA_KEY || "", caSecret: base.caSecret || process.env.MEARI_CA_SECRET || "" };
}
