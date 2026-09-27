---
name: hometruth-add-device
description: "Add or configure a device in HomeTruth, assess supported model compatibility, create composites, or implement a new model for a documented protocol. Use when the user wants to onboard hardware or asks what HomeTruth supports. Hand undocumented protocols to reverse-engineer-iot-device."
---

# Add a device to HomeTruth

A configured device is an instance of a model: a stable ID, optional display
metadata, a `model` ID and nonsecret `config`. Credentials live separately.
Read the repository's `AGENTS.md` and use the
[setup skill](../hometruth-setup/SKILL.md) if no installation exists.

## Choose the path

1. **Compatible model exists:** configure an instance and its credentials.
2. **Documented protocol, no model:** implement a model using
   [the new-model reference](references/new-model.md).
3. **Undocumented protocol:** use
   [reverse-engineer-iot-device](../reverse-engineer-iot-device/SKILL.md) to
   investigate feasibility. A cloud-only device may have no usable local path.

On a running installation, `bun run ht ls model --json` returns model IDs,
capabilities, configuration schemas and secret schemas. Offline, inspect
`src/registry.ts` and the relevant model. The
[supported-device catalog](../../docs/SUPPORTED_DEVICES.md) links setup guides.
Do not infer compatibility from a shared brand or model family alone. Check
firmware, transport, authentication and action support.

## Provision a supported device

Find the selected device through its vendor discovery method, the configured
router provider (`bun run network clients`), or OS-appropriate mDNS/SSDP tools.
Use the [network skill](../hometruth-network/SKILL.md) for provider capabilities.
Keep discovery within the user's scope. Record a stable identity when available;
change a DHCP reservation only when part of the requested setup.

Append to the private installation's `devices.yml`, preserving existing entries
and comments. The following is illustrative, not an inventory to copy wholesale:

```yaml
schemaVersion: 2
rooms: [Office]
devices:
  - id: office-relay
    name: Office relay
    room: Office
    mac: '02:00:00:00:00:40'
    model: shelly-plus-1
    config: { host: 192.168.50.40 }
```

Use exactly the selected model's `configSchema`; extra fields are rejected.
Local transports require private LAN hosts. Cloud-backed models instead declare
their own account/device identifiers. Composites reference configured device IDs;
missing references and cycles are invalid. See [devices](../../docs/DEVICES.md).

Store required credentials under the model's declared secret paths:

```sh
bun run ht secrets set devices.<id>.<key>
bun run ht secrets list
```

Shared vendor credentials go under `vendors.<vendor>`. Values come from a secure
prompt or stdin, never command arguments, inventory YAML, public docs or chat.
Use the relevant device guide for pairing and account requirements. Do not remove
an existing controller pairing or replace firmware merely to check compatibility.

All short commands above assume a private sibling `../hometruth_private`.
For another location use `bun run site <private-directory> <command>`.

## Validate

```sh
bun run site ../hometruth_private check
```

This is a static configuration check. On a running server,
inspect the new device with `bun run ht <id> --json` after its config reload.
Check identity, availability, declared actions and readback. If the server is
stopped, agents may start it through `bun run site <private-directory> start`.
Only perform physical actions already requested by the user.

Report separately what was configured, what was observed on hardware and what
remains unsupported or unverified. An offline device must remain offline or
unknown; don't turn a successful YAML edit into a claim of working hardware.

## Publish reusable support

For a new model, add a synthetic example to `devices.example.yml`, update
[SUPPORTED_DEVICES.md](../../docs/SUPPORTED_DEVICES.md), and write a focused
setup guide when needed. Keep the main README generic. Use synthetic protocol
fixtures, injected transports and focused tests; no server-starting fixtures.
Private device records, pairing state, research, captures and credentials stay
outside the public checkout. A public adapter must not depend on a maintainer's
private scripts or files.
