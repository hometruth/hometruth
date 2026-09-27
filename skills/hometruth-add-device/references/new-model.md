# Writing a new device model

Read these first; they are short and the shapes are fixed:

- `src/models/capability.ts`: `CapabilityKind`, the `Capability<Doc>` base,
  `invoke()` as the single write path, `describe()` as a validated document,
  `controlIds` (a control not listed there is unreachable by name).
- `src/models/device.ts`: `Device`, `DeviceModel`, `expose()`,
  `CapabilityMethods`, `lanHostSchema`, `SiteServices`, `SecretsBag`.
- The abstract capability you will extend in `src/models/` (`binary-switch.ts`,
  `light.ts`, `camera.ts`, `speaker.ts`, `sensors.ts`, `motion-sensor.ts`,
  `treat-dispenser.ts`, `blaster.ts`, `button.ts`).
- The smallest complete product: `src/devices/switches/shelly-plus-1/index.ts`.
  Then one with secrets: `src/devices/cameras/wyze-cam-v3/index.ts`.

## Layout

```
src/devices/<kind>/<product>/
  index.ts          the capability class(es), the Device subclass, config schema, model record
  index.test.ts     unit tests with a fake transport; no hardware
  controls.ts       only when the product has a large settings catalog
  <extra>.ts        firmware tables, motion sources, sound generation… as needed
```

`<kind>` is the primary capability's plural (`switches`, `lights`, `cameras`,
`speakers`, `sensors`, `hubs`, `blasters`, `treat-dispensers`, `composites`);
`<product>` is the marketing name in kebab-case. Wire-level codecs that know
nothing about HomeTruth go in `src/protocols/<vendor>/`; a vendor's shared
runtime services (an account, a bridge connection every device of that
vendor uses) go in `src/vendors/<vendor>/` and reach products through
`SiteServices` declaration merging.

## Skeleton: a relay with a local HTTP API

```ts
import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { binarySwitchSchema } from "../../../schemas";

export type AcmeFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export class AcmeRelaySwitch extends BinarySwitch {
  readonly host: string;
  private readonly fetchImpl: AcmeFetch;

  constructor(options: { id: string; host: string; fetch?: AcmeFetch }) {
    super(options.id);
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new BinarySwitchError("Acme relay host must be a private LAN address", "invalid_host");
    }
    this.host = host;
    this.fetchImpl = options.fetch ?? fetch;
  }

  override async turnOn(): Promise<void> { await this.call("/relay?state=on"); }
  override async turnOff(): Promise<void> { await this.call("/relay?state=off"); }
  override async toggle(): Promise<void> { await this.call("/relay?state=toggle"); }
  override async getState(): Promise<BinarySwitchState> {
    const body = await this.call("/relay");
    if (body.state !== "on" && body.state !== "off") throw new BinarySwitchError("Acme relay reported no state", "protocol");
    return body.state;
  }

  private async call(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`http://${this.host}${path}`), { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new BinarySwitchError(`Acme relay at ${this.host} is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
    }
    if (!response.ok) throw new BinarySwitchError(`Acme relay answered HTTP ${response.status}`, "protocol");
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== "object" || body === null) throw new BinarySwitchError("Acme relay returned a non-JSON response", "protocol");
    return body as Record<string, unknown>;
  }
}

export const ACME_RELAY_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/acme-relay/config",
  title: "Acme relay config",
  type: "object",
  additionalProperties: false,
  properties: { host: lanHostSchema },
  required: ["host"],
} as const;
export type AcmeRelayConfig = FromSchema<typeof ACME_RELAY_CONFIG_SCHEMA>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AcmeRelay extends CapabilityMethods<{ binarySwitch: AcmeRelaySwitch }> {}

export class AcmeRelay extends Device<AcmeRelayConfig> {
  readonly model = ACME_RELAY;
  readonly capabilities;
  readonly switch: AcmeRelaySwitch;

