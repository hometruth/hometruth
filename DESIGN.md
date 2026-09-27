---
name: HomeTruth
description: A control panel that reads like a page from a proof book; three themes (Euclid default, Swiss, Brutal), each light and dark.
colors:
  euclid-paper: "#F4EBD8"
  euclid-panel: "#EBDFC6"
  euclid-ink: "#191816"
  euclid-ink-2: "#5F584D"
  euclid-hair: "rgba(25, 24, 22, .24)"
  euclid-blue: "#0E558A"
  euclid-ochre: "#7A5806"
  euclid-ochre-mark: "#E4A412"
  euclid-vermilion: "#C43C35"
  euclid-blue-soft: "rgba(14, 85, 138, .10)"
  euclid-vermilion-soft: "rgba(196, 60, 53, .10)"
  euclid-ochre-soft: "rgba(228, 164, 18, .16)"
  euclid-stage: "#191816"
  euclid-dark-paper: "#191816"
  euclid-dark-panel: "#242220"
  euclid-dark-ink: "#EFE2C9"
  euclid-dark-ink-2: "#B3A78E"
  euclid-dark-hair: "rgba(239, 226, 201, .24)"
  euclid-dark-blue: "#7FB2DE"
  euclid-dark-ochre: "#E4A412"
  euclid-dark-vermilion: "#E07770"
  euclid-dark-blue-soft: "rgba(127, 178, 222, .14)"
  euclid-dark-vermilion-soft: "rgba(224, 119, 112, .14)"
  euclid-dark-ochre-soft: "rgba(228, 164, 18, .14)"
  euclid-dark-stage: "#0E0D0C"
  swiss-white: "#FFFFFF"
  swiss-panel: "#F2F2F2"
  swiss-black: "#111111"
  swiss-gray: "#6A6A6A"
  swiss-gray-mark: "#8C8C8C"
  swiss-hair: "rgba(17, 17, 17, .16)"
  swiss-red: "#C8102E"
  swiss-black-soft: "rgba(17, 17, 17, .07)"
  swiss-red-soft: "rgba(200, 16, 46, .09)"
  swiss-dark-ground: "#121212"
  swiss-dark-panel: "#1D1D1D"
  swiss-dark-white: "#F2F2F2"
  swiss-dark-gray: "#9C9C9C"
  swiss-dark-hair: "rgba(242, 242, 242, .18)"
  swiss-dark-red: "#FF3B4E"
  swiss-dark-white-soft: "rgba(242, 242, 242, .08)"
  swiss-dark-red-soft: "rgba(255, 59, 78, .14)"
  swiss-dark-stage: "#000000"
typography:
  body-euclid:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, Times New Roman, serif"
    fontSize: "17px"
    lineHeight: 1.5
  body-swiss:
    fontFamily: "Helvetica Neue, Helvetica, Neue Haas Grotesk Text, Arial, system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.5
  headline:
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-.01em"
  state-value:
    fontSize: "1.75rem"
    lineHeight: 1.2
  title:
    fontSize: "1rem"
    lineHeight: 1.2
  row-name:
    fontSize: "1.0625rem"
  small:
    fontSize: ".875rem"
  fine:
    fontSize: ".8125rem"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: ".875em"
rounded:
  none: "0"
spacing:
  s1: ".25rem"
  s2: ".5rem"
  s3: ".75rem"
  s4: "1rem"
  s5: "1.5rem"
  s6: "2.5rem"
  s7: "4rem"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.euclid-ink}"
    rounded: "{rounded.none}"
    padding: ".45rem .9rem"
    height: "2.5rem"
  button-primary:
    backgroundColor: "{colors.euclid-blue}"
    textColor: "{colors.euclid-paper}"
    rounded: "{rounded.none}"
    padding: ".45rem .9rem"
    height: "2.5rem"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.euclid-vermilion}"
    rounded: "{rounded.none}"
  button-icon:
    rounded: "{rounded.none}"
    width: "2.5rem"
    height: "2.5rem"
  input:
    backgroundColor: "{colors.euclid-paper}"
    textColor: "{colors.euclid-ink}"
    rounded: "{rounded.none}"
    padding: ".45rem .6rem"
    height: "2.5rem"
  stage:
    backgroundColor: "{colors.euclid-stage}"
    textColor: "{colors.euclid-dark-ink}"
    rounded: "{rounded.none}"
