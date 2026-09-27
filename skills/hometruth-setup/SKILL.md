---
name: hometruth-setup
description: "Install and configure HomeTruth, create a separate private configuration repo, optionally publish it privately on GitHub, discover supported devices, and verify setup. Use for first installation, adding an installation host, locating config or secrets, or diagnosing setup. For operating devices use hometruth-cli; for device onboarding or new model support use hometruth-add-device."
---

# Install HomeTruth and set up devices

HomeTruth is a self-hosted home automation server with a web UI, CLI and HTTP
API. Its device inventory is limited. Start from the user's devices and goals;
never assume a particular camera, speaker, router, operating system or account.
Some adapters use vendor clouds; others work locally after pairing or setup.

Read the checkout's `AGENTS.md` before working. Agents may start, stop and restart
HomeTruth development and production services as needed for the requested setup,
including supervisors, watchers and test servers. Reuse an existing server when
appropriate and run installation commands through `bun run site`.

## 1. Establish the installation

Identify the host OS, source checkout, intended private directory and any
existing installation. Reuse existing files; never copy a template over them.
Keep source and private directories separate, with neither nested inside the
other. Sibling directories are the default convention, not a required name.

Prerequisites: Git and Bun 1.3.12 or newer. Camera browser video additionally
needs `ffmpeg`; Matter features need Node.js 22.18+ or 24+. Inspect installed
versions before installing anything. Follow the platform's supported installer
if a dependency is missing. Do not assume macOS-specific tools on Linux.

Create the private workspace and its Git repository as part of installation.
For a fresh installation with neither directory present, from the chosen parent
directory:

```sh
git clone https://github.com/hometruth/hometruth.git hometruth
cd hometruth
bun install
mkdir -m 700 ../hometruth_private
cp -R templates/private/. ../hometruth_private/
mkdir -m 700 ../hometruth_private/research
git -C ../hometruth_private init -b main
bun run site ../hometruth_private check
```

The template provides an empty `devices.yml`, `site.json`, README, private ignore
rules and a config-check workflow. If either destination already exists, reuse
it and fill only missing files instead of running the fresh-install commands.
Initialize Git only if needed; verify that its repository root is the private
directory, not a containing repository. Preserve existing history and remotes.
Create `research/` for private notes; runtime storage and secret files are created
when needed. Do not create files containing placeholder passwords.
For another directory use `bun run site <private-directory> <command>` throughout.
The short package scripts assume `../hometruth_private`.

Use the user's own private repository, never the project's maintainer's private
repository. Preserve the template's protections for secrets and runtime files.

## 2. Put configuration in the right place

All paths below are relative to the private directory:

| Path | Purpose | Git policy |
| --- | --- | --- |
| `devices.yml` | Device IDs, names, model IDs and nonsecret connection settings | Private repo only |
| `site.json` | Nonsecret server settings such as `HOST`, `PORT`, theme and language | Private repo only |
| Optional `hue-proxy.yml`, `kindle.json`, `dog-announcer.json` | Integration choices | Private repo only |
| `.hometruth/secrets.yml` | Device/vendor/network credentials and client token | Never commit |
| `.hometruth/` | Pairing state, databases, captures and other runtime data | Never commit |
| `.env.local` | Local environment values, including optional vendor credentials | Never commit |
| `research/` | Installation notes and device investigations | Private; secret-bearing material stays ignored |

Enter credentials through a terminal prompt or protected stdin:

```sh
bun run site ../hometruth_private ht secrets set devices.<id>.<key>
bun run site ../hometruth_private ht secrets list
```

`list` prints paths only. Use model `secretsSchema` definitions for per-device
keys; shared credentials use `vendors.<vendor>` or `network.<adapter>`.
Never put values in Git, chat, command arguments, URLs, or `site.json`.
Deployment secrets are encrypted repository/environment settings, not committed
files. Let the user enter values directly when no secure input path is available.

## 3. Discover and configure the user's devices

