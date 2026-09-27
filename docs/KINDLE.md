# Kindle interface

Use **Kindle** in HomeTruth's navigation to open `/kindle/designer` and build
a custom dashboard directly in HomeTruth.

1. Add a device from the searchable widget palette, or add text, a clock or a divider.
2. Drag widgets into place and resize them with the corner handle. Use the
   inspector for exact position and dimensions, labels, font size, alignment
   and borders. Device widgets can display the whole device or one capability,
   with interactive controls or status only.
3. Duplicate or remove widgets, bring them forward or send them backward.
   Undo and redo cover layout and property changes, including **Clear canvas**.
4. Choose a portrait, landscape or custom canvas size and a snap grid. Preview
   at fitted size or 50%, 75% or 100%. Cropped widget contents look the same in
   the preview and on the Kindle and show a warning; increase the widget's size
   or reduce its font size to fit them.
5. Click **Save dashboard** to publish the layout to the Kindle.

Select a widget and use arrow keys to move it by one grid step, or Shift + an
arrow for ten steps. Delete removes it; Ctrl/Cmd + Z undoes changes and
Ctrl/Cmd + Shift + Z redoes them. Layouts support up to 80 widgets. The default
canvas is 758 × 1024 design pixels. The entire canvas scales uniformly to fit
both the browser's actual width and its available height, reserving space for
Refresh. The Kindle browser's toolbar no longer cuts off the bottom of the
dashboard. The image and all tap targets use the same scale.

The server renders each canvas into a PNG using Chromium, then sends that same
image to the designer and Kindle. Fonts, wrapping, padding and clipping are
already resolved; the Kindle does not lay out the widget text again. Transparent,
accessible buttons over the image use hit regions measured during the same
render. The original control API still handles every action. The preview reads
current device status after edits, keeps controls disabled and never saves or
sends device commands. Opening the designer creates an unsaved starting layout if no canvas
has been saved yet. Changes stay in the browser until **Save dashboard**;
leaving the page discards unsaved edits. The clock updates with the dashboard's
refresh interval, not every second.

The original ordered-list editor remains at `/kindle/settings`, linked as
**View settings**. Without a canvas, it supports automatic inventory or ordered
device/capability entries, labels, status-only mode, text size and pagination.
Its saves preserve an existing custom canvas; arrange canvas widgets in the
designer. Both editors share the title and refresh interval (15–3600 seconds).

