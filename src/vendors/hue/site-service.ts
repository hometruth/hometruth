/**
 * Assembles this site's shared Hue service (one `HueClipClient` + one
 * `HueEntertainmentSession`) from `.hometruth/secrets.yml`'s `vendors.hue`
 * block, or returns `undefined` when no Hue bridge is configured for this
 * site. Hue and Entertainment streaming are optional integrations.
 *
 * The DTLS session is NOT connected here: connecting starts a CLIP
 * entertainment session and spawns a subprocess, both of which should only
 * happen when something actually wants to stream colors (a manual `setColor`
 * call, or the light-sync engine), not at server startup. Call
 * `session.connect()` lazily and `disconnect()` when nothing needs the
 * stream, since the bridge only allows an entertainment session to be
 * claimed by one streamer.
 */
import type { SecretsFile } from "../../schemas";
import { secretsFor } from "../../config/secrets";
import { HueClipClient } from "./clip-client";
import { HueEntertainmentSession } from "./entertainment-session";

export interface HueSiteService {
  readonly clip: HueClipClient;
  readonly session: HueEntertainmentSession;
  readonly bridgeId: string | undefined;
  readonly entertainmentAreaId: string;
}

function stringSecret(bag: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Reads `vendors.hue` from the secrets file; `undefined` when the site has no Hue bridge configured. */
export function createHueSiteService(secretsFile: SecretsFile): HueSiteService | undefined {
  const bag = secretsFor(secretsFile, "vendors", "hue");
  const host = stringSecret(bag, "host");
  const applicationKey = stringSecret(bag, "applicationKey");
  const clientKeyHex = stringSecret(bag, "clientKey");
  const entertainmentAreaId = stringSecret(bag, "entertainmentAreaId");
  if (!host || !applicationKey || !clientKeyHex || !entertainmentAreaId) return undefined;

  const clip = new HueClipClient({ host, applicationKey });
  const session = new HueEntertainmentSession({ host, applicationKey, clientKeyHex, areaId: entertainmentAreaId });
  return { clip, session, bridgeId: stringSecret(bag, "bridgeId"), entertainmentAreaId };
}
