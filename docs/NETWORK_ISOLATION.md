# Device internet isolation

Isolation is optional and requires a Network Tools provider that can enforce
internet rules. Configure and inspect the provider first; see
[Network Tools](NETWORK_TOOLS.md). A model's presence in HomeTruth does not mean
it will keep working without its vendor cloud.

## What isolation does

For a configured LAN device, the isolation service coordinates supported
provider operations:

1. Apply a per-device internet block while retaining the LAN connectivity needed
   by HomeTruth. The UniFi provider uses a MAC-based gateway firewall policy.
2. Redirect vendor hostnames declared by the model to local replacement services,
   when available. UniFi DNS records are network-wide and remain while any
   isolated device needs them; this can affect other clients using those names.
3. Capture or report network attempts when a capable provider and authorized
   capture access are configured. A firewall rule alone does not provide a full
   traffic trace or a replacement vendor service.

Inspect the device's isolation status and provider capabilities before changing
it. Wi-Fi reconnect operations can briefly interrupt the device. Rules do not
cover a separate cellular connection or an unmanaged fallback network.

## Use

From the public checkout, with the conventional private sibling:

```sh
bun run ht isolation
bun run ht isolate <device-id> on
bun run ht isolate <device-id> off
```

Use `bun run site <private-directory> ht …` for another installation. The same
controls are available on `/network-isolation`. API forms are `GET
/api/isolation`, `GET /api/devices/<id>/isolation` and `POST` to that device
path with `{"isolated": true}` or `false`.

The desired state persists in the private installation's
`.hometruth/network-isolation.json` and is reconciled at startup. Device
identity and provider connectivity must be available to apply a rule; inspect
reported failures rather than assuming the desired state is enforced.

## Model-specific replacements

The TKENPRO adapter supplies local registration/control and alarm-upload
listeners for its supported firmware. Some vendor HTTPS traffic is relayed
through the HomeTruth host to keep that firmware operational. Blocking the
camera's direct internet path therefore does **not** establish cloud-free
operation. See [TKENPRO setup and limits](TKENPRO.md).

A model without a local replacement may lose cloud-dependent functionality.
Validate the requested functions after isolation and inspect the actual network
path before claiming offline operation. Shared DNS changes can also affect a
vendor app on the same network.

Captures, TLS state and uploaded images stay in the private runtime directory.
They can contain credentials and personal media; never commit them to either
repository. Keep investigation journals and installation-specific findings in
private research, not public product documentation.
