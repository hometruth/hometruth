# HomeTruth

(hometruth.ai)[https://hometruth.ai/] <-- this is mostly written by a human, for humans

this is mostly written by AI, for AI 
      |
      |
      V

Paste this into your coding agent:

```text
Install HomeTruth using https://github.com/hometruth/hometruth/blob/main/skills/hometruth-setup/SKILL.md, then help me discover and set up my devices.
```

HomeTruth is an open-source, self-hosted home automation server. It brings device
state and controls into a web interface, command-line client and API, with local
control where the hardware supports it. Some integrations require a vendor cloud;
each device guide describes that dependency.

## Start with your devices

HomeTruth has a **limited inventory of supported devices**. Support depends on
the exact model, firmware and available protocol; it is not universal smart-home
compatibility. See [supported devices](docs/SUPPORTED_DEVICES.md) and run
`bun run ht ls model` against a running installation for its model catalog.

The repository includes agent skills for the whole workflow:

- [Install and set up HomeTruth](skills/hometruth-setup/SKILL.md): prepare the
  software and private configuration, then help you choose the first devices.
- [Use HomeTruth](skills/hometruth-cli/SKILL.md): discover available controls,
  read state and operate configured devices.
- [Add a device](skills/hometruth-add-device/SKILL.md): configure a supported
  model or implement a new model using the device's documented API.
- [Investigate an unsupported device](skills/reverse-engineer-iot-device/SKILL.md):
  assess an undocumented protocol when you want to pursue that work. Adding
  support may require hardware testing and is not guaranteed.

An agent can prepare the installation and configuration, then start HomeTruth
when ready. The setup skill explains the commands for running it yourself too.

## What HomeTruth provides

- Device pages with controls, observed state, timestamps and explicit availability.
- Groups, scenes, buttons and automations built from configured capabilities.
- A CLI and API that describe the devices and controls available in your installation.
- Optional integrations such as Apple Home switch export, camera services,
  network management and an e-ink dashboard.

Device models compose shared capabilities such as switches, lights, cameras and
sensors. This lets new integrations use the same interfaces and controls.

## Keep your installation private

Use separate sibling directories for the public source and your private
installation. Device inventory, addresses, research and local settings belong
in the private directory. Passwords, tokens, pairing state and runtime databases
must never be committed to either repository. Deployment credentials can be
stored as GitHub Actions secrets in your private repository.

The default convention is `hometruth/` beside `hometruth_private/`; other private
directory names work with `bun run site <directory> <command>`. See
[repository setup](docs/REPOSITORIES.md) for the starter template and secret storage.

By default, clients on a trusted private network have full access. Set
`HOMETRUTH_TRUST_LAN=off` and use [API tokens](docs/API_TOKENS.md) if your network
should not grant that access.

## Documentation and development

JSON Schema IDs use `https://hometruth.ai/schemas/`. See
[public schemas and Cloudflare hosting](docs/PUBLIC_SCHEMAS.md) for publication.

Start with the [documentation index](docs/README.md) for installation, device
guides, integrations, API usage and architecture. Model examples live in
[devices.example.yml](devices.example.yml); they are examples to adapt, not an
inventory to copy into a new installation wholesale.

For development, read [AGENTS.md](AGENTS.md) and the
[new-model guide](skills/hometruth-add-device/references/new-model.md). Keep code,
examples and tests independent of any particular home. Run `bun run typecheck`
and relevant tests with synthetic fixtures; server-based checks follow the
service-management instructions in `AGENTS.md`.

HomeTruth is licensed under the [MIT License](LICENSE).
