/**
 * Architectural shell and dashboard vocabulary. Append after the shell's other
 * CSS: this is a site-wide visual layer, not a selectable component entry.
 * Fonts are local system faces; the theme needs no remote font or image request.
 */
export const WRIGHT_THEME_CSS = String.raw`
  :root:root {
    --font-body: "Avenir Next", Avenir, "Segoe UI", Helvetica, Arial, sans-serif;
    --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    --text: 16px;
    --page: 64rem; --page-wide: 92rem; --measure: 68ch;
    --rule-w: 1px; --mark-radius: 0; --radius: 16px; --shadow: none;
    --bg: #f3ead8; --panel: #e6dfca; --fg: #254b47; --fg-2: #5f6b5d;
    --rule: #a4b2a1; --hair: #d8d8bf;
    --accent: #176a66; --accent-fg: #fff8e9;
    --ok: #365e43; --warn: #77581e; --warn-mark: #927030; --bad: #9a382c;
    --ok-soft: #e3e9dc; --bad-soft: #f2e0d7; --warn-soft: #eee4c9;
    --stage: #fbc579; --stage-fg: #254b47; --live: color-mix(in srgb, var(--fg) 80%, var(--accent));
    --ht-paper: #fff9eb; --ht-forest: #174f4b; --ht-forest-ink: #f7efd9;
    --ht-forest-muted: #c0d7c4; --ht-forest-rule: #49796d;
    --ht-brass: #93653c; --ht-brass-soft: #e0bf77; --ht-red: #176a66;
    --ht-focus: #176a66; --ht-sidebar: 15.5rem; --ht-gutter: clamp(1rem, 3vw, 3rem);
    --ht-switch-value-size: 1.75rem; --ht-switch-value-weight: 500; --ht-switch-value-tracking: -.025em;
    color-scheme: light;
  }
  :root:root[data-scheme="dark"] {
    --bg: #152e2b; --panel: #23433c; --fg: #ede7d8; --fg-2: #bdbdad;
    --rule: #78816b; --hair: #465344;
    --accent: #e4a38a; --accent-fg: #261f18;
    --ok: #b2c89c; --warn: #dfc080; --warn-mark: #d0ac61; --bad: #efa28c;
    --ok-soft: #304333; --bad-soft: #49332c; --warn-soft: #443e29;
    --stage: #27352c; --stage-fg: #ede7d8; --live: color-mix(in srgb, var(--fg) 80%, var(--accent));
    --ht-paper: #1e3b35; --ht-brass: #c9b679; --ht-red: #e4a38a; --ht-focus: #e4c17b;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:root[data-scheme="auto"] {
      --bg: #152e2b; --panel: #23433c; --fg: #ede7d8; --fg-2: #bdbdad;
      --rule: #78816b; --hair: #465344;
      --accent: #e4a38a; --accent-fg: #261f18;
      --ok: #b2c89c; --warn: #dfc080; --warn-mark: #d0ac61; --bad: #efa28c;
      --ok-soft: #304333; --bad-soft: #49332c; --warn-soft: #443e29;
      --stage: #27352c; --stage-fg: #ede7d8; --live: color-mix(in srgb, var(--fg) 80%, var(--accent));
      --ht-paper: #1e3b35; --ht-brass: #c9b679; --ht-red: #e4a38a; --ht-focus: #e4c17b;
      color-scheme: dark;
    }
  }

  html { font: var(--text)/1.55 var(--font-body); background: var(--bg); color: var(--fg); }
  body { -webkit-font-smoothing: antialiased; }
  :focus-visible { outline: 2px solid var(--ht-focus); outline-offset: 4px; }
  :root a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: .2em; }
  :root a:hover { background: transparent; color: var(--accent); text-decoration-thickness: 2px; }
  :root h1, :root h2, :root h3 {
    font-family: var(--font-display); font-variant-caps: normal; font-weight: 400;
    text-transform: none; letter-spacing: -.025em; color: var(--fg);
  }
  :root h1 { font-size: clamp(2rem, 3.4vw, 3.25rem); line-height: 1.08; margin-block: 2rem 1.5rem; }
  :root h2 { font-size: 1.5rem; line-height: 1.2; padding-block-end: .7rem; border-block-end: 1px solid var(--hair); }
  :root h3 { font-size: 1.25rem; line-height: 1.3; }
  :root legend { font-family: var(--font-body); font-size: .875rem; font-weight: 600; font-variant-caps: normal; letter-spacing: 0; text-transform: none; }
  :root main { width: min(var(--page), calc(100% - var(--ht-gutter) * 2)); padding-block: .75rem 4rem; min-width: 0; }
  :root main[data-wide] { width: min(var(--page-wide), calc(100% - var(--ht-gutter) * 2)); }
  :root .page-head { padding-block-end: .5rem; border-block-end: 1px solid var(--hair); margin-block-end: 1.5rem; }
  :root .page-head h1 { margin-block-end: 1rem; }
  :root .muted, :root .note { color: var(--fg-2); }

  /* A dark timber spine. The little leaded-glass mark uses rules, not an asset. */
  :root body.site-layout { padding-inline-start: var(--ht-sidebar); }
  :root .site-sidebar {
    width: var(--ht-sidebar); padding: 2rem 1rem 1rem;
    background: var(--ht-forest); color: var(--ht-forest-ink); border-inline-end: 1px solid var(--ht-forest-rule);
    scrollbar-color: var(--ht-forest-rule) var(--ht-forest);
  }
  :root .site-sidebar .brand {
    position: relative; display: block; padding: 0 .75rem 1.5rem 3.25rem; margin-block-end: 1rem;
    border-block-end: 1px solid var(--ht-forest-rule); color: var(--ht-forest-ink);
    font-family: var(--font-display); font-size: 1.5rem; font-weight: 400;
    font-variant-caps: normal; letter-spacing: -.035em; text-transform: none; line-height: 1.2;
  }
  :root .site-sidebar .brand::before {
    content: ""; position: absolute; inset-inline-start: .75rem; inset-block-start: .1rem;
    width: 1.55rem; height: 1.55rem; border: 1px solid var(--ht-brass-soft);
    border-radius:50%; background:linear-gradient(0deg,transparent 48%,var(--ht-brass-soft) 49% 54%,transparent 55%);
  }
  :root .site-nav { gap: .125rem; font-family: var(--font-body); font-size: .8125rem; font-variant-caps: normal; letter-spacing: .015em; text-transform: none; }
  :root .site-nav a {
    min-height: 2.65rem; display: flex; align-items: center; padding: .55rem .8rem;
    border-inline-start: 2px solid transparent; color: var(--ht-forest-muted); line-height: 1.3;
    font-weight: 400; text-decoration: none; transition: background var(--motion), color var(--motion);
  }
  :root .site-nav a:hover, :root .site-nav a:focus-visible { background: #286259; color: var(--ht-forest-ink); text-decoration: none; }
  :root .site-nav a[aria-current="page"] { background: #397366; color: var(--ht-forest-ink); border-inline-start-color: var(--ht-brass-soft); font-weight: 600; }
  :root .site-sidebar :focus-visible { outline-color: var(--ht-brass-soft); outline-offset: -3px; }
  :root .health-investigation-nav { border-color: var(--ht-forest-rule); }
  :root .health-investigation-nav a { display: block; font-size: .8rem; }
  :root .health-investigation-nav small { color: var(--ht-forest-muted); }
  :root .site-sidebar .site-foot { border-color: var(--ht-forest-rule); color: var(--ht-forest-muted); padding: 1.25rem .75rem .5rem; margin-block-start: 1.5rem; }
  :root .site-sidebar .site-foot form { gap: .875rem; }
  :root .site-sidebar .site-foot label { gap: .3rem; font-size: .6875rem; letter-spacing: .08em; text-transform: uppercase; }
  :root .site-sidebar .site-foot select {
    min-height: 2.25rem; background: var(--ht-forest); color: var(--ht-forest-ink); border-color: var(--ht-forest-rule);
    font-size: .8125rem; letter-spacing: 0; text-transform: none; padding: .35rem .5rem;
  }
  :root .site-foot { border-color: var(--hair); font-size: .8125rem; }

  /* Keep the vocabulary readable inside the adopted custom-element sheet too. */
  .btn, :root .btn {
    font-family: var(--font-body); font-size: .8125rem; font-weight: 600; font-variant-caps: normal;
    letter-spacing: .025em; text-transform: none; line-height: 1.35; text-decoration: none;
    min-height: 2.75rem; padding: .65rem 1rem; border: 1px solid var(--rule); border-radius: 2px;
    background: var(--ht-paper); color: var(--fg); box-shadow: none; transform: none;
  }
  .btn:hover:not(:disabled), .btn:focus-visible, :root .btn:hover:not(:disabled), :root .btn:focus-visible {
    background: var(--panel); color: var(--fg); border-color: var(--fg-2); text-decoration: none;
  }
  .btn:active:not(:disabled), :root .btn:active:not(:disabled) { background: var(--panel); box-shadow: none; transform: none; }
  .btn-primary, :root .btn-primary { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
  .btn-primary:hover:not(:disabled), .btn-primary:focus-visible, :root .btn-primary:hover:not(:disabled), :root .btn-primary:focus-visible {
    background: color-mix(in srgb, var(--accent) 86%, var(--fg)); color: var(--accent-fg); border-color: var(--accent);
  }
  .btn-small, :root .btn-small { min-height: 2.25rem; padding: .4rem .7rem; font-size: .75rem; }
  .btn-icon, :root .btn-icon { width: 2.75rem; padding: 0; font-size: 0; }
  .btn-danger, :root .btn-danger { color: var(--bad); border-color: var(--bad); }
  .btn-danger:hover:not(:disabled), :root .btn-danger:hover:not(:disabled) { color: var(--bad); background: var(--bad-soft); border-color: var(--bad); }
  .btn[aria-pressed="true"], .btn[data-active="true"], .btn[data-state="active"],
  :root .btn[aria-pressed="true"], :root .btn[data-active="true"], :root .btn[data-state="active"] {
    background: var(--fg); border-color: var(--fg); color: var(--bg);
  }
  .btn:is([aria-pressed="true"], [data-active="true"], [data-state="active"]):is(:hover, :focus-visible):where(:not(:disabled):not([aria-disabled="true"])),
  :root .btn:is([aria-pressed="true"], [data-active="true"], [data-state="active"]):is(:hover, :focus-visible):where(:not(:disabled):not([aria-disabled="true"])) {
    background: var(--fg); border-color: var(--fg); color: var(--bg);
  }
  .btn[data-state="inactive"], :root .btn[data-state="inactive"] { background: var(--ht-paper); color: var(--fg); }
  .btn[data-state="unknown"], .btn[data-state="checking"], :root .btn[data-state="unknown"], :root .btn[data-state="checking"] { color: var(--fg-2); border-style: dashed; }
  .btn[data-state="updating"], :root .btn[data-state="updating"] { background: var(--panel); color: var(--fg-2); }
  .btn[data-state="failure"], :root .btn[data-state="failure"] { color: var(--bad); border-color: var(--bad); }
  .btn[data-state="failure"]:is(:hover, :focus-visible), :root .btn[data-state="failure"]:is(:hover, :focus-visible) { color: var(--bad); border-color: var(--bad); background: var(--bad-soft); }
  .btn:disabled, .btn[aria-disabled="true"], :root .btn:disabled, :root .btn[aria-disabled="true"] {
    color: var(--fg-2); border-color: var(--hair); background: var(--panel); box-shadow: none; cursor: not-allowed;
  }
  input, select, textarea, :root input, :root select, :root textarea {
    font-family: var(--font-body); border-radius: 2px; box-shadow: none; background: var(--ht-paper); border-color: var(--rule);
  }
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):focus-visible,
  select:focus-visible, textarea:focus-visible { border-color: var(--ht-focus); }
  input[type="range"], :root input[type="range"] { background: transparent; }
  [aria-invalid="true"], :root [aria-invalid="true"] { border-color: var(--bad); }
  :root .field { gap: .4rem; }
  :root .field > span:first-child, :root .field > label:first-child { font-size: .8125rem; color: var(--fg-2); }
  :root .chip { border-radius: 2px; box-shadow: none; }
  :root .chip > * + * { border-inline-start: 1px solid var(--hair); }
  :root .state { padding-block: 1.25rem; border-color: var(--hair); }
  .state-value, :root .state-value { font-family: var(--font-display); font-size: 2rem; font-weight: 400; text-transform: none; letter-spacing: -.03em; }
  :root .row { padding: 1rem .25rem; border-color: var(--hair); border-width: 1px; transition: background var(--motion); }
  :root a.row { color: var(--fg); }
  :root a.row:hover, :root a.row:focus-visible { background: var(--panel); color: var(--fg); }
  :root .row-name { font-size: 1rem; font-weight: 500; }
  :root .row-meta, :root .row-side { font-size: .8125rem; }
  :root .rows, :root .kv { border-block-start: 1px solid var(--rule); }
  :root .kv > dt, :root .kv > dd { border-color: var(--hair); border-width: 1px; padding-block: .75rem; font-size: .875rem; }
  :root .table { font-size: .875rem; }
  :root .table thead th { color: var(--fg-2); font-size: .6875rem; letter-spacing: .07em; text-transform: uppercase; font-weight: 600; }
  :root .table th, :root .table td { padding-block: .875rem; border-color: var(--hair); border-bottom-width: 1px; }
  :root .table tbody tr:hover { background: color-mix(in srgb, var(--panel) 60%, transparent); }
  :root .empty, :root .graph-empty {
    padding: 2rem 1.5rem; border: 1px solid var(--hair); border-inline-start: 3px solid var(--ht-brass);
    background: var(--ht-paper); color: var(--fg-2); font-size: .9375rem; line-height: 1.7;
  }
  :root .tabs, :root .graph-tabs { gap: 1.5rem; overflow-x: auto; border-color: var(--hair); scrollbar-width: thin; }
  :root .tabs a, :root .tabs button, :root .graph-tabs a {
    flex: none; padding-block: .8rem; min-height: 2.75rem; color: var(--fg-2); font-size: .8125rem;
    font-weight: 500; letter-spacing: .02em; border-block-end-width: 2px; text-decoration: none;
  }
  :root .tabs a[aria-current="page"], :root .tabs button[aria-selected="true"], :root .graph-tabs a[aria-current="page"] { color: var(--accent); border-block-end-color: var(--accent); }
  :root .events { border-block-start-color: var(--rule); }
  :root .event { padding-block: 1rem; border-color: var(--hair); border-width: 1px; }
  :root .event-type { font-weight: 500; }
  :root .event-at { font-size: .75rem; }
  :root .problems { background: var(--bad-soft); border-inline-start-width: 3px; }
  :root .subject-menu, :root #ht-live-tip { background: var(--ht-paper); border-color: var(--rule); box-shadow: 0 8px 24px #18251c18; }

  :root .graph-eyebrow, :root .graph-kind {
    display: block; margin: 0; font-family: var(--font-body); font-size: .6875rem;
    line-height: 1.5; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; color: var(--fg-2);
  }
  :root .switch-tiles .switch-row:has(ht-switch-row[data-phase=on]) :is(.row-meta,[data-live]) { color:#52634d; }
  :root .switch-tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(11rem,1fr)); gap:.8rem; border:0; }
  :root .switch-tiles .switch-row { display:flex; flex-direction:column; align-items:stretch; padding:1rem; min-height:10rem; gap:.6rem; background:var(--ht-paper); border:1px solid var(--hair); border-radius:18px; }
  :root .switch-tiles .switch-row:has(ht-switch-row[data-phase=on]) { background:#fff7df; color:#294d43; }
  :root .switch-tiles .row-name { font-weight:600; font-size:.88rem; }
  :root .switch-tiles .row-name a { color:inherit; text-decoration:none; }
  :root .switch-tiles .row-meta { font-size:.68rem; }
  :root .switch-tiles .row-actions { margin-top:auto; width:100%; display:flex; justify-content:space-between; align-items:center; }
  :root .switch-tiles .row-actions>a { padding:.3rem .55rem; min-height:0; border:0; background:none; font-size:.65rem; }
  /* Graph diagrams and their list counterpart share the dashboard materials. */
  :root .graph-summary { border-color: var(--rule); padding-block: 1rem; }
  :root .graph-room-head { border-color: var(--hair); padding-block-end: .5rem; }
  :root .graph-room h2 { border: 0; margin: 0; padding: 0; font-size: 1.5rem; }
  :root .graph-card { min-height: 9.5rem; padding: 1.25rem; background: var(--ht-paper); border-color: var(--hair); color: var(--fg); }
  :root .graph-card strong { font-family: var(--font-display); font-size: 1.375rem; font-weight: 400; letter-spacing: -.02em; }
  :root .graph-card:hover { background: var(--panel); color: var(--fg); border-color: var(--rule); text-decoration: none; }
  :root .graph-card[aria-current="true"] { border-color: var(--accent); outline-color: var(--accent); }
  :root .graph-context, :root .graph-status, :root .graph-relation { font-size: .75rem; }
  :root .graph-inspector { padding: 1.25rem; background: var(--ht-paper); border: 1px solid var(--hair); border-block-start: 3px solid var(--ht-brass); }
  :root .graph-inspector h2 { border: 0; padding: 0; font-size: 1.75rem; }
  :root .graph-inspector h3 { font-family: var(--font-body); font-size: .8125rem; font-weight: 600; letter-spacing: 0; }
  :root .graph-viewport { background: var(--ht-paper); border: 1px solid var(--hair); }
  :root .graph-node-box { fill: var(--ht-paper); stroke: var(--rule); }
  :root .graph-node-name { font-family: var(--font-body); font-size: 16px; }
  :root .graph-node-kind, :root .graph-node-status { font-family: var(--font-body); font-size: 12px; }
  :root .graph-node[data-availability="offline"] .graph-node-status { fill: var(--bad); }
  :root .graph-edge { stroke: var(--rule); opacity: .85; }
  :root .graph-connection[data-related="true"] .graph-edge { stroke: var(--accent); opacity: 1; }

  @media (max-width: 50rem) {
    :root body.site-layout { padding-inline-start: 0; padding-block-start: 4.5rem; }
    :root .site-menu-toggle {
      display: block; inset-block-start: .75rem; inset-inline-start: 1rem; min-height: 2.75rem;
      background: var(--ht-forest); color: var(--ht-forest-ink); border-color: var(--ht-forest-rule); box-shadow: 0 2px 8px #18251c18;
    }
    :root .site-menu-toggle:hover, :root .site-menu-toggle:focus-visible { background: #286259; color: var(--ht-forest-ink); }
    :root .site-sidebar { width: min(19rem, calc(100% - 2.5rem)); padding-block-start: 4.75rem; box-shadow: 8px 0 32px #18251c30; }
    :root main, :root main[data-wide] { width: calc(100% - 2rem); padding-block-start: .25rem; }
    :root .tabs, :root .graph-tabs { gap: 1.25rem; }
    :root .graph-inspector { position: static; max-height: none; }
  }
  @media (max-width: 40rem) {
    :root .table th, :root .table td { padding-block: .4rem; }
    :root .table tbody tr { padding-block: .875rem; border-color: var(--hair); }
    :root .table tbody td { border: 0; }
    :root .table tbody th { font-family: var(--font-display); font-size: 1.125rem; font-weight: 400; border: 0; }
    :root .table tbody td::before { font-size: .8125rem; }
  }
  @media (forced-colors: active) {
    :root .site-nav a[aria-current="page"] { border-inline-start-color: Highlight; }
    :root .site-sidebar .brand::before { display: none; }
  }
`;