Canvas rendering requires the Playwright Chromium browser on the HomeTruth
server. Install it once with `bun run kindle:install-browser` (Linux hosts may
also need `bunx playwright install-deps chromium`). Rendering uses only local,
escaped HTML, with scripts and network access disabled. Browser processes are
closed after rendering, work is serialized, and a bounded image cache reuses
unchanged frames. The renderer uses Playwright's
[screenshot API](https://playwright.dev/docs/screenshots).

The Kindle picks up saved changes on its next refresh. Open
`http://<hometruth-server>:3000/kindle` on the Kindle for the interactive view.
The URL stays the same; no further firmware installation is needed.

The Kindle is on the local network, so by default it needs no token at all —
just open the URL. The rest of this section applies if you have set
`HOMETRUTH_TRUST_LAN=off`, or want the Kindle held to a narrower scope than the
rest of the LAN (a presented token always wins over the network it comes from).

The Kindle's browser cannot reasonably be asked to paste an API token, so give
it one in the URL, once:

```sh
ht tokens issue "Kindle dashboard" --can write --for all
```

Open `http://<hometruth-server>:3000/kindle?token=ht_…` on the Kindle the first
time. HomeTruth moves the token into an `HttpOnly` cookie and redirects to the
plain `/kindle`, so bookmark the page *after* it lands — the token does not
stay in the URL, the history, or the bookmark. The dashboard reads and drives
whatever its widgets show, so it needs `write` over every device today;
narrowing it is listed as unfinished in
[docs/API_TOKENS.md](API_TOKENS.md). Reload
an already-open older dashboard using the browser's Reload command once to
load the new client script; the dashboard's Refresh button updates data but
does not replace an older script.

## Capability presentation

Every configured model is supported through its declared capabilities. This
includes physical devices and logical groups, synthetic switches, optimistic
switches, and action buttons. There is no Kindle-specific device inventory.

| Capability | Kindle presentation |
| --- | --- |
| Binary switch | Observed state and On / Off controls |
| Light, including groups | Basic light state and On / Off controls |
| Button | Momentary Press action; it does not claim the appliance changed state |
| Sensors, occupancy, contact | Basic readings or availability |
| Cameras, speakers, blasters, hubs, other capabilities | Basic status |

Composite devices show each capability. A status-only entry hides its
controls. Commands use the existing capability API and event logging; the
Kindle has no alternate device driver or write path. A control must be both
advertised in the capability document and declared by the implementation.
Offline capabilities have no active controls. Stateless buttons can still
be pressed when another capability on the same device is offline.

The client waits for command completion and then rereads device state. It
never guesses an updated state or retries a command after a timeout or
failure. A failed refresh preserves the last display, marks it stale and
disables its controls until a successful read. Removed devices and removed
capabilities remain visibly unavailable in custom selections.

## Architecture and extension

- `src/kindle/config.ts`: validated configuration schema and defaults.
- `src/kindle/store.ts`: in-memory test store and atomic file store, with
  revision checks to prevent one editor overwriting another's changes.
- `src/kindle/presentation.ts`: converts device documents into text/status and
  action descriptors; `KINDLE_ADAPTERS` registers supported controls by capability.
- `src/kindle/canvas.ts`: creates a draft layout from an existing device selection.
- `src/ui/kindle-canvas.ts` and `kindle-widget.ts`: shared canvas geometry,
  typography, status rendering and controls used by the image renderer.
- `src/kindle/raster.ts` and `src/ui/kindle-raster.ts`: PNG rendering and a bounded
  frame cache, plus the shared image and measured control overlays for both views.
- `src/ui/kindle-designer.ts` and `kindle-designer-client.ts`: the modern visual
  editor, widget palette, inspector, drag/resize handling and undo history.
- `src/ui/kindle-page.ts` and `kindle-client.ts`: black-and-white HTML and ES5
  XMLHttpRequest client, separate from the modern desktop browser runtime.
- `src/ui/kindle-settings-page.ts`: normal HomeTruth editor and saved preview.
- `src/server/kindle-routes.ts`: configuration, inventory and view routes.

A new model composed of existing capabilities needs no Kindle code. A new
capability gets basic availability automatically. Add its basic textual state
to `summaryDetail` and, if it should be interactive, add explicitly supported
controls to `KINDLE_ADAPTERS`. Update the configuration capability enum and
catalog translations when introducing a new capability. The coverage test
checks the configuration against `CAPABILITY_KINDS`.

The Kindle renderer intentionally uses physical CSS directions, black/white
colors and old browser primitives for the Paperwhite 2. It does not load the
modern shared client or dump device configuration or secrets. Without
JavaScript, initial status and page/room navigation work; actions and polling
are disabled. UI labels support English, German, French and Spanish. Existing
device summary detail is displayed as reported by the device layer.

## Configuration API

| Route | Purpose |
| --- | --- |
| `GET /api/kindle/config` | Current `{ config, revision }` |
| `PUT /api/kindle/config` | Save `{ config, revision }`; stale revision returns 409 |
| `GET /api/kindle/catalog` | Devices/models, capabilities and supported Kindle controls |
| `GET /api/kindle/snapshot` | Current sanitized presentation rows |
| `POST /api/kindle/preview` | Read-only draft preview; accepts a complete config with canvas and returns `{ html, css, frame, generatedAt }` |
| `GET /api/kindle/images/:hash.png` | Cached PNG shared by the preview and device; no device commands |
| `GET /kindle` | Interactive e-ink view; optional `room` and `page` for list layouts |
| `GET /kindle?preview=1` | Preview with disabled controls |
| `GET /kindle/designer` | Visual dashboard designer |
| `GET /kindle/settings` | Ordered-list settings and saved preview |

Writes require JSON and the same origin, like the rest of HomeTruth. The
configuration schema is available in **Schemas** as `KindleConfig`.
The private launcher uses `kindle.json` when present; otherwise settings are
stored in `.hometruth/kindle-view.json` (override with `HOMETRUTH_KINDLE_CONFIG`). Saves are atomic, owner-only and serialized; a
corrupt file is reported rather than replaced with defaults. The test server
uses an in-memory store and does not modify installation configuration.

Example configuration (use real configured device IDs):

```json
{
  "version": 1,
  "title": "HomeTruth",
  "refreshSeconds": 60,
  "rowsPerPage": 4,
  "fontSize": 22,
  "selection": "custom",
  "items": [
    { "deviceId": "desk-light", "capability": "light", "mode": "auto", "label": "Desk" },
    { "deviceId": "scene-button", "capability": "button", "mode": "auto", "label": "Evening" },
    { "deviceId": "air-sensor", "capability": "sensor", "mode": "status", "label": "Air quality" }
  ]
}
```

Add the optional `canvas` property to a version 1 configuration to use a custom
layout. Its widgets take precedence over the retained list selection. Every
widget has a unique ID, rectangle in canvas pixels, font size, alignment and
border flag. Device widgets also bind to a configured device and capability;
text, clock and divider widgets are independent of devices. Multiple widgets
can show different capabilities of the same device, which is read once per
snapshot. Array order determines stacking, with the last widget on top.

```json
{
  "width": 758,
  "height": 1024,
  "grid": 8,
  "widgets": [
    {
      "id": "heading", "kind": "text", "text": "Device dashboard",
      "x": 24, "y": 24, "width": 710, "height": 100,
      "fontSize": 40, "align": "left", "border": false
    },
    {
      "id": "desk", "kind": "device", "deviceId": "desk-light",
      "capability": "light", "mode": "auto", "label": "Desk", "showLabel": true,
      "x": 24, "y": 144, "width": 344, "height": 220,
      "fontSize": 24, "align": "left", "border": true
    }
  ]
}
```

The canvas is 300–2400 pixels in each dimension. Widgets must remain within
its bounds; overlaps are allowed. Removing `canvas` from a configuration
returns the view to its retained list settings. No configuration migration
is needed for existing installations.

## Paperwhite 2 setup

Open `/kindle` in the Kindle's browser and bookmark the page. A jailbreak is
not required to visit the dashboard. Keep the server awake and reachable.
Physical-device investigations, launcher experiments and helper scripts live
in the private installation repository, outside the public distribution.

Server tests exercise composite capabilities, real invocation through test
devices, offline/missing state, persistence, revision conflicts and origin
checks. Browser tests cover commands in list and canvas layouts, failed reads,
no automatic command retries, drag/resize and keyboard editing, undo/redo,
saved layouts, preview appearance across themes, responsive editing and
JavaScript-disabled rendering.
Desktop tests do not establish compatibility on the physical Kindle; browser and firmware compatibility require a separate device check.
