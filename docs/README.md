# HomeTruth documentation

Start with the [setup skill](../skills/hometruth-setup/SKILL.md). It guides an
agent through installation and discovering the devices you choose to configure.
HomeTruth has a limited [supported-device inventory](SUPPORTED_DEVICES.md);
model and firmware compatibility must be checked for each device.

## Install and operate

- [Running HomeTruth](OPERATIONS.md): prerequisites, startup, reloads, appearance and language.
- [Public source, private installation, and secrets](REPOSITORIES.md): directory layout, private repositories and deployment secrets.
- [Local GitHub Actions](LOCAL_ACTIONS.md): run HomeTruth CLI actions on a trusted self-hosted runner.
- [Health](HEALTH.md): hourly checks, error events, uptime and recent problems.
- [Devices and composites](DEVICES.md): inventory, groups, tags and controls.
- [CLI skill](../skills/hometruth-cli/SKILL.md) and [API guide](API.md).
- [API tokens](API_TOKENS.md): authentication and permissions.
- [Network Tools](NETWORK_TOOLS.md), [Wi-Fi admission](WIFI_ADMISSION.md) and [network isolation](NETWORK_ISOLATION.md).

## Optional integrations

Enable only the integrations your installation needs. Each guide describes its
hardware, software and account prerequisites.

- [Apple Home](APPLE_HOME.md) and [Matter switch bridge](MATTER_SWITCHES.md).
- [Hue](HUE.md) and [Hue proxy](HUE_PROXY.md).
- [Frigate labels](FRIGATE.md) and [dog announcements](DOG_ANNOUNCEMENTS.md).
- [Kindle dashboards](KINDLE.md).

## Device guides

See the [supported-device catalog](SUPPORTED_DEVICES.md) for model IDs and
links to device-specific setup, capabilities and limitations. An example in a
guide does not describe the maintainer's installation or provision that device
for you.

## Develop

- [Add-device skill](../skills/hometruth-add-device/SKILL.md).
- [Device investigation skill](../skills/reverse-engineer-iot-device/SKILL.md).
- [Object model](OBJECT_MODEL.md), [graph](GRAPH.md) and [tags](TAGS.md).
- [Filters and events](FILTERS.md): reusable event predicates, payload schemas, and time windows.
- [State rendering](STATE_RENDERING.md) and [URLs](URLS.md).
- [Product principles](../PRODUCT.md), [design system](../DESIGN.md) and [contributor instructions](../AGENTS.md).

All research and installation-specific notes stay in a separate private
repository. Public docs describe reusable behavior, with synthetic examples.
