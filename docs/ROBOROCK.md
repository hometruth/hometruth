# Roborock robot vacuums

HomeTruth talks to Roborock vacuums directly on the LAN with Roborock's local
protocol 1.0 (TCP port 58867). Nothing goes through the cloud at run time.

## Prerequisites

- The robot is on your network with a DHCP reservation.
- Its `duid` (device id) and `localKey`. Both are in the "home data" Roborock's
  cloud returns to the Roborock app after sign-in, and only need reading once.
  Tools that sign in to a Roborock account and list its devices show them, for
  example the python-roborock command-line tool. Treat the local key like a password.
- Robots that only speak the newer "L01" local protocol are not supported.

## Setup

1. Add a `roborock-vacuum` entry with `host` and `duid` (see `devices.example.yml`).
2. Store the key: `bun run ht secrets set devices.<id>.localKey`.
3. Add a `roborock-vacuum-action` entry for each action you want (`start`,
   `pause`, `stop`, `dock`, `locate`), with `vacuum: <id>`.

## What you get

- Readings: state, error, cleaning (0/1), cleaned area (m²), cleaning time (s),
  fan power and battery. State, error and fan power carry the code as the value
  and readable text as detail.
- Buttons: Start cleaning (or resume), Pause, Stop, Return to dock, Locate (plays
  a sound). Every button moves the robot or makes it sound.

## Limits

- No maps, rooms, schedules, consumables, mop or dock settings.
- A wrong local key shows as "replies do not decrypt; check its local key".
- If the robot refuses connections on port 58867, check that nothing else holds
  its local session and that the firewall allows the HomeTruth host.
