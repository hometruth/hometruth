# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People operating and maintaining their own home-automation installations, and
agents helping them configure devices or use the CLI and API. Installations
vary in size, devices, network equipment, operating system and technical skill.
No particular household inventory or vendor account is assumed.

## Product Purpose

HomeTruth is a self-hosted, local-first home automation server. It makes device
state and supported controls available through a consistent interface. Users
should be able to inspect a reading, perform a requested action and understand
whether it succeeded without learning each device's protocol.

## Positioning

Each device is an instance of a model composed from capabilities. Models,
instances, controls and events are enumerable through the API, CLI and UI.
HomeTruth has a limited supported-device inventory and ships agent skills for
installation, operation and adding models. Local protocols are preferred;
some adapters require vendor clouds or one-time cloud setup. Compatibility
and connectivity limits must be explicit.

## Operating Context

- A server on a user-selected host, with access to the devices it controls.
- A responsive web UI, JSON API and CLI; optional integrations are configured separately.
- Phones, tablets and computers in varied lighting conditions, using touch, keyboard or assistive technology.
- A separate private installation for inventory, preferences and runtime state; credentials never enter Git.

## Capabilities and Constraints

- Server-rendered HTML, nonce-based CSP and locally served assets. Fonts use system stacks or self-hosted files.
- Custom elements consume the shared state stream. Pages distinguish loading, stale, offline and unknown readings.
- Euclid, Swiss and Brutal themes each support light and dark appearance. English, German, French and Spanish catalogs use `Intl` formatting and logical layout properties.
- Device pages render only capabilities and actions the configured device exposes. A camera need not have movement, audio or recording controls.
- Physical actions and destructive operations retain their declared confirmation requirements. A successful transport request is not automatically verified device state.

## Brand Commitments

- Name: HomeTruth, one word with capital H and T.
- Euclid is the default visual language; themes share state semantics and accessibility requirements. See [DESIGN.md](DESIGN.md).
- Voice: concise, concrete and candid about limits. Controls name their action; errors explain the problem and a useful next step.

## Evidence and Product Principles

1. Show observed state; never disguise an unknown value as a successful reading.
2. Use one vocabulary across UI, API and CLI, derived from model declarations.
3. Keep everyday tasks direct; put detailed setup and protocol explanations in documentation.
4. Prefer local operation, disclose cloud dependencies, and keep installation data and credentials private.
5. Publish reusable support and synthetic examples, not a maintainer's inventory or research journal.

Implementations and contracts live in `src/devices/`, `src/models/` and their
tests. [Supported devices](docs/SUPPORTED_DEVICES.md) describes the current
scope. Tests and schemas do not by themselves establish hardware compatibility.

## Accessibility and Inclusion

Provide keyboard controls, visible focus, meaningful labels, live feedback and
adequate contrast in every theme. Respect reduced motion and text expansion.
Use logical layout properties so adding a right-to-left locale does not require
a redesign. Empty, offline and unconfigured states are ordinary product states.
