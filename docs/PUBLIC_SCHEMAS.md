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
deploying Cloudflare account; Cloudflare then manages DNS and TLS. Since a
Custom Domain handles the entire hostname, paths outside `/schemas/` currently
return 404. If a main website is later deployed, move this Worker to a
`hometruth.ai/schemas/*` route in front of that site's proxied hostname.

Authenticate with Wrangler outside the source checkout, or supply
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through local secret storage or
a trusted deployment job. Never put credentials in the config or public CI.

```sh
# Build and check the production configuration without publishing:
bun run schemas:deploy --dry-run
# Publish to the separate workers.dev preview, without changing production DNS:
bun run schemas:deploy --env preview
# Publish the canonical domain after its Cloudflare zone is active:
bun run schemas:deploy
```

Every deploy rebuilds from the definitions; it cannot silently reuse stale
output. Public CI checks compilation and publication tests but does not deploy.
The preview uses the same canonical `$id` values as production.

After production deploys, verify the catalog and a nested model schema:

```sh
curl -fsS https://hometruth.ai/schemas/
curl -fsS https://hometruth.ai/schemas/models/broadlink-rm4-pro/config
```

See Cloudflare's [Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
and [Wrangler custom builds documentation](https://developers.cloudflare.com/workers/wrangler/custom-builds/).
