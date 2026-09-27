# Public source, private installation, and secrets

HomeTruth uses three separate stores:

| Store | Contents | Must never contain |
| --- | --- | --- |
| Public `hometruth/hometruth` | MIT-licensed source, tests with synthetic fixtures, documentation, generic examples, private-repo starter | Home inventory, real device identifiers, research or captures, credentials, runtime data |
| Your private installation repo | Device inventory, addresses, room names, nonsecret environment settings, Hue routes, Kindle layouts, automation choices, reviewed research notes and source | Passwords, tokens, signing keys, pairing state, captures, databases, `.env` files |
| Local secret storage / deployment secret manager | Passwords, API tokens, app signing credentials, Wi-Fi credentials, SSH identities | Git commits |

Use your own private repository, with any name. Audit existing files and history
before importing configuration or publishing source; a private visibility setting
does not make committed credentials safe.
Ignore rules do not remove files from Git history and do not stop `git add -f`.

## Workspace convention

Use two sibling directories, each with its own Git repository:

```text
projects/
  hometruth/                 public source, examples and product documentation
  hometruth_private/         private installation repo
    site.json
    devices.yml
    research/               private journals, investigations and helper source
    .env.local              local environment/credentials, never committed
    .hometruth/             runtime data and secret store, never committed
```

Each person chooses their own private repository and directory name. Pass its
path explicitly to `bun run site`; no maintainer installation is required. Siblings keep private material outside source
archives, build contexts and checkout-wide tools by default.

The source and installation directories must be separate, with neither inside
the other. The launcher rejects nested directories and symlink aliases. Never
add the private checkout as a public submodule or symlink. Public ignore rules
cover only generated dependencies, test output and caches; unexpected personal
files remain visible. Private ignore rules exclude credentials and runtime data.

**All research stays private**, including journals, hardware investigation
notes, experimental scripts and datasets. Keep reviewed, credential-free notes
and source in the private repo's `research/`. Keep raw captures, extracted apps,
third-party checkouts, images, databases, logs and any secret-bearing material
in ignored local storage with encrypted backups. Do not promote research files
into public docs or a public `tools/` directory. Finished product implementations,
synthetic tests and generic usage documentation belong in public source.

## Create your installation

Copy **only** `templates/private/` into a new, separate directory and initialize a
private repository there. Do not copy the source checkout, `.git`, `.env`, or
`.hometruth`. Clone the public source beside that directory and run `bun install`.
Start with the empty `devices.yml`; copy relevant entries from the public
`devices.example.yml` and substitute your own addresses and identifiers.

`site.json` has an `environment` object of nonsecret string settings. Its allowed
keys are defined in `scripts/site.ts`; arbitrary environment variables and shell
commands are refused. Optional files are `hue-proxy.yml`, `kindle.json`, and
`dog-announcer.json`. The runtime writes changes directly to these config files.

From the public source directory:

```sh
bun run site ../my-home check
# Start the server yourself in your terminal:
bun run site ../my-home start
# Or run development mode yourself:
bun run site ../my-home dev
```

Config files reload through the supervisor. Changes to `site.json` require a
restart. No command above is run automatically by release preparation or CI.

Every installation command runs with the private directory as its working
directory. Its ignored `.hometruth/` contains tokens, pairing state, recordings,
databases, local secrets and source snapshots. Its `.env.local` supplies local
environment settings and credentials. Relative data paths resolve there. Back
these files up separately using encryption; never commit them. The source
checkout holds code and dependencies only. The short commands (`bun run dev`,
`bun run start`, `bun run ht`, `bun run camera`, `bun run network`) use the
`../hometruth_private/` convention; use `bun run site` for another location.

## Save configuration and optionally publish to GitHub

The [installation skill](../skills/hometruth-setup/SKILL.md) creates the sibling
private directory, copies the starter and initializes its own Git repository.
GitHub backup is optional; the local installation works without it.

For a new private repository, review the configuration, install Gitleaks, then
run these commands from the public source directory:

```sh
git -C ../hometruth_private add -- .gitignore README.md devices.yml site.json .github/workflows/check.yml
bun run release:check --repo ../hometruth_private --kind private
git -C ../hometruth_private commit -m "Initialize private HomeTruth configuration"
```

Stage optional configuration and reviewed research explicitly when needed. The
check examines staged contents; review them for personal secrets as well. For
an existing repository, preserve its history and unrelated staged work. Use the
user's configured Git identity. Run history checks after the first commit exists.

If the user wants GitHub backup, choose their account or organization and repo
name. `<owner>/hometruth_private` is a convention, not a maintainer-owned service.
For a new remote, authenticate with GitHub CLI and create it without pushing:

```sh
gh auth status
gh repo create "<owner>/<repository>" --private --source ../hometruth_private --remote origin
gh repo view "<owner>/<repository>" --json nameWithOwner,isPrivate,url
git -C ../hometruth_private remote get-url --push origin
```

Before any upload, verify the owner/name and push URL match the intended repo
and `isPrivate` is `true`. For an existing remote, inspect its visibility and
history instead of recreating it or replacing its URL. Do not force-push.

The starter workflow checks out `hometruth/hometruth`. Resolve a reviewed,
compatible 40-character commit SHA already published there and set it as a
**nonsecret repository variable** before the first push. A local-only source
commit cannot be used by this workflow. Substitute the chosen names and SHA:

```sh
gh variable set HOMETRUTH_REVISION --repo "<owner>/<repository>" --body "<reviewed-public-commit-sha>"
bun run release:check --repo ../hometruth_private --kind private --history
git -C ../hometruth_private push --set-upstream origin main
git -C ../hometruth_private rev-parse HEAD
git -C ../hometruth_private ls-remote origin refs/heads/main
```

