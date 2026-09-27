# Writing the HomeTruth device model

The research ends in code with a fixed shape. Read these before writing:

- `src/models/capability.ts`: `CapabilityKind`, the `Capability<Doc>` base,
  `invoke()` as the single write path, `describe()` as a validated document.
- `src/models/device.ts`: `Device` (an instance: model + config),
  `DeviceModel` (the enumerable record with `configSchema` and `create()`),
  `SiteServices` (how a vendor service reaches a product without a container).
- `src/models/binary-switch.ts` and `light.ts`: what an abstract capability
  looks like: abstract operations, `invoke()` switch, `describe()` that
  validates against the schema in `src/schemas.ts` and reports `offline`
  rather than guessing.
- `src/devices/switches/shelly-plus-1/index.ts`: the smallest complete
  product. Then `src/devices/lights/elgato-key-light-air/index.ts`.
- `docs/OBJECT_MODEL.md` for the target layout and the reasons behind it.

## Where things go

```
src/protocols/<vendor>/     wire codecs, crypto, transports. No device or site knowledge.
                            Fixture-tested with synthetic protocol examples.
src/vendors/<vendor>/       shared services the product needs at runtime:
                            account/cloud client, local cloud emulator (hub),
                            DNS override + reconnect, discovery inventory.
                            Only when the vendor has such services.
src/devices/<kind>/<product>/
  index.ts                  `class <Product> extends Device<Config>`; wires capabilities
  model.ts                  the `DeviceModel` record (id, title, manufacturer, product,
                            capabilities, configSchema, objectSchemaId, create)
  config.ts                 config schema (`host` via `lanHostSchema`, serial, options)
  <capability>.ts           one class per capability, extending the abstract from src/models/
  controls.ts               the product's control catalog, if it has many settings
  link.ts                   transport selection (local emulator > standards > cloud) if several
  index.test.ts             unit tests with fakes; no device required
```

`<kind>` is the primary capability's plural (`switches`, `lights`,
`treat-dispensers`, `cameras`, `blasters`). `<product>` is the marketing name
in kebab-case.

## New capability kinds

If the device does something no existing kind covers:

1. Add a schema for the capability's document in `src/schemas.ts` (state with
   `availability`, bounded `actions`), wire it into `homeTruthObjectSchema`
   under `capabilities`, and add a validator in `src/validation.ts`.
2. Add `"<kind>"` to `CapabilityKind` and `CAPABILITY_KINDS`.
3. Write `src/models/<kind>.ts` mirroring `binary-switch.ts`: abstract
   operations named as the schema names its actions, an `invoke()` switch,
   and a `describe()` that validates and reports `offline` on read failure.
4. Add a UI renderer for the kind when the UI is capability-driven.

Keep the abstraction at the level a second vendor would share. A "camera"
has stream, snapshot, PTZ, talk; a "treat dispenser" has dispense, call,
schedule. Vendor property numbers, session types, and cloud quirks never
appear in `src/models/`.

## Product implementation notes

- Config is what identifies and reaches one instance: host, serial, channel.
  Credentials come from the private secrets store, never public config.
- Validate hosts as private LAN addresses; reject public ones.
- Map research verification levels into control descriptors: a control whose
  local route is only `transport ACK` is exposed but flagged unconfirmed; a
  control with no local route is not exposed (or is exposed as cloud-routed
  and labelled so).
- Destructive controls (reset, unpair, firmware update, delete recordings)
  require `confirmed: true` and are rejected before any packet is sent
  otherwise. Physical controls (dispense, move, sound) declare confirmation
  in their descriptor.
- Serialize device access per instance if the firmware accepts one session
  at a time; pace teardown before the next negotiation.
- Choose the transport policy for the device and disclose cloud dependencies.
  Do not silently route an intended local-only operation through the cloud.
- Provide `probe()` (is it there and is it the right device), and `reboot()`
  and `locate()` when the product has any way to do them; generic recovery
  builds on those.

## Tests

- Codecs: encode/decode round trips plus byte-exact synthetic fixtures reproducing the protocol shape; regenerate
  identifiers, keys and media instead of publishing raw capture bytes.
- Crypto: a synthetic known-plaintext vector as a test, so a key or
  byte-order regression fails immediately.
- Capability classes: fake transports; every `invoke()` id; `describe()`
  validates; read failure reports `offline`.
- Model: `configSchema` accepts the example config and rejects a public host.
- Keep a live audit script in `../hometruth_private/research/<device>/tools/` (same-value writes
  for every writable control, read-only probes for the rest) for manual runs
  against the real device. It is not part of `bun test`.

## Finishing

- Register the model in the model registry and add an entry to
  `devices.example.yml` with comments for each config field.
- Update `docs/SUPPORTED_DEVICES.md` and a focused device guide with prerequisites,
  supported behavior and limits. Keep the homepage README generic.
- Journal: a final "state of the device" and a pointer from
  `../hometruth_private/research/<device>/capabilities.md` to the product folder.
- Memory notes for operational facts that are not derivable from the code:
  which capture point worked, which runtime was LAN-blocked, what a given LED
  pattern meant, which account limitations exist.
