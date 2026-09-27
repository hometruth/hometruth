import type { SchemaCatalogEntry } from "./schemas";
import type { RegisteredDevice } from "./site";
import { escapeHtml, renderPage, type PageContext } from "./ui/shell";

const SCHEMA_PAGE_CSS = String.raw`
  .schema-id, .description { overflow-wrap: anywhere; color: var(--fg-2); font-size: .875rem; }
  .schema-document { max-height: none; overflow: auto; padding: var(--s4); background: var(--panel); font-size: .8125rem; }
  .schema-instances { list-style: none; padding: 0; display: grid; gap: 0; border-block-start: var(--rule-w) solid var(--rule); }
  .schema-instances li { padding-block: var(--s3); border-block-end: 1px solid var(--hair); }
  .schema-instances .muted { display: block; font-size: .875rem; }
`;

/** One device (or one of its sensors) whose document is described by this schema. */
export interface SchemaInstance {
  readonly device: RegisteredDevice;
  /** Set when the match is a sensor's schema rather than the device's own object schema. */
  readonly sensorName?: string;
}

export function renderSchemaPage({ ctx, entry, instances = [] }: { ctx: PageContext; entry: SchemaCatalogEntry; instances?: readonly SchemaInstance[] }): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: entry.title,
    nav: "schemas",
    wide: true,
    css: SCHEMA_PAGE_CSS,
    body: `<p><a href="/schemas">${escapeHtml(t("schemas.title"))}</a></p>
      <h1 data-schema-page data-schema-id="${escapeHtml(entry.schemaId)}">${escapeHtml(entry.title)}</h1>
      <p class="description">${escapeHtml(entry.description)}</p>
      <p class="schema-id"><code>${escapeHtml(entry.schemaId)}</code> · <code>${escapeHtml(entry.typeName)}</code></p>
      <h2>${escapeHtml(t("schemas.instances"))}</h2>
      ${instances.length ? `<ul class="schema-instances">${instances.map(({ device, sensorName }) => `<li><a href="${escapeHtml(device.page)}">${escapeHtml(sensorName ? `${device.name} · ${sensorName}` : device.name)}</a><span class="muted">${escapeHtml([device.modelTitle, device.room].filter(Boolean).join(" · "))}</span></li>`).join("")}</ul>`
        : `<p class="note">${escapeHtml(t("schemas.noInstances"))}</p>`}
      <pre class="schema-document" data-schema-document>${escapeHtml(JSON.stringify(entry.schema, null, 2))}</pre>`,
    messages: ["schemas."],
  });
}
