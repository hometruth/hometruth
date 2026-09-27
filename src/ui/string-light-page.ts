import type { RegisteredDevice } from "../site";
import { LIGHT_SHOWS_SCRIPT, renderLightShows } from "./string-light-shows";
import { renderLightPage } from "./light-page";
import { escapeHtml, type PageContext } from "./shell";

export function renderStringLightPage({ ctx, device, lights }: { ctx: PageContext; device: RegisteredDevice; lights: readonly RegisteredDevice[] }): string {
  const { t } = ctx.i18n;
  const ordered = [...lights].sort((a, b) => a.parent!.index - b.parent!.index);
  return renderLightPage({
    ctx, device: { ...device, relationships: (device.relationships ?? []).filter(link => link.relation !== "contains") }, capability: "stringLight",
    extraCss: `.scene-preview { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; padding: 0; margin: var(--s3) 0; } .scene-preview li { display: grid; place-items: center; width: 2rem; height: 2rem; border: 1px solid var(--rule); font-variant-numeric: tabular-nums; } [data-govee-presets] { margin: var(--s4) 0; } .light-string { display: flex; list-style: none; overflow-x: auto; padding: var(--s3) 0; margin: var(--s3) 0; } .light-string li { display: flex; align-items: center; flex-shrink: 0; } .light-string li + li::before { content: ''; width: var(--s3); border-top: var(--rule-w) solid var(--rule); } .light-string a { display: grid; place-items: center; min-width: 2.5rem; min-height: 2.5rem; border: var(--rule-w) solid var(--rule); font-variant-numeric: tabular-nums; }`,
    extraScript: LIGHT_SHOWS_SCRIPT,
    afterControls: `${renderLightShows(ctx)}<section data-string-lights>
      <h2>${escapeHtml(t("stringLight.lights"))}</h2>
      <p class="note">${escapeHtml(t("stringLight.order", { count: ordered.length }))}</p>
      <ol class="light-string" aria-label="${escapeHtml(t("stringLight.lights"))}">${ordered.map(light => `<li><a href="${escapeHtml(light.page)}" aria-label="${escapeHtml(light.name)}">${light.parent!.index + 1}</a></li>`).join("")}</ol>
      <div class="rows">${ordered.map(light => `<a class="row" href="${escapeHtml(light.page)}"><span class="row-name">${escapeHtml(light.name)}</span><span class="row-meta">${escapeHtml(t("stringLight.position", { position: light.parent!.index + 1 }))}</span></a>`).join("")}</div>
    </section>`,
  });
}
