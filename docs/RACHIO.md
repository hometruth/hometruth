# Rachio

Rachio controllers have no local API. HomeTruth reaches them only through
Rachio's public cloud API, so they go dark when the internet does.

## Setup

1. In the Rachio app: Account settings → Get API key.
2. `ht secrets set vendors.rachio.apiKey` and paste it. Never put it in `devices.yml`.
3. `bun src/vendors/rachio/discover.ts` prints each controller's `deviceId`, its
   zones, and entries to paste.

## Models

- `rachio-controller`: online status and zone list; a standby switch (on means
  schedules are suspended); a stop-all-watering button; rain sensor, rain delay
  remaining and the watering zone as sensors.
- `rachio-zone` (`controller`, `zoneNumber`, optional `defaultMinutes`): on while
  Rachio reports the zone watering. `turnOn` waters for 1–180 minutes, a physical
  action. `turnOff` stops the controller, and only if this zone is the one running.
- `rachio-rain-delay` (`controller`, optional `defaultHours`): on while a delay is
  in force; `turnOn` delays schedules 1–168 hours, `turnOff` cancels.

## Polling and limits

Rachio allows about 1,700 API calls per key per day. All entries share one cache:
the account is read every 10 minutes and the current schedule every
`pollIntervalMs` (default 3 minutes, minimum 2) per controller, plus a few reads
after each command. When Rachio reports 150 or fewer calls left, status reads
pause until the allowance resets so commands keep working.

- Watering Rachio starts itself appears up to one poll interval late.
- After a command, the new state appears once Rachio reports it, usually within
  15 seconds.
- Rachio has no per-zone stop; stopping a zone stops the controller.
- A rain delay does not block manual zone runs.
- The on/off control in the web UI waters for `defaultMinutes`; the API and CLI
  accept a duration.
