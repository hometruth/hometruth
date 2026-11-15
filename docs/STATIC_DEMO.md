# Static playground export

Export a disconnected version of an installation's HomeTruth interface. It uses
the same page renderers and controls, with generated sample readings. Buttons
change a browser simulation; they do not contact devices, accounts, or HomeTruth
services. The export needs only static file hosting, with no HomeTruth server. Browser
modules use content-based filenames so revised controls receive fresh code.

From the source checkout:

```sh
bun run demo:export
# Or export the public, entirely synthetic Fallingwater showcase:
bun run site ../my-home demo:export --showcase --output .hometruth/showcase
# Or choose another private installation and output directory:
bun run site ../my-home demo:export --output .hometruth/playground --base-path /demo
```

The short command uses `../hometruth_private` and writes `.hometruth/demo-export`
inside that installation. Rerun the same command whenever you want to regenerate
it. Identical configuration, options, source, dependencies and Bun version produce
identical file paths and bytes, regardless of build time, output directory or
host timezone. Sample timestamps are fixed illustrative values. Regenerating the
same demo also preserves its cookie identity.

Output paths are relative to the private installation. Generation finishes in a
temporary sibling directory before replacing the previous export, removing pages
that no longer exist. Failed builds leave the previous export intact. A
`.hometruth-demo-export.json` manifest records generated file hashes. Existing
directories without this manifest, or with edited or unexpected files, are
refused; preserve those files and choose another output directory. Output inside
the public source checkout is refused, including symlink aliases.

With `--showcase`, the exporter uses a fictional Hawaiian home with 36 objects:
lighting, climate, air quality, presence, cameras, irrigation, energy, audio,
television, kitchen devices, pet care, and a robot vacuum. Two large native
pixel-art scenes have labeled accessory cards below them. The house includes
an animated waterfall and a sliding gate that respond to their switches.
The overview contains no image markers or introductory copy. Device details
link onward to object state, schemas, the graph, and simulated API controls.
Relay-driven fixtures illustrate switches; they do not imply native gate,
blind, or fan integrations. An installation export shows its own device cards
without the fictional house artwork.

For an installation export, the exporter reads device configuration without
starting services or reading the device secret store. It writes HTML and browser assets beneath `demo/`;
serve the output directory as the static host's root and visit `/demo`. Subpages
use ordinary `.html` filenames; no application router is needed. Map `/demo` to
`demo/index.html` when configuring the host.

The export keeps configured device types and room/group structure, replaces
identifiers and display names, and invents readings. Connection addresses, serial
numbers, raw configuration, camera images, recordings, credentials and live event
history are excluded. To deliberately retain room and device display names, add
`--include-names`. Review that output before publishing it; keep the generated
installation export outside public source repositories.

Changes are saved in cookies scoped to the demo path (or `/` for the public
showcase, whose overview lives at the host root). Reloading or moving between
pages keeps the simulated state in that browser. **Reset demo** clears those
changes. Browsers that block cookies can still use the controls for the current
page, but cannot retain changes across reloads. A different browser starts fresh.

The simulation represents controls and sample state, not hardware protocol
behavior. Camera views use placeholders. Account setup, discovery, pairing and
other operations requiring a real service do not connect to anything. Unknown
API requests fail locally rather than falling through to a real server.

The published [HomeTruth showcase](https://hometruth.ai/) is served alongside the
public schemas. Its Content Security Policy blocks outgoing browser connections
and form submissions. The same protection is embedded in exported pages, so the
playground remains disconnected on other static hosts.

See [public hosting](PUBLIC_SCHEMAS.md#cloudflare-hosting) to publish an export
with the schema host. It requires the `/demo` asset base and serves the overview
at `/`, backed by `demo/index.html`. `/demo` and `/demo/index.html` return 404;
subpages retain their `/demo/*.html` URLs. Use `--showcase` with this host. Other
base paths need another static host with the matching overview mapping. Publishing is a separate step from exporting.
