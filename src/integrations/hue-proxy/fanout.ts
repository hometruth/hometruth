import { gradeColor } from "../../light-sync/color-grade";
import { environmentSecret, type HueEvent, type LightPatch, type ProxyConfig, type Route, type Target } from "./config";

export function matchesSource(pattern: string, source: string): boolean {
  return pattern === "*" || pattern === source || (pattern.endsWith("/*") && source.startsWith(pattern.slice(0, -1)));
}
export function transform(event: HueEvent, route: Route): HueEvent {
  const project = (input: LightPatch | undefined): LightPatch | undefined => {
    if (!input) return undefined;
    const state = { ...input };
    if (state.brightnessPercent !== undefined) state.brightnessPercent = Math.max(0, Math.min(100, state.brightnessPercent * (route.brightnessScale ?? 1)));
    if (state.color) {
      const hex = route.color ?? state.color;
      const rgb = gradeColor({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }, { saturationGain: route.saturationGain ?? 1, gamma: route.gamma ?? 1, valueGain: 1 });
      state.color = `#${[rgb.r, rgb.g, rgb.b].map(v => v.toString(16).padStart(2, "0")).join("")}`;
    }
    if (route.fields) for (const key of Object.keys(state) as (keyof LightPatch)[]) if (key !== "transitionMs" && !route.fields.includes(key)) delete state[key];
    return state;
  };
  return { ...event, ...(event.state ? { state: project(event.state)! } : {}), ...(event.changed ? { changed: project(event.changed)! } : {}) };
}
export type Deliver = (target: Target, event: HueEvent, signal: AbortSignal) => Promise<void>;
interface Lane { queue: HueEvent[]; pending?: HueEvent; running?: Promise<void>; lastAt: number; sent: LightPatch; failures: number; delivered: number; dropped: number }

