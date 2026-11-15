# Enphase IQ Gateway

`enphase-envoy` reads an IQ Gateway ("Envoy") over its local HTTPS API: solar
production, home consumption and net grid power with their energy totals, IQ
Battery charge, power and available energy, and on-grid/off-grid status from an
IQ System Controller. It is read-only: no battery modes, no relays.

## Prerequisites

- The gateway's LAN address (private range or `.local`). A DHCP reservation helps.
- Firmware 7 or later needs an owner token for every request. Choose one:
  - Paste a token: `bun run ht secrets set devices.<id>.token`. Owner tokens last
    about a year; HomeTruth reports the expiry date once it passes.
  - Store the Enlighten login: `bun run ht secrets set devices.<id>.username` and
    `devices.<id>.password`. HomeTruth fetches a token from Enphase's cloud, keeps
    it in memory only, and renews it before expiry or when the gateway refuses it.
- Consumption and grid readings need a consumption CT. Today's solar energy needs
  a production CT.

## Readings

| Reading | Unit | Notes |
| --- | --- | --- |
| Solar production | W | Production CT, else the microinverters' sum |
| Home consumption | W | Consumption CT only |
| Net grid power | W | Positive importing, negative exporting |
| Battery charge | % | IQ Battery aggregate |
| Battery power | W | Positive discharging, negative charging |
| Grid | 1/0 | 1 on grid, 0 off grid; IQ System Controller only |
| Solar and home energy today and lifetime, battery energy available | kWh | |
| Inverters reporting | count | |

`unitReadings: true` adds one row per microinverter (last reported watts, timed by
the inverter's own report) and per IQ Battery.

## Limits

- The gateway's certificate is self-signed. HomeTruth accepts it for this LAN host
  only and does not pin it. With `serialNumber` set, the gateway's `/info` serial
  is checked before any token is sent.
- If the gateway is unreachable or refuses the token, every reading is
  unavailable. No values are carried over.
- Per-phase readings, grid import/export energy totals, and battery or relay
  controls are not supported.
- Field names follow Enphase's local API brief; battery power sign and some
  firmware 8 totals are not yet verified on hardware.
