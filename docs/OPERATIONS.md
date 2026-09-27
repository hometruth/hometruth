# Running HomeTruth

All configuration and runtime paths in this guide are relative to your private installation directory. Commands run from the public source checkout and use `../hometruth_private/`; use `bun run site <private-directory> <command>` for another location. Device names and addresses in examples are illustrative.

## Start the control center

Requirements: Bun 1.3.12 or newer and `ffmpeg` for browser video. Node.js
22.18+ or 24+ only for the Matter bridge.

```sh
bun install
# For a new installation only; keep an existing private checkout:
cp -R templates/private ../hometruth_private
# Edit ../hometruth_private/devices.yml and site.json, then start in your terminal:
bun run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Anyone on a private
network reaches everything without signing in — the LAN is the trust boundary.
Set `HOMETRUTH_TRUST_LAN=off` to require an API token from everywhere instead;
see [API tokens](API_TOKENS.md).

The home page lists the devices in `devices.yml` (see [Devices](DEVICES.md)) and
links to a control page for each one. `bun run dev` opens the public HTTP listener immediately, then loads
the configured device UI. Until the application can serve it, page requests
return `503 Service Unavailable` with no application HTML or fallback shell.
The same applies after a crash, failed startup, or upstream connection failure.
When the supervisor itself is stopped, the connection fails normally.
MQTT, camera listeners,
network isolation, photo processing, and model preparation start afterward.
Startup restores saved camera metadata without LAN discovery, camera probes,
cloud login, or a network-mode preflight. Discovery remains an explicit action.

`HOST` and `PORT` come from the private installation's `site.json`.
Use `HOST=127.0.0.1` for a loopback-only backend, or explicitly set
`HOST=0.0.0.0` for a LAN listener. For a dedicated production host, release
selection and HTTPS, see [Deployment](DEPLOYMENT.md). Keep
local environment files such as `.env.local` in that same private directory.
All relative config and runtime paths below refer to the private installation. HomeTruth binds that exact port; a conflict
is reported instead of scanning for another port and silently changing URLs.
`PORT=0` explicitly requests an OS-assigned port. Development-hub registration
runs in the background when `DEV_HUB=on`.

Source, device YAML, environment files, secrets, and service configuration
changes stage a new application process from an isolated source snapshot. The
working UI keeps serving until the replacement has loaded and validated its
configuration. An update that fails takes the old process down with it: the
source on disk is the only application, so a failed update is an outage rather
than a working page in front of code nobody wrote. Browser pages receive
update notices over SSE and offer a **Refresh** button. They never
automatically navigate when the server changes or reconnects, including when
the startup preview becomes ready, and do not poll for server readiness. Fresh
HTML displays immediately without waiting for the update stream. Background
service startup displays a notice and keeps the UI available. If the connection
fails, the page hides its controls and readings while reconnecting; an explicit
server failure displays an unavailable state. Browser internet-connectivity
events do not determine whether this local server is working. Unsaved inputs remain in
memory and return on reconnection; restoring a page from browser history also
reconnects before allowing interaction. Background tabs release their runtime
event stream and reconnect when shown. HTML responses use
`Cache-Control: no-store`; HomeTruth registers no service worker or saved-page fallback.
Exclusive service listeners transfer after the new UI is available. Each
retiring process has a three-second shutdown deadline, including native helpers.

Crashes restart the current source with bounded exponential backoff; an
earlier snapshot that happened to work is never revived. An unsolicited IPC
heartbeat detects stuck application event loops; there are no HTTP health
probes in the supervisor. `/_runtime/status` reports
startup/reload state, while `/api/health` becomes ready after core services are
wired. Optional services report their own availability on the Services page.
Source snapshots live in the private installation's ignored `.hometruth/dev/` directory and are removed
when retired. `bun run start` uses the same supervisor without file watching.

The public listener, its supervisor implementation, and `HOST`/`PORT` remain
fixed for a run; changing those requires restarting `bun run dev`. Application
code, UI templates, device implementations, and integration code reload without
restarting that listener. Open service streams can reconnect during a service
replacement, and in-flight device commands are never automatically replayed.
This handles application reloads on one host. Host-process or machine failure
requires recovery outside that supervisor.

If a browser serves HomeTruth while the server is stopped, inspect that browser's
DevTools → Application → Service workers for `http://127.0.0.1:3000/`.
A worker registered by another project on the same address can keep intercepting
HomeTruth even though this repository contains no worker. Inspect the worker
and unregister it for this origin if it belongs to an unrelated application,
then reload its controlled tabs. Do not clear cookies, databases, or
unrelated site data. Verify in the affected browser, since a separate browser
profile may have no such registration.

### Themes and languages

Every page renders through one shell (`src/ui/shell.ts`) with three themes,
each in light and dark: **Euclid** (default; book paper, an old-style serif,
ink rules, blue / vermilion / ochre as state colours), **Swiss** (grotesque
sans, grayscale, one red accent), and **Brutal** (neobrutalist: black
capitals, 3px rules, hard offset shadows, a yellow panel, a pink accent). A
theme is a folder under `src/ui/themes/<id>`: `theme.ts` holds its complete
light and dark colour tokens, shape tokens (`--radius`, `--shadow`, rule
weight, mark radius), character CSS, machine-readable `rules` a test enforces,
and the path of its browser entry; `index.ts` is that entry, which defines the
`ht-*` elements (Swiss reuses Euclid's; Brutal ships its own `ht-switch`). The
folder is registered in `src/ui/themes/index.ts` and named in every locale
(`theme.<id>`). The footer on every page chooses the theme (`euclid`, `swiss`,
`brutal`), the appearance (auto follows the OS), and the language, remembered
per browser in one cookie; `HOMETRUTH_THEME`, `HOMETRUTH_SCHEME`, and
`HOMETRUTH_LOCALE` set the site defaults, and the language otherwise follows
`Accept-Language`. English, German, French, and Spanish ship; every string the
UI shows comes from `src/ui/i18n/`, where a translation is a complete typed
record of the English catalog, so a missing key fails `bun run typecheck`.
Dates, numbers, and plurals go through `Intl`; layout uses logical CSS
properties so a right-to-left locale needs a catalog, not a redesign. Device
detail strings reported by the API (`"Not reachable"`, a vendor's own
messages) are data and stay as the device reports them.