  constructor(instance: DeviceInstance, config: AcmeRelayConfig, options: { fetch?: AcmeFetch } = {}) {
    super(instance.id, instance.name, config);
    this.switch = new AcmeRelaySwitch({ id: instance.id, host: config.host, ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.switch.getState();
    return { model: ACME_RELAY.product };
  }
}

export const ACME_RELAY: DeviceModel<AcmeRelayConfig> = {
  id: "acme-relay",
  title: "Acme Relay",
  manufacturer: "Acme",
  product: "Relay",
  capabilities: ["binarySwitch"],
  configSchema: ACME_RELAY_CONFIG_SCHEMA,
  objectSchemaId: binarySwitchSchema.$id,
  create(instance: DeviceInstance, config: AcmeRelayConfig, _services: SiteServices, _secrets: SecretsBag): AcmeRelay {
    return new AcmeRelay(instance, config);
  },
};
```

Then in `src/registry.ts`: import `ACME_RELAY` and add it to `MODELS`.

What the abstract capability gives you for free: `invoke()` routing for
`turnOn`/`turnOff`/`toggle`/`getState`, `describe()` that validates the
document against `binarySwitchSchema` and reports `availability: "offline"`
when a read throws, `controlIds`, and `methods` (the names `expose()`
forwards). Other kinds work the same way; read the abstract class for the
operations it expects and the bounds it enforces (percent, kelvin, lease
milliseconds, one treat per call).

## Secrets

If the device needs a login, add a `secretsSchema` to the model record (an
object schema with `additionalProperties: false`, like
`WYZE_CAM_V3_SECRETS_SCHEMA`), read the validated bag in `create()`, and
never accept credentials in `configSchema`. Provisioning validates the
`devices.<id>` entry of the secrets file against it and names the entry on
error.

## Behaviour rules every model follows

- Reject public hosts; only private LAN addresses and `.local` names.
- A read failure is `offline`, not a guess and not a thrown error out of
  `describe()`.
- Destructive controls (reset, unpair, firmware, delete) require
  `confirmed: true` and are refused before any packet is sent. Physical
  actions (dispense, move, sound) say so in their control descriptor.
- One session at a time if the firmware demands it; serialize per instance.
- Every device must answer `checkHealth()` with the [health contract](../../../docs/HEALTH.md).
  The base implementation calls `probe()` and reads capability/sensor state;
  override it for a model-specific, read-only check. Report detected failures
  with `reportHealth()`, using credential-free descriptions. Cached identity
  alone must never prove physical health.
- `probe()` proves it is the right device (serial, model) when the API says;
  `reboot()` and `locate()` only when the product can, and generic recovery
  then works.
- Vendor property numbers, session types, and cloud quirks stay in the
  product folder or `src/vendors/`; nothing about the vendor appears in
  `src/models/`, `src/server/`, or `src/ui/`.

## Tests (`index.test.ts`)

With `bun test` and a fake `fetch` (or fake transport):

- every control id reaches the device with the right request;
- `getState()` maps both states and rejects a malformed body with `protocol`;
- an unreachable host makes `describe()` report `offline` and `probe()` reject;
- health checks distinguish healthy, unhealthy and unknown, respect disabled
  state, and never perform a control merely to test the device;
- the config schema accepts the example config and rejects a public host and
  an unknown key;
- if there is a `secretsSchema`: a missing required key is rejected.

Codec and crypto tests, when the protocol has any, live next to the protocol
in `src/protocols/<vendor>/` with byte-exact fixtures.

## Finishing

- `devices.example.yml`: a commented entry with every config field.
- Update `docs/SUPPORTED_DEVICES.md` and a focused device guide with prerequisites,
  supported behavior and limits. Keep the homepage README generic.
- `bun run typecheck` and focused tests using injected transports pass. Agents
  may start a server for browser tests and hardware checks when needed.
- On a running server, inspect a configured instance and its `--json`
  document. Exercise physical controls only as authorized, and record what
  was observed separately from what automated tests establish.
