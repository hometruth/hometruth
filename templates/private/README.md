# Private HomeTruth installation

Keep this repository **private**. Commit only device inventory, nonsecret site
settings, Hue routing, Kindle layouts, automation settings and reviewed research
notes/source under `research/`. All research stays private. Passwords, API
tokens, Wi-Fi passwords, private keys, pairing state, `.env` files, captures,
logs and runtime databases must never enter Git, even here.

Clone the public HomeTruth source into a sibling directory. The recommended
layout is `hometruth/` beside `hometruth_private/`; any private directory name
works when passed to `bun run site`. From the public source directory:

```sh
bun install
bun run site ../my-home check
# Start this yourself in your terminal when ready:
bun run site ../my-home start
bun run site ../my-home ht secrets set devices.example-camera.password
```

`site.json` contains an allowlisted `environment` object. `devices.yml` is
required; `hue-proxy.yml`, `kindle.json` and `dog-announcer.json` are optional.
HomeTruth reads and writes these files directly. Restart after editing site
environment settings. This private directory is the working directory for all
installation commands. Its ignored `.hometruth/` holds runtime data and local
secrets; `.env.local` holds local environment values. Back these files up
separately with encryption; never commit them. Public source holds code and
dependencies only. The short commands such as `bun run dev` and `bun run ht`
use `../hometruth_private/`; use `bun run site` for any other private location.
Set `HOMETRUTH_SECRETS` in your process environment for a secrets file elsewhere.

For deployments, use this repository's **Settings → Secrets and variables →
Actions**. Store secret values as Actions secrets, and ordinary deployment
settings as variables. Scope secrets to a protected deployment environment
when available. The `HOMETRUTH_SECRETS_YAML` secret can hold the local secret
file's YAML. The public repo requires no access to it. See the public project's
`docs/REPOSITORIES.md` for injection and cleanup instructions.

Use `bun run release:check --repo ../my-home --kind private` in the public
source before committing. This checks the Git index, so stage the reviewed config and research first.
The ignore rules are only a first barrier: `git add -f` bypasses them.

The public project's `skills/hometruth-setup/SKILL.md` can prepare this local
repository and optionally create and push to your own private GitHub repo.
See `docs/REPOSITORIES.md` for the publishing procedure and the required
nonsecret `HOMETRUTH_REVISION` variable for the starter workflow.

The optional `hometruth-action.yml` workflow can run `ht` commands on a local
GitHub self-hosted runner. See the public project's `docs/LOCAL_ACTIONS.md` for
runner setup, event examples and security requirements.
