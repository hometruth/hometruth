# Working in this repo

- Follow [AGENTS.md](AGENTS.md), including service management and the public/private documentation boundary. Agents may start, stop and restart development and production services as needed for requested work.
- If you need to query a running server (e.g. via the `ht` CLI or `curl`), check whether one is already up and reuse it when appropriate.

# Web UI rules

- Every page renders through `renderPage()` in `src/ui/shell.ts`: no standalone `<html>` templates, no page-local colours (use the tokens), no cards; shadows and radii only where the theme's `rules` allow them (Euclid and Swiss: none). Three themes (Euclid default, Swiss, Brutal), each light and dark, are selected by `data-theme` / `data-scheme` on `<html>`.
- Browser code lives in `src/ui/browser` (runtime, state client, element base, kinds) and `src/ui/themes/<id>` (the themed elements). It is real TypeScript checked by `bun run typecheck` and served type-stripped from `/ui/<version>/…` by `src/server/ui-modules.ts`. Inside those folders, value imports are relative `.ts` imports within the same two folders; everything else (`src/schemas.ts`, `src/state/protocol.ts`, `src/models/*`) is `import type`. No decorators, enums, namespaces, parameter properties, or `accessor` fields there. No `<style>` tags or `style` attributes: constructed stylesheets only.
- Every live device view is an `ht-*` element bound to a graph node: the server renders it with `htElement(ctx, tag, node)` and passes the node in `renderPage`'s `nodes` so its record is seeded in `#ht-state`. Pages never poll; the element subscribes over the page's one state stream.
- Theme character for elements goes through `--ht-*` custom properties with token fallbacks (set in the theme's tokens); `[data-theme]` rules do not reach shadow roots.
- A theme is a folder under `src/ui/themes/<id>` with `theme.ts` (complete light and dark tokens, shape tokens, `character` CSS, `rules`, `components`, `entry`) plus an `index.ts` browser entry that defines every `ht-*` tag, registered in `src/ui/themes/index.ts`, with `theme.<id>` in all four catalogs.
- Every string the browser sees comes from `src/ui/i18n/en.ts` (server: `ctx.i18n.t(key)`; page scripts: `ht.t(key)` with the page's message prefixes passed to `renderPage`). `de.ts`, `fr.ts`, and `es.ts` are complete typed records of the English catalog, so a new key goes in all four or `bun run typecheck` fails. Dates, numbers, and plurals go through `Intl`.
- Copy is spare and concrete: controls name their action, errors name the problem and the fix, no intros or eyebrows on pages. Device identity, rename, room, and reconnect live on a device's Settings tab.
- Design work here uses the Impeccable skill (`npx impeccable install`); its product context is `PRODUCT.md` and the visual record is `DESIGN.md`.