---

# Design System: HomeTruth

## Overview

**Creative North Star: "The Proof Book"**

Every HomeTruth page is a ruled page of propositions about the house. The device list is a table: name on the left, a status mark and its word on the right, one heavy rule above and hairlines between. State is written in notation colour, never in badges or panels. There is one accent-filled action on a screen; everything else is an ink-outlined button, a link, or plain text. The pages refuse the card grid, the hero metric, and the eyebrow.

Three worlds share one shell, one component vocabulary, one set of elements, and one message catalog. **Euclid** (default) is cream book paper, an old-style serif system stack, 1.5px ink rules, small-caps running heads, and blue / vermilion / ochre as notation colours; its status marks are round. **Swiss** is white or near-black, a grotesque sans, 1px hairlines, a grayscale opacity hierarchy, and one red; its marks are square. **Brutal** is warm off-white or black, a grotesque sans set in black capitals, 3px rules, hard offset shadows, .375rem corners, a yellow panel, and an electric pink accent; it is the one theme with its own switch template. Every theme ships light and dark; the theme is chosen with `data-theme`, the scheme with `data-scheme`, and pages never write a colour. A theme is a folder under `src/ui/themes/<id>`: `theme.ts` (complete token records for light and dark, shape tokens, character CSS, machine-readable `rules`, the browser entry) and `index.ts` (the browser entry that defines the elements), registered in `src/ui/themes/index.ts`. The build's constraints: nonce-only CSP (no external fonts, styles, or scripts, so every face is a system stack), server-rendered HTML with one inline stylesheet and one module script per page (the theme's entry, real TypeScript served type-stripped from `/ui/<version>/…`), pages that read before the first frame arrives (the state graph's cached records are embedded in `#ht-state`), and one Server-Sent Events stream per page that carries device state to the page's `ht-*` elements.

**Key Characteristics:**
- Ruled, single-column tables of state; no cards. Shadows, radii, and filled blocks only where a theme's `rules` allow them (Euclid and Swiss: none).
- One accent action per screen; the accent is also the link and focus colour.
- Status is a mark plus a word, always together; colour is never the only signal.
- Three themes, each light and dark, from one attribute pair on `<html>`.
- Device state is live: a page opens one stream, and each `ht-*` element renders the node it is bound to.
- Every string from the catalog in four complete locales; `Intl` for dates, numbers, plurals.

## Colors

Two palettes of paper, ink, and notation; each has a dark inversion with the same roles.

### Primary
- **Euclid Blue** (`euclid-blue`, dark `euclid-dark-blue`): the accent and the "live" colour. Fills the one primary button, colours links, the focus ring, selection, the `ok` mark, and the `ok` feedback tone. Blue means both "act here" and "this is working".
- **Swiss Red** (`swiss-red`, dark `swiss-dark-red`): the single Swiss accent. Fills the primary button and colours links and focus. In Swiss, `ok` is ink (`swiss-black` / `swiss-dark-white`), not the accent; red is reserved for action and fault.

### Secondary
- **Euclid Vermilion** (`euclid-vermilion`, dark `euclid-dark-vermilion`): fault and danger. Offline marks and words, the problems list border and text, danger buttons, error feedback, the mark on error-level log entries, and the dot of the live pill. In Swiss the same role is the accent red.
- **Euclid Ochre** (`euclid-ochre` for text, `euclid-ochre-mark` for the mark; dark uses the mark colour for both): degraded and connecting. The warn word on the status line, the degraded mark, the warn rail on log entries. Swiss uses grays (`swiss-gray` text, `swiss-gray-mark` mark).

### Neutral
- **Paper / Ground** (`euclid-paper`, `swiss-white`; dark `euclid-dark-paper`, `swiss-dark-ground`): the page and every input's background.
- **Panel** (`euclid-panel`, `swiss-panel`; dark variants): the only raised surface, used for pressed-button feedback and `<pre>` blocks. Not a card.
- **Ink** (`euclid-ink`, `swiss-black`; dark `euclid-dark-ink`, `swiss-dark-white`): text, headings, rules, control borders, the fill of a pressed toggle. **Ink 2** (`euclid-ink-2`, `swiss-gray`; dark variants): secondary text, labels, nav at rest, the unknown mark.
- **Hair** (`*-hair`): row and `kv` dividers, disabled borders, chip seams; always 1px. **Soft tints** (`*-soft`): hover fills and the new-entry flash; never a background at rest.
- **Stage** (`euclid-stage`, `swiss-dark-stage`, etc.) with `stage-fg`: the near-black frame behind video, snapshots, and region editors in every scheme.

### Named Rules
**The No Hex Rule.** Pages never write a colour value. Every colour on a page is a token from the shell (`var(--fg)`, `var(--bad)`, ...) or a `color-mix()` of two tokens.
**The Mark and Word Rule.** A status mark never appears without its word. Marks are `--mark` (.6rem) squares of colour: round in Euclid (`--mark-radius: 50%`), square in Swiss (`0`). `ok` = blue (Euclid) or ink (Swiss); `bad` = vermilion / red; `warn` = ochre / gray; unknown = Ink 2 at 50% opacity; `connecting` pulses.
**The One Accent Rule.** One `btn-primary` per screen. Toggled state (`aria-pressed`, `data-active`) is ink-filled, not accent-filled, so the accent stays the action.

## Typography

**Euclid Body Font:** Iowan Old Style (with Palatino, Book Antiqua, Georgia, Times New Roman, serif)
**Swiss Body Font:** Helvetica Neue (with Helvetica, Neue Haas Grotesk Text, Arial, system-ui, sans-serif)
**Mono Font:** ui-monospace (with SF Mono, Menlo, Consolas)

**Character:** One face per theme, in one weight for almost everything. Euclid sets running heads and section titles in all-small-caps with wide tracking, like a proof book; Swiss sets them as small bold tracked capitals and tightens the headline. Neither theme loads a display face; hierarchy comes from size, caps, and rules.

### Hierarchy
- **Headline** (h1; 400, 2rem, 1.2; Swiss 700 with -.025em): the page title, once, balanced. **State value** (1.75rem Euclid / 1.5rem Swiss bold -.02em): the one big number or word on a device page's state line.
- **Title** (h2; 1rem base): section titles carry the rule. Euclid: 1.0625rem all-small-caps, .06em tracking. Swiss: .75rem, 700, .1em tracking, uppercase. `legend` matches h2; h3 is 1rem in Ink 2. **Row name** (1.0625rem; Swiss 500): a device's name in the list.
- **Body** (17px Euclid / 16px Swiss, 1.5; measure 68ch): paragraphs and controls; text-size-adjust locked.
- **Small** (.875rem): metadata, labels, footer, feedback, notes. **Fine** (.8125rem): timestamps, event facts, capability status, compact controls. **Mono** (.875em): hosts, codes, schema ids, the pairing code (1.25rem, .1em). Numbers are tabular.
- **Label caps** (.75rem, .08em, uppercase): the live pill on the camera stage and the schema category tag. Tracked capitals label a thing; they never introduce a heading.

### Named Rules
**The No Eyebrow Rule.** Nothing sits above an h1. A section title is an h2 with its rule; a tracked-caps span is a label on a thing, not a kicker.
**The Running Head Rule.** The site name is set like a running head (Euclid small caps .08em; Swiss .8125rem bold uppercase .1em), and the primary nav matches it in the same case.

## Layout

One column, `min(52rem, 100% - 2.5rem)` wide, centred; wide pages (camera, schemas) use `92rem`. Under 40rem the column is `100% - 2rem`. Header and footer span the wide width and carry the page's two horizontal rules. The header is one baseline: site name left, nav right, wrapping under pressure. The footer is one line: theme, appearance, language selects, with the submit hidden once scripts run.

Spacing is a seven-step rem scale (`--s1` .25 to `--s7` 4). Rows pad `--s3`; sections separate by `--s6`; an h1 has `--s5` above and below; main pads `--s7` at the bottom. Rows are a two-column grid (name/meta at the start, status or actions at the end) that collapses to one column under 30rem, as does the `max-content / 1fr` `kv` grid. The camera workspace is `1.6fr / minmax(19rem, .8fr)` with a sticky viewer, collapsing under 62rem. All offsets are logical (`margin-block`, `padding-inline`, `inset-inline-start`, `text-align: end`), and `<html dir>` is set from the locale, so an RTL locale needs no CSS change.

## Elevation & Depth

The rule set is per theme. Each theme states it in the `rules` field of its `theme.ts`, and a test (`ruleViolations`) holds the theme's character CSS and shape tokens to it:

- Euclid: `{ shadows: "none", radii: "marks-only", gradients: false }`
- Swiss: `{ shadows: "none", radii: "none", gradients: false }`
- Brutal: `{ shadows: "hard-offset", radii: "any", gradients: false }`

Euclid and Swiss are flat: no drop shadows, no gradients, no layering. Depth is carried by rules: a heavy rule (`--rule-w`, 1.5px Euclid / 1px Swiss) opens a list, a section, or the state line; hairlines (1px at .16 to .24 alpha) separate rows. The one darker surface is the stage, a near-black frame for video and editors. `Panel` appears only as active-press feedback and behind `<pre>`. Log entries and business schemas carry a 3px inline-start rail drawn with `inset` box-shadow; it is a rule, not a shadow, and it is the only `box-shadow` in these two themes.

Brutal has depth. `--rule-w` is 3px ink. Buttons, chips, inputs, and the switch block sit on a hard offset shadow (`--shadow: .375rem .375rem 0 var(--rule)`; dark colours it with the accent), and a pressed button translates onto its shadow and loses it. Its `<ht-switch>` is a bordered block on a shadow, panel-yellow while on. No theme draws a gradient.

The vocabulary writes `box-shadow: var(--shadow)` and `border-radius: var(--radius)` on buttons, inputs, and chips, so a theme sets both from tokens; Euclid and Swiss set `none` / `0`.

**The Rule Not Box Rule.** Group content with a rule above it and hairlines between; never with a bordered or filled box. Brutal's switch block is the one allowed exception, and it is the theme's own template, not page CSS.

## Shapes

Per theme, from two tokens: `--radius` and `--mark-radius`. Euclid and Swiss are square (`--radius: 0` on buttons, inputs, chips, stage, and every container); Euclid's only curves are the status mark (`--mark-radius: 50%`), the light swatch (same token), and native checkbox/radio/range controls, and Swiss has none (`--mark-radius: 0`). Brutal rounds: `--radius: .375rem` on buttons, inputs, chips, and the switch block, and `--mark-radius: .375rem` on marks. Borders are ink at `--rule-w` (1.5px Euclid, 1px Swiss, 3px Brutal); disabled borders drop to hair. Details use a text triangle (`▸` / `▾`) as the disclosure glyph, not a native marker.

## Components

### Elements
Every live device view is a custom element bound to one graph node by its `node` attribute (`<ht-switch node="device/porch-relay">`). The server renders it with `htElement(ctx, tag, node)` and passes the node to `renderPage` so its cached record lands in `#ht-state`. The element subscribes to the node while connected, renders its `document` (`value.capabilities[kind]`; a `group/<id>` node's `binarySwitch`), and sends commands through the generic capability route. One theme entry defines all five tags.

- **`ht-switch`** (`binarySwitch`, or a group node): the switch page and the group switch page. Parts `state`, `mark`, `value`, `detail`, `gaps`, `actions`, `action turn-on | turn-off | toggle | get-state`, `feedback`; the host and `state` carry `data-phase` and `data-availability`, `value` carries `data-value` (on | off).
- **`ht-switch-row`**: one switch in the switches list. Mark, the state word in tabular figures, small On / Off / Toggle with no primary; no detail, no Refresh. Parts `state`, `mark`, `value`, `actions`, `action …`, `feedback`.
- **`ht-button`** (`button`): the button page. Parts `state`, `mark`, `value`, `detail`, `hold-field`, `hold-label`, `hold`, `actions`, `action press`, `feedback`; the hold field shows only when the document bounds a duration.
- **`ht-light`** (`light`, or `stringLight` with `capability="stringLight"`): the light and string light pages. The switch's parts plus `swatch` (`data-on`, `data-color`, `fill`), `brightness-field` / `brightness` / `brightness-label` / `brightness-value`, `temperature-field` / `temperature` / `temperature-label` / `temperature-value`, `white-field` / `action white` / `white-help`, `color-field` / `color` / `color-label` / `color-value`. A field is hidden when the document lacks its action; an input's bounds follow the document.
- **`ht-status`**: one device in a row on the home page and the group page. Mark, the availability word, and `summaryOf()` (On · 45 % · 2700 K, a reading preview, model and firmware) after a middle dot. Parts `state`, `mark`, `word`, `summary`.

Each element has an open shadow root with `delegatesFocus` and constructed stylesheets only: the shell's vocabulary adopted once from `#ht-css`, plus the class's own sheet. Page CSS does not reach inside; a page or theme styles a part with `ht-switch::part(value)`. Templates are structure only. Every word the element writes comes from the catalog through `ht.t()`; `renderPage` sends the element prefixes (`state.`, `live.`, `summary.`, `switch.`, `light.`, `stringLight.`, `button.`, `grouping.`, `camera.`, `speaker.`, `sensor.`) whenever a page passes nodes. Parts a template omits are skipped, never required, so a theme's template may drop a part.

`[data-theme]` character rules do not cross a shadow root. What a theme may retune is read inside the element from `--ht-<kind>-*` custom properties with token fallbacks, set on the page in the theme's tokens. Euclid's `ht-switch` declares exactly these:

```
--ht-switch-rule            falls back to var(--rule)
--ht-switch-rule-w          var(--rule-w)
--ht-switch-value-size      1.75rem
--ht-switch-value-weight    400
--ht-switch-value-tracking  0
--ht-switch-on              var(--ok)
--ht-switch-off             var(--fg-2)
--ht-switch-mixed           var(--warn)
--ht-switch-offline         var(--bad)
```

`ht-switch-row` reads `--ht-switch-on` and `--ht-switch-off`. `ht-button` reads `--ht-button-*`, then the switch's property, then the token; `ht-light` does the same with `--ht-light-*` and adds `--ht-light-swatch-on` (`--warn-mark`) and `--ht-light-swatch-off` (`--panel`). `ht-status` reads `--ht-status-word`, `--ht-status-offline`, `--ht-status-summary`. Swiss sets `--ht-switch-value-weight: 700`, `--ht-switch-value-tracking: -.02em`, `--ht-switch-value-size: 1.5rem` in its tokens (`extra` in its `theme.ts`) and reuses every Euclid element. Brutal ships its own `ht-switch` template (a block on a shadow, an On / Off rocker whose observed side is ink-filled with `aria-pressed`, Toggle as the one accent) with Euclid's part names, so the kind's `render()` drives it unchanged; its other four tags are Euclid's classes.

Before the theme's definition upgrades an element, its light-DOM child is the mark plus "Checking…" (`renderStatus`), the same line the element renders for its `checking` phase, so the upgrade is invisible and the page reads with scripts off. `ht-switch:not(:defined)`, `ht-light:not(:defined)`, and `ht-button:not(:defined)` reserve 8rem so nothing jumps.

While a command is in flight the host has `aria-busy="true"`, every action button has `aria-disabled="true"` (focus stays), clicks are ignored, and `feedback` names the control ("Turning on…", "Pressing…"). Pending clears when a frame for the node arrives after the request began, or 2 s after the response. An error stays in `feedback` (`data-tone="bad"`) until the next command. A page script that needs the document listens for `ht:frame` on the host (the string light shows do).

**The Declared Actions Rule.** An element renders exactly the actions its document declares, in the kind's order (`turnOn`, `turnOff`, `toggle`, `getState`; `press`). A button whose action the document lacks is hidden, never disabled; `getState` renders last, not primary, as Refresh.

### Buttons
Outlined ink, square, quiet at rest; the one primary is accent-filled.
- **Shape:** square (0); `--rule-w` ink border; padding .45rem .9rem; min-height 2.5rem; font inherits.
- **Default:** transparent, ink text. Hover/focus fills `ok-soft`; active fills `panel`. Disabled: Ink 2 text, hair border.
- **Toggled** (`aria-pressed="true"` / `data-active`): ink fill, paper text.
- **Primary** (`btn-primary`): accent fill; hover mixes 14% ink into the accent; disabled mixes the accent 45% into the ground.
- **Danger** (`btn-danger`): vermilion/red text and border; hover fills `bad-soft`.
- **Link** (`btn-link`): a button set as a link, used on the status line. **Icon** (`btn-icon`): 2.5rem square, glyph via CSS mask in `currentColor`, labelled for assistive tech; the camera icon bar is the only user.
- **Bar** (`.bar`): `--s2` gaps, `--s4` block margin; the primary sits last.

### Status
- **Mark + Status** (`.mark`, `.status`): a `--mark` square/circle coloured by `data-availability` (online/available, offline/unavailable, degraded/connecting, else unknown; `connecting` pulses) beside its word in Ink 2, vermilion when offline. It is the pre-upgrade child of every `ht-*` element; on pages that have no element yet (camera, speaker, blaster), the page script updates `data-availability` and `.status-text`.
- **Status line** (`.statusline`, camera): the page's one unbroken rule pair, mark + sentence + link buttons; `data-kind` warn/error colours the sentence, `busy` pulses the mark.
- **Problems** (`.problems`): a vermilion-bordered list under the status line; the only bordered box, and only when something is wrong.
- **Feedback** (`.feedback`): a reserved 1.5rem live line under a control; `data-tone` ok/bad colours it. **Live** (`.live`): mark + word for SSE state.
- **Switch gap** (`.switch-gap`): the vermilion words after a group member that lacks a switch control ("no Toggle"), in the group switch page's member list and the group's member states; the feedback line counts them.

### Rows and lists
- **Rows** (`.rows` / `.row`): heavy rule on top, hairline under each row, name over meta, status or actions at the end; a linked row underlines its name on hover/focus with the focus ring inside.
- **Empty** (`.empty`): Ink 2 text between two hairlines; an empty list is a real state. **Key/value** (`.kv`): heavy rule, hairlines, Ink 2 terms, tabular values.
- **Events** (`.event`): .9375rem hairline rows, fine timestamps and facts, bold type name, inline-start rail for warn/error, `ok-soft` flash when new.
- **Capabilities** (`.cap`, camera): label with a .45rem mark at the start, control at the end, hairline under; `cap-danger` in vermilion.

### Inputs / Fields
- **Style:** ground background, ink `--rule-w` border, square, .45rem .6rem padding, 2.5rem min-height (2rem in filters, chips, capability rows); placeholders in Ink 2. **Focus:** the global 2px accent outline, 2px offset. **Disabled:** Ink 2 text, hair border.
- **Field** (`.field`): grid, `--s1` gap, small Ink 2 label first. Native checks, radios, ranges, and colour pickers take `accent-color`.
- **Chip** (`.chip`): an ink-bordered strip of controls with hairline seams, 2.25rem tall, numeric input end-aligned.
- **Toggle** (`.switch`, camera): 2.75 × 1.5rem square track in both themes, ink border, ink fill with a paper thumb when on (a toggled control is ink, like a pressed button; the accent is reserved for action). **Weekdays**: 2rem ink squares, ink-filled when checked.

### Navigation
- **Site nav**: Ink 2 links, no underline; hover underlines in ink; the current page is ink and 600; set in the theme's running-head case.
- **Tabs** (`.tabs`): Ink 2 on a `--rule-w` rule; the current tab is ink with a 2px ink underline overlapping the rule (Controls / Log / Settings). **Filters** (`.filters`): small inline selects with a tabular count pushed to the end.

### Stage and footer
The near-black `.stage` at a page-set aspect ratio (16:9 default, 4:3 on the camera) holds an image, canvas, or SVG at full bleed; its placeholder is `stage-fg` at 70% under a small-caps title; the **live pill** sits at its inline-start top in .75rem tracked capitals on a 70% stage tint with a vermilion dot. The footer is three selects (theme, appearance, language) in one form; a change submits it, the server sets one cookie (`hometruth_ui`) and returns to the same path.

## Live state

One stream per page. The theme's entry installs `ht.state`, a client that opens `GET /api/state/stream?node=device/<id>&node=group/<id>&tier=live|glance` for the nodes the page's elements are bound to, coalescing subscription changes and reopening the one `EventSource` when the set changes. Frames: `hello` (worker generation, tier, node list, keepalive interval), then the snapshot as one `state` frame per node in request order, then one `state` frame per changed node per flush and one `observed` frame (node → `observedAt`) per flush for the polls that changed nothing. `error` carries only `too_many_streams`, and even that is a 200 with a 30 s retry and a close; a recoverable condition is never a non-200. A keepalive comment goes every 20 s; the stream carries at most 200 nodes and a process holds at most 64 streams. A hidden tab closes the stream and a visible one reopens it; a closed source is reopened with 2 s to 30 s backoff.

The seed: `renderPage` embeds `ctx.state.snapshot(nodes)` as `<script type="application/json" id="ht-state">`, so an element paints real state before the stream connects. Seeded records are stale until the stream confirms them.

Tiers and floors: the server observes only nodes some stream retains. A device page asks `live`, a list of rows asks `glance`. Each capability kind has a floor and a model's floor is the max over its kinds; the effective interval is `max(floor, min(tiers))`, measured from the completion of the last read with ±10 % jitter. From `src/state/observer.ts`:

```ts
export const TIER_MS = { live: 5_000, glance: 20_000 } as const;

export const FLOORS_MS: Readonly<Record<CapabilityKind, number>> = {
  binarySwitch: 5_000, light: 5_000, stringLight: 5_000, button: 5_000,
  sensor: 15_000, occupancySensor: 15_000, contactSensor: 15_000, motionSensor: 15_000, hub: 15_000,
  camera: 30_000, treatDispenser: 30_000, speaker: 30_000,
  infraredBlaster: 30_000, radioFrequencyBlaster: 30_000, radioFrequencyReceiver: 30_000, cooktop: 30_000,
};
```

A device that stops answering is read less: the interval doubles per failure to 120 s (300 s for a camera) and resets on success. Every control route re-describes the device, publishes the record, then answers, so the frame lands before the response and the element never flickers.

Faults: a failed read publishes `fault: { code, message }` (`unreachable`, `timeout`, `invalid`, `unconfigured`) and keeps the last good `value` beside it. The element renders **Offline** as the value and the server's sentence as the detail ("Porch relay did not answer at 192.168.1.228 (timed out). If it has moved, use Find on network on its Settings tab."); it still lists the last document's actions, enabled, so a resident can try a command on a device that stopped answering. `unconfigured` renders "No longer configured" and no actions.

Stale: a record the stream has not confirmed (the seed, or every record once the stream drops) shows "Last read {time}" in place of "Read {time}" as its detail. The value is kept and not dressed as current. **The Mark and Word Rule holds under stale**: the mark keeps the last availability and the word beside it stays the last known state; the age is said in the detail line, never by a colour alone.

## Do's and Don'ts

### Do:
- **Do** take every colour from the shell tokens; use `color-mix(in srgb, var(--a) N%, var(--b))` when a tint is needed.
- **Do** open every list, section, and state line with a `--rule-w` rule and separate items with 1px hairlines.
- **Do** pair every status mark with its word, and set both from `data-availability`.
- **Do** put exactly one `btn-primary` on a screen, last in its bar.
- **Do** take every visible string from the catalog (`t("area.name")`), add it to all four locales, and use `{count, plural, ...}` and `Intl` for numbers and dates; pass the prefixes a script needs through `messages`.
- **Do** write logical properties (`margin-block`, `padding-inline-start`, `inset-inline-end`, `text-align: end`).
- **Do** style theme character only through `[data-theme="..."]` overrides on existing elements; put light/dark differences only in tokens.
- **Do** bind a device view with `htElement(ctx, tag, node)`, pass the node to `renderPage`, and let the element subscribe.
- **Do** put theme character for elements in `--ht-*` custom properties, not in `[data-theme]` rules (they do not reach shadow roots).
- **Do** reserve space for feedback (`.feedback` is 1.5rem tall before it says anything), render the page fully before the first fetch, name the action on a control ("Reboot camera", "Save"), and name the problem and the fix in an error.

### Don't:
- **Don't** add cards, or a shadow, radius, or filled block the theme's `rules` do not allow (Euclid and Swiss: none); the `panel` colour is press feedback and `<pre>`, never a container.
- **Don't** poll from a page script; the element's stream is the one source of device state.
- **Don't** write a colour or a string inside an element that is not a token or a catalog key.
- **Don't** put a kicker, eyebrow, or label above an h1, or use tracked capitals as a heading.
- **Don't** load a font, stylesheet, or script from outside the page (the CSP is nonce-only), write a hex or rgb value on a page, or hard-code a radius or shadow; use `--radius`, `--mark-radius`, and `--shadow`.
- **Don't** fill a toggled or selected control with the accent; toggled is ink, the accent is action.
- **Don't** show colour without a word, a guessed value in place of unknown or offline, hard-coded English, dates, or number formats, or a key in `en.ts` without its three translations.
