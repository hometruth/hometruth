/**
 * The LAN base URL a Sonos speaker can use to fetch a HomeTruth-hosted clip
 * (`say()`, or a relative `playUri()`). Unlike Hue's shared service, this
 * carries no vendor secrets — it is purely this process's own network
 * address and listening port, both only known once the server has actually
 * started listening. The supervisor passes the public port to each
 * generation; private worker ports must never appear in speaker URLs.
 */
import { hometruthLanAddress, localAddressFor } from "../../network";

export interface SonosMediaService {
  /** Absolute `http://<lan-ip>:<port>` this server is reachable at from `speakerHost`. */
  baseUrlFor(speakerHost: string): string;
}

/** `port` is read lazily since `Bun.serve()`'s bound port can differ from the one requested. */
export function createSonosMediaService(port: () => number): SonosMediaService {
  return {
    baseUrlFor(speakerHost: string): string {
      const detected = localAddressFor([speakerHost]);
      const lanAddress = hometruthLanAddress(detected !== undefined ? { overrideIp: detected } : {});
      return `http://${lanAddress}:${port()}`;
    },
  };
}
