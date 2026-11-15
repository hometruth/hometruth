# Whisker Litter-Robot 4

The Litter-Robot 4 has no local API. HomeTruth reads and controls it through
Whisker's cloud with the account used in the Whisker app.

## Prerequisites

- The robot is set up and online in the Whisker app.
- Store the account: `ht secrets set vendors.whisker.username` and
  `ht secrets set vendors.whisker.password`. Accounts with MFA are not supported.
- Restart HomeTruth after adding the account.

## Configure

Add a `litter-robot-4` entry with the robot's serial from the Whisker app, then
optional child entries that reference it: `litter-robot-4-switch` with
`control: nightLight` or `panelLockout`, and `litter-robot-4-button` with
`action: cleanCycle` or `reset`. See `devices.example.yml`.

## Supported

- Readings: status, waste drawer %, litter level %, cat weight (lb), clean-cycle
  wait, sleep mode, hopper connected, night light lit, power source, online and
  last seen.
- Switches report what Whisker last said, not what was last requested. The night
  light reads on in both On and Automatic mode; turning it on selects On.
- Buttons start a clean cycle or press reset. Both move the globe. They are
  refused while Whisker reports the robot offline.
- All robots on the account share one connection, polled every 60 seconds while
  a page is watching.

## Limits

- Cloud only: when Whisker or the internet is down, the robot shows as offline.
- Not adjustable here: clean-cycle wait time, globe light, panel brightness and
  the sleep schedule.
- A change made in the Whisker app appears at the next poll.
- Whisker's API is undocumented. This adapter follows the open-source
  pylitterbot library and may break when Whisker changes it.
