/**
 * This site's Ring account: one REST client, and one websocket per location
 * shared by every Ring device configured against it. Ring drops an existing
 * connection when a second one opens for the same location, so handing out
 * a per-device connection would make the devices fight each other.
 *
 * Absent when `vendors.ring.refreshToken` is not set — Ring is optional, and
 * a site without it should say so rather than fail to build.
 */
import type { SecretStore } from "../../config/secrets";
import { secretsFor, withSecret } from "../../config/secrets";
import type { SecretsFile } from "../../schemas";
import { RingAssetConnection, type RingAssetConnectionOptions } from "../../protocols/ring/asset-socket";
import { RingClient, type RingFetch } from "../../protocols/ring/client";

export interface RingSiteService {
  readonly client: RingClient;
  /** The one connection for this location, opened lazily on first use. */
  connectionFor(locationId: string): RingAssetConnection;
  stop(): void;
}

export const RING_REFRESH_TOKEN_SECRET = "vendors.ring.refreshToken";

export interface RingSiteServiceOptions extends RingAssetConnectionOptions {
  /**
   * Where to write the rotated refresh token. Ring invalidates the previous
   * one the instant it issues a replacement, so a site that cannot write the
   * new token back is good for exactly one more restart.
   */
  store?: SecretStore;
  onError?: (message: string) => void;
  /** The REST transport, so a test can drive the account without reaching Amazon. */
  fetch?: RingFetch;
  timeoutMs?: number;
}

export function createRingSiteService(secretsFile: SecretsFile, options: RingSiteServiceOptions = {}): RingSiteService | undefined {
  const bag = secretsFor(secretsFile, "vendors", "ring");
  const refreshToken = typeof bag.refreshToken === "string" && bag.refreshToken.trim() ? bag.refreshToken.trim() : undefined;
  if (!refreshToken) return undefined;

  const { store, onError, fetch: fetchImpl, timeoutMs, ...connectionOptions } = options;
  const client = new RingClient(refreshToken, {
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(store
      ? {
        onRefreshToken: async (encoded: string) => {
          try {
            await store.save(withSecret(await store.load(), RING_REFRESH_TOKEN_SECRET, encoded));
          } catch (error) {
            // Losing the write is recoverable by minting a new token, but the
            // operator has to hear about it before the next restart does.
            onError?.(`Could not store the rotated Ring refresh token: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }
      : {}),
  });

  const connections = new Map<string, RingAssetConnection>();
  return {
    client,
    connectionFor(locationId: string): RingAssetConnection {
      const existing = connections.get(locationId);
      if (existing) return existing;
      const connection = new RingAssetConnection(client, locationId, connectionOptions);
      connections.set(locationId, connection);
      return connection;
    },
    stop(): void {
      for (const connection of connections.values()) connection.close();
      connections.clear();
    },
  };
}
