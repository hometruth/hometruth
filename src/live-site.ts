/**
 * A `Site` whose device list can be swapped out while the server keeps
 * running, so editing devices.yml takes effect without restarting the
 * process (and dropping the MQTT broker, network isolation, Hue session,
 * etc.). `createLiveSite` returns a `Site`-shaped object every route holds
 * onto for the app's lifetime; `.reload()` rebuilds the underlying `Site`
 * from the current file and every subsequent property/method access sees
 * the new one. In-flight requests already inside a handler keep whatever
 * `Site` they read at the time; only new property reads see the swap.
 */
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { DevicesConfigError, loadDevicesConfig } from "./config/devices";
import { Site } from "./site";
import type { DeviceModel, SiteServices } from "./models/device";
import type { DevicesConfig, SecretsFile } from "./schemas";

export interface LiveSiteOptions {
  readonly path: string;
  /** Already validated startup input, avoiding a second read during activation. */
  readonly initialConfig?: DevicesConfig;
  readonly services: SiteServices;
  readonly secrets: SecretsFile | undefined;
  readonly models?: readonly DeviceModel[];
  /** Debounce window for coalescing the several fs events one save can raise. Default 200ms. */
  readonly debounceMs?: number;
  readonly onReload?: (event: { count: number }) => void;
  readonly onError?: (error: unknown) => void;
}

export interface LiveSite {
  /** The Site clients should hold onto; reflects whichever build is current. */
  readonly site: Site;
  /** Re-read and re-parse the file now, replacing the live Site on success. Errors are reported via onError and leave the current Site in place. */
  reload(): Promise<void>;
  /** Start watching the file for changes; each change debounces into one reload(). */
  watch(): void;
  close(): void;
}

/**
 * Wraps `Site` in a Proxy that always forwards to whichever instance is
 * "current," so the object identity handed to `createApp` never changes
 * while a reload can swap its behavior underneath. Accessors and methods
 * are bound to the live target so they can reach its private fields.
 */
function liveSiteProxy(current: () => Site): Site {
  return new Proxy({} as Site, {
    get(_target, property, receiver) {
      const target = current();
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(_target, property) {
      return Reflect.has(current(), property);
    },
    getPrototypeOf() {
      return Site.prototype;
    },
  });
}

export function createLiveSite(options: LiveSiteOptions): LiveSite {
  const models = options.models;
  let activeSite = options.initialConfig ? Site.fromConfig(options.initialConfig, options.services, options.secrets, models) : Site.empty();
  let watcher: ReturnType<typeof watch> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reloadQueue = Promise.resolve();

  const buildFrom = async (): Promise<Site> => {
    const config = await loadDevicesConfig(options.path);
    return Site.fromConfig(config, options.services, options.secrets, models);
  };

  const performReload = async (): Promise<void> => {
    if (closed) return;
    let next: Site;
    try {
      next = await buildFrom();
    } catch (error) {
      const missing = error instanceof DevicesConfigError && error.code === "missing";
      if (!missing) options.onError?.(error);
      return;
    }
    const previous = activeSite;
    next.setTagSource(previous.tagSource);
    if (!closed) activeSite = next;
    // Retire subscriptions/connections without making a config write wait for
    // an unreachable device. A pending read may not republish after close().
    const retired = closed ? next : previous;
    void Promise.allSettled(retired.devices.map(async device => device.close?.()));
    if (!closed) options.onReload?.({ count: next.devices.length });
  };

  const reload = () => reloadQueue = reloadQueue.then(performReload, performReload);

  return {
    site: liveSiteProxy(() => activeSite),
    reload,
    watch(): void {
      if (watcher || closed) return;
      const debounceMs = options.debounceMs ?? 200;
      const watchedName = basename(options.path);
      // Watch the containing directory so an editor (including the Switch
      // builder) can atomically replace the file without leaving us attached
      // to the old inode.
      watcher = watch(dirname(options.path), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== watchedName) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void reload();
        }, debounceMs);
      });
    },
    close(): void {
      closed = true;
      clearTimeout(debounceTimer);
      watcher?.close();
      watcher = undefined;
    },
  };
}
