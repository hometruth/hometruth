# HomeTruth project instructions

## Repository separation

- Public source contains generic code, documentation and synthetic fixtures only.
- All research stays private: journals, investigations, experimental helpers, captures and datasets. Do not promote research files into public docs or tools. Finished reusable product code and synthetic tests belong in public source.
- Keep the installation repository beside the public checkout, conventionally `../hometruth_private/`. Its `research/` directory holds reviewed notes and research source. Keep all installation files physically outside public source, including `.env.local`, `.hometruth/`, captures, agent settings and worktrees. Do not hide personal files with public ignore rules. Run installation commands through `bun run site <private-directory> <command>`; the short commands use `../hometruth_private/`.
- Personal inventory, addresses, Wi-Fi names and local tooling settings stay out of public releases.
- Private installation repositories contain nonsecret config and reviewed, credential-free research notes/source. Passwords, tokens, private keys, raw captures and pairing state must never be committed to either repository.
- Use local secret storage or GitHub Actions secrets for deployment credentials. Never print values during audits.
- Read `docs/REPOSITORIES.md` before preparing releases. Check the exact staged tree and history with the release tooling; do not push the existing mixed development history to the public remote.

## Service management

- AI agents may start, stop, and restart HomeTruth development and production servers, supervisors, background services, and development watchers as needed to complete requested work. This includes starting services for browser checks and tests.

## Greenfield development

HomeTruth is a greenfield project. Apply this policy to all future work in this repository.

- Change models, schemas, APIs, routes, and configuration directly to the desired design. Breaking changes are expected.
- Do not add or retain backward compatibility: old-URL redirects, route aliases, deprecated exports, compatibility shims, dual formats, or fallback behavior for superseded contracts.
- When replacing a contract, remove the old implementation and update its callers, configuration, fixtures, tests, and documentation in the same change.
- Expose one current URL for each page. Removed URLs return 404; do not preserve bookmarks or resolve historical names and IDs.
- Do not keep legacy code or invent migration requirements for hypothetical existing users or deployments.


## Public documentation

- Write for arbitrary installations. Do not describe the maintainer's devices, rooms, accounts or network as product defaults.
- Keep the README brief and generic, with the setup-agent prompt first. Put model compatibility in `docs/SUPPORTED_DEVICES.md` and detailed instructions in topic guides.
- Public examples and test fixtures use synthetic identities and data. Research journals, historical design discussions, captures and installation notes stay in the separate private repository.
- Skills must work without access to a maintainer's private files or a particular agent vendor. Distinguish supported behavior, prerequisites and unverified limits.