/** Per-destination ordering, bounded queues and independent failure/backpressure. */
export class Fanout {
  private readonly lanes = new Map<string, Lane>();
  private readonly controller = new AbortController();
  constructor(private readonly config: Pick<ProxyConfig, "targets" | "routes">, private readonly deliver: Deliver, private readonly error: (target: string, message: string) => void) {
    for (const target of config.targets) this.lanes.set(target.id, { queue: [], lastAt: 0, sent: {}, failures: 0, delivered: 0, dropped: 0 });
  }
  publish(event: HueEvent, aliases: string[] = []): void {
    if (this.controller.signal.aborted) return;
    for (const route of this.config.routes) {
      if (!route.sources.some(pattern => [event.source, ...aliases].some(source => matchesSource(pattern, source)))) continue;
      const projected = transform(event, route);
      for (const targetId of route.targets) {
        const target = this.config.targets.find(t => t.id === targetId)!;
        const lane = this.lanes.get(targetId)!;
        if (target.kind === "hometruth" || target.kind === "wled") {
          if (projected.type !== "light" || !projected.changed || !Object.keys(projected.changed).length) continue;
          // Merge patches across a burst, so color does not erase a queued off.
          const state = { ...lane.sent, ...lane.pending?.state, ...projected.state };
          if (projected.state?.color) delete state.colorTemperatureKelvin;
          if (projected.state?.colorTemperatureKelvin) delete state.color;
          lane.pending = { ...projected, state, changed: state };
        } else {
          if (lane.queue.length >= 256) { lane.queue.shift(); lane.dropped++; }
          lane.queue.push(projected);
        }
        lane.running ??= this.run(target, lane).finally(() => { delete lane.running; });
      }
    }
  }
  private async run(target: Target, lane: Lane): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted && (lane.pending || lane.queue.length)) {
      const delay = Math.max(0, lane.lastAt + (target.minIntervalMs ?? (target.kind === "hometruth" ? 200 : target.kind === "wled" ? 40 : 0)) - Date.now());
      if (delay) await sleep(delay, signal);
      if (signal.aborted) break;
      const event = lane.pending ?? lane.queue.shift()!;
      delete lane.pending;
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        try {
          await this.deliver(target, event, signal);
          lane.delivered++;
          if (event.state) lane.sent = event.state;
          break;
        } catch {
          lane.failures++;
          if (signal.aborted) break;
          this.error(target.id, `Delivery failed (attempt ${attempt + 1}/3)`);
          if (lane.pending) break; // retry newest light state, not a stale frame
          if (attempt < 2) await sleep(250 * 2 ** attempt, signal);
          else lane.dropped++;
        }
      }
      lane.lastAt = Date.now();
    }
  }
  status() { return Object.fromEntries([...this.lanes].map(([id, lane]) => [id, { delivered: lane.delivered, failures: lane.failures, dropped: lane.dropped, queued: lane.queue.length + Number(!!lane.pending) }])); }
  async idle(): Promise<void> { await Promise.all([...this.lanes.values()].map(lane => lane.running)); }
  async stop(): Promise<void> { this.controller.abort(); await this.idle(); }
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Built-in adapters. New consumers can use the full JSON webhook/MQTT events. */
export class Destinations {
  private readonly mqtt = new Map<string, import("mqtt").MqttClient>();
  private readonly capabilities = new Map<string, any>();
  constructor(private readonly request: typeof fetch = fetch) {}
  readonly deliver: Deliver = async (target, event, signal) => {
    if (target.kind === "mqtt") {
      let client = this.mqtt.get(target.id);
      if (!client) {
        const { connect } = await import("mqtt");
        const username = environmentSecret(target.usernameEnv), password = environmentSecret(target.passwordEnv);
        client = connect(target.url, { ...(username ? { username } : {}), ...(password ? { password } : {}), reconnectPeriod: 2000, connectTimeout: 4000, queueQoSZero: false });
        client.on("error", () => undefined);
        this.mqtt.set(target.id, client);
      }
      const active = client;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => done(new Error("MQTT publish timeout")), 5000);
        const abort = () => done(new Error("Stopped"));
        const done = (error?: Error) => { clearTimeout(timeout); signal.removeEventListener("abort", abort); active.off("connect", publish); error ? reject(error) : resolve(); };
        const publish = () => active.publish(target.topic!, JSON.stringify(event), { qos: 0, retain: false }, error => done(error ?? undefined));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        if (active.connected) publish(); else active.once("connect", publish);
      });
      return;
    }
    const token = environmentSecret(target.tokenEnv);
    const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const send = async (url: string, body?: unknown) => {
      const response = await this.request(url, { method: body === undefined ? "GET" : "POST", headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Destination HTTP ${response.status}`); }
      return response;
    };
    if (target.kind === "webhook") { await (await send(target.url, event)).body?.cancel(); return; }
    const state = event.state;
    if (!state) return;
    if (target.kind === "wled") {
      const rgb = state.color ? [1, 3, 5].map(n => parseInt(state.color!.slice(n, n + 2), 16)) : state.colorTemperatureKelvin ? kelvinRgb(state.colorTemperatureKelvin) : undefined;
      const powerAndBrightness = {
        ...(state.on !== undefined ? { on: state.on } : {}),
        ...(state.brightnessPercent !== undefined ? { bri: Math.round(state.brightnessPercent / 100 * 255) } : {}),
      };
      const segment = { id: target.segment ?? 0, ...(target.segment !== undefined ? powerAndBrightness : {}), ...(rgb ? { col: [rgb], fx: 0, pal: 0 } : {}) };
      const response = await send(`${target.url.replace(/\/$/u, "")}/json/state`, {
        ...(target.segment === undefined ? powerAndBrightness : state.on === true ? { on: true } : {}),
        ...(state.transitionMs !== undefined ? { transition: Math.round(state.transitionMs / 100) } : {}),
        ...(rgb || target.segment !== undefined ? { seg: [segment] } : {}),
      });
      await response.body?.cancel();
      return;
    }
    const base = `${target.url.replace(/\/$/u, "")}/api/devices/${encodeURIComponent(target.deviceId!)}`;
    let actions = this.capabilities.get(target.id);
    if (!actions) {
      const detail = await (await send(base)).json() as any;
      // Hue targets on this HomeTruth instance feed the monitored source back
      // into itself. Refuse them, including composed lights, until explicitly
      // described by a non-Hue concrete model.
      const model = String(detail.model?.id ?? "");
      if (!model || /hue|group|composite/iu.test(model)) throw new Error("HomeTruth targets must be concrete non-Hue lights to prevent feedback loops");
      const capability = detail.object?.capabilities?.light ? "light" : "stringLight";
      actions = detail.object?.capabilities?.[capability]?.actions;
      if (!actions) throw new Error("Destination has no light capability");
      actions = { ...actions, capability };
      this.capabilities.set(target.id, actions);
    }
    const invoke = async (control: string, value?: unknown) => {
      if (!actions[control]) return;
      const response = await send(`${base}/capabilities/${actions.capability}/controls/${control}`, value === undefined ? {} : { value });
      await response.body?.cancel();
    };
    // Set color/dimming before power: APIs that implicitly turn on cannot undo off.
    if (state.color && state.color !== "#000000") await invoke("setColor", state.color);
    if (state.colorTemperatureKelvin !== undefined && actions.setColorTemperature) {
      const bounds = actions.setColorTemperature;
      await invoke("setColorTemperature", Math.min(bounds.maximumKelvin, Math.max(bounds.minimumKelvin, state.colorTemperatureKelvin)));
    }
    if (state.brightnessPercent !== undefined && actions.setBrightness) {
      const bounds = actions.setBrightness;
      await invoke("setBrightness", Math.min(bounds.maximumPercent, Math.max(bounds.minimumPercent, state.brightnessPercent)));
    }
    if (state.on !== undefined) await invoke(state.on ? "turnOn" : "turnOff");
  };
  async stop(): Promise<void> { await Promise.all([...this.mqtt.values()].map(client => client.endAsync(true))); }
}

function kelvinRgb(kelvin: number): number[] {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  return [t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592, t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492, t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307].map(v => Math.round(Math.max(0, Math.min(255, v))));
}
