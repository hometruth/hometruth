# Static playground export

Export a disconnected version of an installation's HomeTruth interface. It uses
the same page renderers and controls, with generated sample readings. Buttons
change a browser simulation; they do not contact devices, accounts, or HomeTruth
services. The export needs only static file hosting, with no HomeTruth server.

From the source checkout:

```sh
bun run demo:export
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

The exporter reads device configuration without starting services or reading
the device secret store. It writes HTML and browser assets beneath `demo/`;
serve the output directory as the static host's root and visit `/demo`. Subpages
use ordinary `.html` filenames; no application router is needed. Map `/demo` to
`demo/index.html` when configuring the host.

The export keeps configured device types and room/group structure, replaces
identifiers and display names, and invents readings. Connection addresses, serial
numbers, raw configuration, camera images, recordings, credentials and live event
history are excluded. To deliberately retain room and device display names, add
`--include-names`. Review that output before publishing it; keep the generated
installation export outside public source repositories.

Changes are saved in cookies scoped to the demo path. Reloading or moving between
pages keeps the simulated state in that browser. **Reset demo** clears those
changes. Browsers that block cookies can still use the controls for the current
page, but cannot retain changes across reloads. A different browser starts fresh.

The simulation represents controls and sample state, not hardware protocol
behavior. Camera views use placeholders. Account setup, discovery, pairing and
other operations requiring a real service do not connect to anything. Unknown
API requests fail locally rather than falling through to a real server.

The published [HomeTruth demo](https://hometruth.ai/demo) is served alongside the
public schemas. Its Content Security Policy blocks outgoing browser connections
and form submissions. The same protection is embedded in exported pages, so the
playground remains disconnected on other static hosts.

See [public hosting](PUBLIC_SCHEMAS.md#cloudflare-hosting) to publish an export
with the schema host, which requires the `/demo` base path. Other base paths need
another static host. Publishing is a separate step from exporting.
