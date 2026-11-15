# Public JSON Schemas

HomeTruth schema IDs use `https://hometruth.ai/schemas/`, with a unique path
for every document. For example:

```json
{
  "$id": "https://hometruth.ai/schemas/models/broadlink-rm4-pro/config"
}
```

The public host serves raw JSON Schema 2020-12 at the exact `$id` URL, including
model config and secrets **definitions**. `/schemas/` returns a JSON catalog
of IDs and titles. Schema responses use `application/schema+json` and allow
cross-origin reads. GET, HEAD, and OPTIONS are supported; unknown paths return
404. There are no old-domain aliases or `.json` suffix aliases.

Local HomeTruth `/schemas/<name>` pages remain installation documentation.
Validation uses the bundled definitions and does not fetch the public host.
The unversioned public IDs describe the current greenfield contract.

## Build and verify

```sh
bun run schemas:test
bun run schemas:build
bun run typecheck
```

`scripts/schema-hosting/catalog.ts` gathers the catalog, tag-name definition,
and registered model schemas. It rejects conflicting IDs and compiles all
serialized schemas together to verify references before publication.
`dist/schema-hosting/worker.js` contains only the definitions and a small HTTP
handler. The build also writes individual JSON documents under
`dist/schema-hosting/schemas/`, without filename extensions, matching the IDs.
The generated schema directory is replaced on each build to remove obsolete
documents. No installation is provisioned and no local server is started.

Do not deploy the source checkout or a private installation. The Worker has no
installation bindings, credentials, inventory, captures, or live device state.
Before publishing, inspect the generated artifact and scan it with Gitleaks:

```sh
gitleaks dir dist/schema-hosting --redact --no-banner --ignore-gitleaks-allow
```

## Cloudflare hosting

The configuration is `scripts/schema-hosting/wrangler.jsonc`. Production binds
`hometruth.ai` as a Worker Custom Domain. The zone must be active in the
deploying Cloudflare account; Cloudflare then manages DNS and TLS. The same
Worker can serve a disconnected [static playground](STATIC_DEMO.md) at `/demo`
and its HTML and assets beneath `/demo/`. All other unknown paths return 404.
The demo has no installation service bindings and cannot proxy API requests.

Authenticate with Wrangler outside the source checkout, or supply
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through local secret storage or
a trusted deployment job. Never put credentials in the config or public CI.

```sh
# Build and check a schema-only deployment without publishing:
bun run schemas:deploy --schemas-only --dry-run
# Build and check a demo deployment without publishing:
bun run schemas:deploy --demo-export /absolute/private/playground --output /absolute/private/hosting --dry-run
# Scan both exact deployment artifacts:
gitleaks dir /absolute/private/playground --redact --no-banner --ignore-gitleaks-allow
gitleaks dir /absolute/private/hosting --redact --no-banner --ignore-gitleaks-allow
# Publish schemas with a reviewed demo export, keeping all artifacts outside source:
bun run schemas:deploy --demo-export /absolute/private/playground --output /absolute/private/hosting
```

The deployment command requires either `--demo-export` or `--schemas-only`.
The bundled host requires exports with the `/demo` base path.
The latter deliberately removes any hosted demo. `--dry-run` and `--env preview`
are passed to Wrangler. Public CI checks compilation and publication tests but
does not deploy. The preview uses the same canonical `$id` values as production.

To add or update the demo while retaining an existing schema publication, pass
`--schema-documents /absolute/private/published-schemas.json`, containing the
reviewed JSON array of already published documents. Without that option the
build uses current source definitions. The hosting build writes an independent
Worker and Wrangler configuration beside the export, and points its static asset
binding directly at the export. No installation export is copied into source.

After production deploys, verify the catalog and a nested model schema:

```sh
curl -fsS https://hometruth.ai/schemas/
curl -fsS https://hometruth.ai/schemas/models/broadlink-rm4-pro/config
```

See Cloudflare's [Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
and [Wrangler custom builds documentation](https://developers.cloudflare.com/workers/wrangler/custom-builds/).
