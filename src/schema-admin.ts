import { escapeHtml, renderPage, type PageContext } from "./ui/shell";

const SCHEMA_CSS = String.raw`
  .controls { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: end; }
  .controls .field { flex: 1 1 18rem; margin: 0; }
  #schemas { display: grid; gap: 0; border-block-start: var(--rule-w) solid var(--rule); margin-block-start: var(--s4); }
  #schemas article { padding-block: var(--s4); border-block-end: 1px solid var(--hair); }
  .title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3); }
  .title h3 { margin: 0; color: var(--fg); }
  .tag { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-2); }
  .schema-id, .description { overflow-wrap: anywhere; color: var(--fg-2); font-size: .875rem; }
  .properties { display: flex; flex-wrap: wrap; gap: var(--s2); margin-block: var(--s2); }
  pre { max-height: 32rem; overflow: auto; padding: var(--s3); background: var(--panel); font-size: .8125rem; }
`;

const SCHEMA_SCRIPT = String.raw`
  (() => {
    const search = document.querySelector("#search");
    const category = document.querySelector("#category");
    const container = document.querySelector("#schemas");
    const summary = document.querySelector("#summary");
    let catalog = [];
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const selected = category.value;
      const shown = catalog.filter((entry) => {
        const haystack = [entry.title, entry.typeName, entry.description, entry.schemaId, ...Object.keys(entry.schema.properties ?? {})].join(" ").toLowerCase();
        return (selected === "all" || entry.category === selected) && (!query || haystack.includes(query));
      });
      container.replaceChildren();
      summary.textContent = ht.t("schemas.count", { shown: ht.number(shown.length), total: ht.number(catalog.length) });
      if (!shown.length) { container.append(el("p", "empty", ht.t("schemas.none"))); return; }
      for (const entry of shown) {
        const article = el("article"); article.dataset.category = entry.category;
        const title = el("div", "title");
        const heading = el("h3");
        if (entry.page) { const link = document.createElement("a"); link.href = entry.page; link.textContent = entry.title; heading.append(link); }
        else heading.textContent = entry.title;
        title.append(heading, el("code", null, entry.typeName), el("span", "tag", ht.t("schemas." + entry.category)));
        const properties = el("div", "properties");
        for (const property of Object.keys(entry.schema.properties ?? {})) properties.append(el("code", null, property + ((entry.schema.required ?? []).includes(property) ? " *" : "")));
        const details = el("details");
        details.append(el("summary", null, ht.t("schemas.json")), el("pre", null, JSON.stringify(entry.schema, null, 2)));
        article.append(title, el("p", "description", entry.description), el("div", "schema-id", entry.schemaId), properties, details);
        container.append(article);
      }
    };
    search.addEventListener("input", render); category.addEventListener("change", render);
    ht.request("/api/schemas").then((payload) => { catalog = payload.schemas; render(); }).catch(() => { summary.textContent = ht.t("schemas.unavailable"); });
  })();
`;

export function renderSchemaAdminPage({ ctx }: { ctx: PageContext }): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: t("schemas.title"),
    nav: "schemas",
    wide: true,
    css: SCHEMA_CSS,
    body: `<h1>${escapeHtml(t("schemas.title"))}</h1>
      <div class="controls">
        <label class="field"><span>${escapeHtml(t("schemas.search"))}</span><input id="search" type="search" placeholder="${escapeHtml(t("schemas.searchPlaceholder"))}"></label>
        <label class="field"><span>${escapeHtml(t("schemas.category"))}</span><select id="category"><option value="all">${escapeHtml(t("schemas.all"))}</option><option value="business">${escapeHtml(t("schemas.business"))}</option><option value="api">${escapeHtml(t("schemas.api"))}</option><option value="system">${escapeHtml(t("schemas.system"))}</option></select></label>
        <output id="summary" class="muted small" aria-live="polite">${escapeHtml(t("feedback.loading"))}</output>
      </div>
      <section id="schemas"></section>`,
    script: SCHEMA_SCRIPT,
    messages: ["schemas."],
  });
}
