# Samsung Frame televisions

All configuration and runtime paths in this guide are relative to your private installation directory. Commands run from the public source checkout and use `../hometruth_private/`; use `bun run site <private-directory> <command>` for another location. Device names and addresses in examples are illustrative.

The `samsung-frame` model drives a Frame over the set's own local API and
nothing else: `GET http://<host>:8001/api/v2/` for power and identity, and two
WebSocket channels on port 8002 — `samsung.remote.control` for keys and
`com.samsung.art-app` for art mode. No Samsung account, no SmartThings, no
cloud. Infrared is a separate matter: an IR blaster is its own device with its
own codes, and this model does not touch it.

It is the first device of the generic `television` capability: power, a
vendor-neutral remote key vocabulary (`up`, `select`, `play`, `channelUp`…),
volume and mute, input selection, and — on a set that has one — art mode.

**Pairing happens once, on screen.** The first control HomeTruth sends makes
the set display a prompt. Accept it, and the token the set issues is written
to `.hometruth/samsung/tokens/<device-id>.json`; every later connection carries
it. That token is issued at runtime rather than typed in, so it lives beside
the Aqara HomeKit pairings rather than in `devices.yml` or the secrets
file. Delete the file to pair again.

**Two things about a Frame shape what the controls do.** A power *click* moves
the set between watching and art mode rather than turning it off, so `turnOff`
holds the power key for three seconds and `setArtMode` is the control that does
what a click would have done. And the set reports its power state and nothing
else over this API: volume, mute, and the current input are write-only, so
HomeTruth sends them as commands and never shows a reading it did not get.

```yaml
  - id: living-room-frame
    name: Living room Frame
    model: samsung-frame
    config:
      host: 192.168.50.60
```

```bash
bun run ht living-room-frame
bun run ht living-room-frame art-mode on
bun run ht living-room-frame press select
```