Use the intended branch for an existing repo. Verify the remote commit matches
the local commit and report the private repository URL. If authentication, a
compatible public revision, private visibility or checks cannot be established,
keep the completed local setup and resolve that blocker before uploading.
Deployment secrets are optional and separate from this backup; use the secret
settings below only when the user requests a deployment.

## Local credentials

Use `bun run site ../my-home ht secrets set <path>` to enter credentials using
the terminal prompt. The default secret file is `<private-directory>/.hometruth/secrets.yml`, written
with owner-only permissions. To store it outside the checkout, set the absolute
`HOMETRUTH_SECRETS` path in the process environment for both server and CLI. The
server and CLI use the same override.

Device credentials belong under `devices.<id>`, shared vendor credentials under
`vendors.<vendor>`, network credentials under `network.<adapter>`, and the CLI
API token under `api.cli.token`. See [API tokens](API_TOKENS.md).

TKENPRO/CloudEdge cloud login additionally needs `MEARI_CA_KEY` and
`MEARI_CA_SECRET` from your authorized vendor integration. Supply them through
ignored local environment files or deployment secrets. Built-in app profiles
contain no signing credentials. Account-free LAN discovery does not need them.
Do not put credentials into device URLs, config comments, shell arguments or
the nonsecret `site.json` environment object.

## Deployment secrets in your private repository

Use **Settings → Secrets and variables → Actions** in your private repository.
These encrypted settings are separate from the repository's files and history.
For example, `HOMETRUTH_SECRETS_YAML` can hold the secret store's YAML, and
`MEARI_CA_KEY` / `MEARI_CA_SECRET` can hold vendor app signing credentials.
Configure values using the GitHub UI or an interactive `gh secret set` prompt;
do not put a secret value on a command line. Use environment-scoped secrets and
deployment approvals where your GitHub plan supports them.

A deployment job can materialize the YAML on its runner with restrictive
permissions. Keep this step in a trusted deployment workflow in the **private**
repository, after checking out reviewed source at a pinned commit and validating
config. Never run it on untrusted pull request code or `pull_request_target`.

```yaml
- name: Materialize deployment secret store
  env:
    HOMETRUTH_SECRETS_YAML: ${{ secrets.HOMETRUTH_SECRETS_YAML }}
  shell: bash
  run: |
    set -euo pipefail
    umask 077
    test -n "$HOMETRUTH_SECRETS_YAML"
    secret_file="$RUNNER_TEMP/hometruth-secrets.yml"
    printf '%s' "$HOMETRUTH_SECRETS_YAML" > "$secret_file"
    printf 'HOMETRUTH_SECRETS=%s\n' "$secret_file" >> "$GITHUB_ENV"
# Your deployment step securely transfers/injects the file into the target's
# secret store. RUNNER_TEMP is not persistent storage on the deployed host.
- name: Remove runner secret file
  if: always()
  shell: bash
  run: rm -f "$RUNNER_TEMP/hometruth-secrets.yml"
```

Do not upload the file as an artifact, include it in an image layer, print it,
enable shell tracing, or commit it after deployment. Structured secret values
may not be reliably masked after transformation. Grant only the deployment job
access to secrets, and use short-lived cloud credentials/OIDC where supported.
The public repository and config-check workflow receive no deployment secrets.
See [GitHub's secrets documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

The starter includes a config-check workflow. Set the **nonsecret repository
variable** `HOMETRUTH_REVISION` to a reviewed 40-character public commit SHA before
enabling it. It checks the private index and history using pinned public tooling.
The starter intentionally has no deployment target or automatic deployment job.

## Release checks

Install Gitleaks, then:

```sh
# Copy an explicit allowlist of current files into new trees, without history:
bun run release:prepare --output /absolute/path/to/new-release --private-repo ../my-home
# In a fresh public Git repository, after adding the public tree:
bun run release:check --history
# Check a separate private repo from the public source directory:
bun run release:check --repo ../my-home --kind private --history
```

Preparation preserves all existing work and copies only tracked, allowlisted
config and research files from the separate installation into the private
candidate. It reads their current working copies, so review uncommitted edits. Ignored research material stays local for separate review;
preparation does not delete or move it. All research, personal tooling settings,
captures, datasets, hidden runtime state, and old history stay out of the public
candidate. The SHA-256 manifest lives beside the candidates, outside
both repositories, and lists excluded paths for local review. Failed preparation
is not a release: fix findings and use a new output directory.

Checks inspect **index blobs**, not working-copy replacements, reject symlinks,
submodules, unmerged entries and forbidden paths, and run Gitleaks. `--history`
also scans every local ref and rejects disallowed historical paths. Public
exceptions match exact synthetic test vectors and exact TypeScript type names;
private scans have no such exceptions. Gitleaks suppression comments are ignored.
No scanner proves absence of every possible secret or personal detail: review the
manifest and changes, and compare against your current local credentials before
publication. Do not add broad scanner exceptions to make a release pass.

Run `bun run hooks:install` in the clean public repo for staged-file and history
gates. Hooks are local and can be bypassed; the public CI performs the same checks.
For private commits, run the explicit private check above and require its CI status.
Run `bun run typecheck` and `bun run test:release` without starting services.
Agents may start the services needed for live/server tests, following `AGENTS.md`.

An existing remote repository may still have old branches, tags, PR refs, forks,
or cached blobs. Replacing its default branch alone does not purge them. If any
real credential entered Git, revoke/rotate it and assess history cleanup before
publication. A clean new root commit does not erase objects retained by an existing remote.
