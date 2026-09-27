# Agent skills

Each subdirectory is a skill in the open Agent Skills format: a `SKILL.md`
with frontmatter (`name`, `description`) and instructions, plus optional
`references/`. The description is what makes a skill trigger, so it says
both what the skill does and when to use it.

`bun run skills:install` links every skill into
`../hometruth_private/.claude/skills/` for agents working in the private
installation. `bun run skills:install --global` links them into
`~/.claude/skills/` for use from any directory. The public `skills/` directory
contains source only; `bun install` does not create agent settings. Other agent
hosts can read the `SKILL.md` files directly or use their own skill installer.

| Skill | Purpose |
| --- | --- |
| `hometruth-setup/` | Install, configure, prepare user-run startup, and verify a HomeTruth server: prerequisites, the files and what goes where, secrets, the web UI, HTTP API, CLI and TypeScript surfaces, troubleshooting. |
| `hometruth-add-device/` | Add a device: provision an instance of an existing model in `devices.yml` (with per-model prerequisites and secrets), write a new model for a product with a documented local API, or hand off to reverse engineering. |
| `hometruth-cli/` | Operate the site from the shell with `bun run ht`, the universal HomeTruth client: list any kind of element, read what one is and what may be done to it, invoke controls safely, watch state live, reboot cameras, flip the DNS override, and reach the `tkenpro` camera CLI. |
| `hometruth-network/` | Router-independent Network Tools scripts: client inventory, DHCP reservations, DNS, reconnects, isolation, capture, admission, and provider setup. |
| `reverse-engineer-iot-device/` | Human-in-the-loop workflow for investigating requested capabilities of a consumer IoT device, assessing possible local paths, and implementing verified model support. |

Site-specific facts (addresses, VLAN names and observations about one home)
never go in a public `SKILL.md`; keep them in the private installation, such
as `../hometruth_private/local/network.md`. Credentials belong in its local
secret store, never in notes committed to either repository.