Ask which devices or categories to begin with if not already specified. Identify
model and firmware before assuming compatibility. Use the
[supported-device catalog](../../docs/SUPPORTED_DEVICES.md) and the
[add-device skill](../hometruth-add-device/SKILL.md).

On a running installation, `bun run ht ls model --json` gives exact model
schemas. Offline, read `src/registry.ts`, the model files and
`devices.example.yml`. Copy only the entries needed into the private inventory;
never provision the entire example file.

Use vendor discovery or the configured Network Tools provider within the user's
network scope. A router integration is optional, and discovery does not itself
authorize changing DHCP, DNS, Wi-Fi admission or internet isolation. Prefer
read-only identification before pairing and physical controls. Keep addresses,
serials and discovered identities out of public source and documentation.

For unsupported devices, distinguish a missing adapter from an unavailable
protocol. The add-device skill can implement documented protocols; the
[device investigation skill](../reverse-engineer-iot-device/SKILL.md) covers
undocumented ones. Report limits without promising support or flashing firmware
as an ordinary setup step.

## 4. Save configuration and optionally publish to GitHub

Review and stage the nonsecret starter files and configured inventory, check the
Git index for secrets, and make an initial local commit. Use the
[repository procedure](../../docs/REPOSITORIES.md#save-configuration-and-optionally-publish-to-github),
which requires Gitleaks. For an existing repo, include only changes made for this
setup; preserve unrelated staged work. Use the user's configured Git identity.

Local Git is sufficient. If the user has not specified a GitHub preference,
offer to create or use a private repo while continuing local setup. When they
want GitHub backup, complete creation and push using their chosen owner/name;
`<owner>/hometruth_private` is the default suggestion. Existing authorization
is sufficient; do not ask again.

Create a new remote as **private**, without an automatic push. Before uploading,
verify the intended owner, remote URL and private visibility. Set the starter
workflow's nonsecret `HOMETRUTH_REVISION` variable to a reviewed, compatible commit
already published in `hometruth/hometruth`. Scan the index and all local refs,
then push the intended branch and verify its remote commit. For an existing
remote, inspect its visibility and history first; do not overwrite remotes or
force-push. Keep setup local if authentication, visibility verification, the
source revision or secret checks block publication, and explain what remains.

Report the private directory, local commit and, when published, the verified
private repository URL. Configure deployment secrets only when requested, as
GitHub Actions or environment secrets; never commit their values.

## 5. Validate and hand startup to the user

```sh
bun run site ../hometruth_private check
```

This validates configuration without starting services or contacting devices.
It does not prove credentials, pairing, LAN reachability or physical behavior.
Review the bind address: the default is loopback. LAN access and optional media
callbacks may require an address reachable by the chosen devices. HomeTruth
trusts private-network clients by default; see [API tokens](../../docs/API_TOKENS.md)
for `HOMETRUTH_TRUST_LAN=off` and explicit authentication.

Give the user the exact command for their private directory:

```sh
# The user runs this in their terminal, from the public source directory:
bun run site ../hometruth_private start
# Development alternative, also user-run:
bun run site ../hometruth_private dev
```

Do not stop an existing server unless requested, or start a second instance.
When the user's server is available, verify its configured URL and use:

```sh
bun run ht ls
bun run ht <device-id> --json
```

Use `HOMETRUTH_URL` for a nondefault URL. Separate successful config validation,
server reachability and device readback in the result. Exercise physical
controls only within the user's requested actions.

## 6. Continue using HomeTruth

- [CLI skill](../hometruth-cli/SKILL.md): inspect, operate and observe devices.
- [Operations](../../docs/OPERATIONS.md): startup, reloads and troubleshooting.
- [API guide](../../docs/API.md): automation and integration surfaces.
- [Documentation index](../../docs/README.md): optional integrations and device guides.

For code changes use focused tests with injected transports and `bun run
typecheck`. Do not run `bun run check` as an agent: its browser-test phase can
start a server. Installation does not require running the complete test suite.
