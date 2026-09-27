/**
 * The API page: every operation this install serves, and a place to run one.
 *
 * It is rendered from the OpenAPI document the server has already built, in
 * full, before the page is sent — there is no fetch on load and nothing that
 * swaps from a placeholder to the real thing. The script that ships with it
 * only filters what is already on the page and performs the one request a
 * person asks for.
 *
 * Words here divide the way they do on `/schemas`: the page's own chrome comes
 * from the message catalog, and everything said about an operation — its
 * description, its schemas' titles — comes out of the schema documents, in the
 * one language they are written in.
 */
import type { Json, OpenApiDocument } from "../openapi/document";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export const API_CSS = String.raw`
  .api-controls { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: end; margin-block: var(--s4); }
  .api-controls .field { flex: 1 1 16rem; margin: 0; }
  .api-writes { display: inline-flex; align-items: center; gap: var(--s2); color: var(--fg-2); font-size: .875rem; }
  .api-group { margin-block-start: var(--s6); }
  .api-ops { display: grid; gap: 0; border-block-start: var(--rule-w) solid var(--rule); }
  h2 + .api-ops { border-block-start: 0; }
  .op { border-block-end: 1px solid var(--hair); }
  .op[hidden] { display: none; }
  /* The shell's own disclosure marker is the first column; the method is the second. */
  .op > summary { display: grid; grid-template-columns: auto 4.5rem minmax(0, 1fr); gap: var(--s1) var(--s3); align-items: baseline; padding-block: var(--s3); }
  .op-method { font-family: var(--font-mono); font-size: .75rem; letter-spacing: .06em; color: var(--fg-2); }
  .op[data-writes="true"] .op-method { color: var(--warn); }
  .op[data-method="DELETE"] .op-method { color: var(--bad); }
  .op-path { overflow-wrap: anywhere; color: var(--fg); }
  .op-summary { grid-column: 3; color: var(--fg-2); font-size: .875rem; }
  .op-body { padding-block: var(--s2) var(--s5); padding-inline-start: 5.5rem; }
  @media (max-width: 40rem) {
    .op > summary { grid-template-columns: auto minmax(0, 1fr); }
    .op-method, .op-path, .op-summary { grid-column: 2; }
    .op-body { padding-inline-start: 0; }
  }
  .op-body .field { max-width: 34rem; }
  .op-meta { display: flex; flex-wrap: wrap; gap: var(--s2) 0; color: var(--fg-2); font-size: .8125rem; margin-block: var(--s2); }
  .op-meta > span + span::before { content: "\A0\00B7\A0"; }
  .op-body code { color: var(--fg); }
  .op-kind { font-family: var(--font-mono); font-size: .75rem; color: var(--fg-2); }
  .op-out { margin-block-start: var(--s3); }
  .op-out pre { max-height: 24rem; overflow: auto; padding: var(--s3); background: var(--panel); font-size: .8125rem; margin: var(--s2) 0 0; }
  .op-status { font-variant-numeric: tabular-nums; }
  .op-status[data-tone="bad"] { color: var(--bad); }
  .op-status[data-tone="ok"] { color: var(--ok); }
  .api-empty { color: var(--fg-2); padding-block: var(--s4); }
`;

export const API_SCRIPT = String.raw`
  (() => {
    const search = document.querySelector("#api-search");
    const group = document.querySelector("#api-group");
    const summary = document.querySelector("#api-count");
    const writes = document.querySelector("#api-writes");
    const empty = document.querySelector("#api-empty");
    const operations = [...document.querySelectorAll(".op")];

    const filter = () => {
      const query = search.value.trim().toLowerCase();
      const chosen = group.value;
      let shown = 0;
      for (const operation of operations) {
        const visible = (chosen === "all" || operation.dataset.group === chosen)
          && (!query || operation.dataset.haystack.includes(query));
        operation.hidden = !visible;
        if (visible) shown += 1;
      }
      for (const section of document.querySelectorAll(".api-group")) {
        section.hidden = ![...section.querySelectorAll(".op")].some((operation) => !operation.hidden);
      }
      summary.textContent = ht.t("api.count", { shown: ht.number(shown), total: ht.number(operations.length) });
      empty.hidden = shown > 0;
    };
    ht.pageState.bind(search, 'rest-search', filter);
    ht.pageState.bind(group, 'rest-group', filter);

    const allowWrites = () => {
      for (const button of document.querySelectorAll("button[data-writes='true']")) button.disabled = !writes.checked;
    };
    writes.addEventListener("change", allowWrites);
    allowWrites();

    const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

    document.addEventListener("submit", async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains("op-form")) return;
      event.preventDefault();
      const operation = form.closest(".op");
      const out = operation.querySelector(".op-out");
      const status = operation.querySelector(".op-status");
      const output = operation.querySelector(".op-out pre");
      const button = form.querySelector("button[type=submit]");
      let path = operation.dataset.path;
      for (const input of form.querySelectorAll("[data-param]")) {
        path = path.split("{" + input.dataset.param + "}").join(encodeURIComponent(input.value));
      }
      const query = new URLSearchParams();
      for (const input of form.querySelectorAll("[data-query]")) {
        if (input.value.trim()) query.set(input.dataset.query, input.value.trim());
      }
      const method = operation.dataset.method;
      const body = form.querySelector("textarea[name=body]");
      const url = path + (query.size ? "?" + query.toString() : "");
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = ht.t("api.sending");
      const started = performance.now();
      try {
        const response = await fetch(url, {
          method,
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(30000),
          headers: method === "GET" ? {} : { "content-type": operation.dataset.consumes || "application/json" },
          ...(method === "GET" || !body || !body.value.trim() ? {} : { body: body.value }),
        });
        const elapsed = Math.round(performance.now() - started);
        const type = response.headers.get("content-type") || "";
        status.textContent = ht.t("api.status", { status: response.status, statusText: response.statusText || "", ms: ht.number(elapsed) });
        status.dataset.tone = response.ok ? "ok" : "bad";
        if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("multipart/") || type.includes("event-stream")) {
          output.textContent = ht.t("api.binary", { media: type.split(";")[0] });
          await response.body?.cancel();
        } else {
          output.textContent = pretty(await response.text());
        }
        out.hidden = false;
      } catch (error) {
        status.textContent = ht.t("api.failed");
        status.dataset.tone = "bad";
        output.textContent = error instanceof Error ? error.message : String(error);
        out.hidden = false;
      } finally {
        button.disabled = false;
        button.textContent = previous;
        allowWrites();
      }
    });

    filter();
  })();
`;

type Schema = Record<string, Json>;

const isObject = (value: Json | undefined): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An OpenAPI description is Markdown, and the only Markdown the generated ones
 * use is a backtick span. Everything is escaped first, so the spans are the one
 * thing here that becomes an element.
 */
function prose(text: string): string {
  return escapeHtml(text).replaceAll(/`([^`]+)`/gu, "<code>$1</code>");
}

/** Follow a `#/components/schemas/…` reference back to the document that defines it. */
function resolve(schema: Schema, document: OpenApiDocument, seen: ReadonlySet<string> = new Set()): { schema: Schema; seen: ReadonlySet<string> } {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) return { schema, seen };
  const name = reference.slice("#/components/schemas/".length);
  if (seen.has(name)) return { schema: {}, seen };
  const schemas = document.components.schemas;
  const target = isObject(schemas) ? schemas[name] : undefined;
  return isObject(target) ? { schema: target, seen: new Set([...seen, name]) } : { schema: {}, seen };
}

/**
 * A body worth starting from: the schema's own example when it has one, and
 * otherwise the smallest value the schema would accept. It is a starting
 * point, not a promise — the server validates what is actually sent.
 */
function sample(input: Schema, document: OpenApiDocument, seen: ReadonlySet<string> = new Set(), depth = 0): Json {
  const { schema, seen: visited } = resolve(input, document, seen);
  if (depth > 5) return null;
  const examples = schema.examples;
  if (Array.isArray(examples) && examples.length) return examples[0]!;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]!;

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length && isObject(branches[0])) {
      return sample(branches[0], document, visited, depth + 1);
    }
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array") {
    const items = schema.items;
    return isObject(items) ? [sample(items, document, visited, depth + 1)] : [];
  }
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (type === "string") return schema.format === "date-time" ? new Date(0).toISOString() : "";
  if (type !== "object" && !isObject(schema.properties)) return null;

  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const wanted = required.length ? required : Object.keys(properties).slice(0, 3);
  const body: Record<string, Json> = {};
  for (const name of wanted) {
    const property = properties[name];
    body[name] = isObject(property) ? sample(property, document, visited, depth + 1) : null;
  }
  return body;
}

/** The catalog schema a body names, when it names one, so the page can link to it. */
function schemaLink(content: Json | undefined, document: OpenApiDocument): { title: string; page?: string } | undefined {
  if (!isObject(content)) return undefined;
  const media = isObject(content.content) ? content.content : undefined;
  const entry = media ? Object.values(media).find(isObject) : undefined;
  const schema = entry && isObject(entry.schema) ? entry.schema : undefined;
  if (!schema) return undefined;
  const reference = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (!reference?.startsWith("#/components/schemas/")) {
    return typeof schema.title === "string" ? { title: schema.title } : undefined;
  }
  const name = reference.slice("#/components/schemas/".length);
  const schemas = isObject(document.components.schemas) ? document.components.schemas : {};
  const target = schemas[name];
  const page = isObject(target) && typeof target["x-hometruth-page"] === "string" ? target["x-hometruth-page"] : undefined;
  const title = isObject(target) && typeof target.title === "string" ? target.title : name;
  return { title, ...(page ? { page } : {}) };
}

function link(entry: { title: string; page?: string } | undefined): string {
  if (!entry) return "";
  return entry.page
    ? `<a href="${escapeHtml(entry.page)}">${escapeHtml(entry.title)}</a>`
    : escapeHtml(entry.title);
}

interface RenderedOperation {
  readonly method: string;
  readonly path: string;
  readonly group: string;
  readonly html: string;
  readonly haystack: string;
}

function renderOperation(ctx: PageContext, path: string, method: string, operation: Schema, document: OpenApiDocument): RenderedOperation {
  const { t } = ctx.i18n;
  const writes = method !== "GET";
  const parameters = Array.isArray(operation.parameters) ? operation.parameters.filter(isObject) : [];
  const summary = typeof operation.summary === "string" ? operation.summary : path;
  const description = typeof operation.description === "string" ? operation.description : "";
  const group = Array.isArray(operation.tags) && typeof operation.tags[0] === "string" ? operation.tags[0] : "API";
  const requestBody = isObject(operation.requestBody) ? operation.requestBody : undefined;
  const consumes = requestBody && isObject(requestBody.content) ? Object.keys(requestBody.content)[0] : undefined;
  const responses = isObject(operation.responses) ? operation.responses : {};
  const success = Object.entries(responses).find(([status]) => status.startsWith("2"))?.[1];

  const field = (parameter: Schema): string => {
    const name = typeof parameter.name === "string" ? parameter.name : "";
    const where = parameter.in === "query" ? "query" : "param";
    const schema = isObject(parameter.schema) ? parameter.schema : {};
    const labels = isObject(parameter["x-hometruth-labels"]) ? parameter["x-hometruth-labels"] : {};
    const options = Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === "string") : [];
    const attributes = `data-${where}="${escapeHtml(name)}" name="${escapeHtml(`${where}:${name}`)}"`;
    const label = `<span>${escapeHtml(name)} <span class="op-kind">${escapeHtml(t(parameter.in === "query" ? "api.inQuery" : "api.inPath"))}</span></span>`;
    if (options.length) {
      const choices = options.map((value) => {
        const shown = typeof labels[value] === "string" && labels[value] !== value ? `${labels[value]} · ${value}` : value;
        return `<option value="${escapeHtml(value)}">${escapeHtml(shown)}</option>`;
      }).join("");
      const blank = parameter.in === "query" && !parameter.required ? `<option value=""></option>` : "";
      return `<label class="field">${label}<select ${attributes}>${blank}${choices}</select></label>`;
    }
    return `<label class="field">${label}<input type="text" ${attributes} value=""></label>`;
  };

  const bodyField = requestBody && consumes === "application/json"
    ? (() => {
      const content = isObject(requestBody.content) ? requestBody.content : {};
      const entry = isObject(content["application/json"]) ? content["application/json"] : {};
      const schema = isObject(entry.schema) ? entry.schema : {};
      const skeleton = JSON.stringify(sample(schema, document), null, 2);
      return `<label class="field"><span>${escapeHtml(t("api.body"))}</span><textarea name="body" rows="${Math.min(14, skeleton.split("\n").length + 1)}" spellcheck="false">${escapeHtml(skeleton)}</textarea></label>`;
    })()
    : requestBody
      ? `<label class="field"><span>${escapeHtml(t("api.body"))} <span class="op-kind">${escapeHtml(consumes ?? "")}</span></span><textarea name="body" rows="4" spellcheck="false"></textarea></label>`
      : "";

  const permission = typeof operation["x-hometruth-permission"] === "string" ? operation["x-hometruth-permission"] : undefined;
  const meta = [
    permission ? escapeHtml(t("api.permission", { permission })) : escapeHtml(t("api.public")),
    requestBody ? `${escapeHtml(t("api.requestSchema"))} ${link(schemaLink(requestBody, document))}` : "",
    success ? `${escapeHtml(t("api.responseSchema"))} ${link(schemaLink(success, document))}` : "",
    operation["x-hometruth-unspecified"] === true ? escapeHtml(t("api.unspecified")) : "",
  ].filter(Boolean).map(entry => `<span>${entry}</span>`).join("");

  const html = `<details class="op" data-page-disclosure="${escapeHtml(`${method} ${path}`)}" data-method="${escapeHtml(method)}" data-path="${escapeHtml(path)}" data-group="${escapeHtml(group)}" data-writes="${writes}"${consumes && consumes !== "application/json" ? ` data-consumes="${escapeHtml(consumes)}"` : ""} data-haystack="${escapeHtml(`${method} ${path} ${summary} ${description}`.toLowerCase())}">
      <summary><span class="op-method">${escapeHtml(method)}</span><code class="op-path">${escapeHtml(path)}</code><span class="op-summary">${escapeHtml(summary)}</span></summary>
      <div class="op-body">
        ${description ? `<p class="note">${prose(description)}</p>` : ""}
        <div class="op-meta">${meta}</div>
        <details data-page-disclosure="${escapeHtml(`schema:${method} ${path}`)}"><summary>Request and response schemas</summary><pre>${escapeHtml(JSON.stringify({ request: requestBody ?? null, responses }, null, 2))}</pre></details>
        <form class="op-form">
          ${parameters.map(field).join("")}
          ${bodyField}
          <div class="bar">
            <button type="submit" class="btn btn-primary" data-writes="${writes}">${escapeHtml(t("api.send"))}</button>
            <output class="op-status" aria-live="polite"></output>
          </div>
        </form>
        <div class="op-out" hidden><pre></pre></div>
      </div>
    </details>`;

  return { method, path, group, html, haystack: `${method} ${path} ${summary}`.toLowerCase() };
}

export function renderApiPlayground(ctx: PageContext, document: OpenApiDocument, documentPath = "/api/openapi.json"): string {
  const { t } = ctx.i18n;
  const operations: RenderedOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isObject(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (isObject(operation)) operations.push(renderOperation(ctx, path, method.toUpperCase(), operation, document));
    }
  }

  const groups = [...new Set(operations.map(operation => operation.group))].sort();
  const sections = groups.map(group => `<section class="api-group"><h2>${escapeHtml(group)}</h2><div class="api-ops">${
    operations.filter(operation => operation.group === group).map(operation => operation.html).join("")
  }</div></section>`).join("");

  const info = document.info;
  const server = document.servers[0]?.url;

  return `<h2>${escapeHtml(t("api.title"))}</h2>
      <p class="note">${prose(typeof info.description === "string" ? info.description.split("\n\n")[0]! : "")}</p>
      <p class="note">${escapeHtml(t("api.server"))} <code>${escapeHtml(typeof server === "string" ? server : "")}</code> · <a href="${escapeHtml(documentPath)}">${escapeHtml(t("api.document"))}</a></p>
      <div class="api-controls">
        <label class="field"><span>${escapeHtml(t("api.search"))}</span><input id="api-search" type="search" placeholder="${escapeHtml(t("api.searchPlaceholder"))}"></label>
        <label class="field"><span>${escapeHtml(t("api.group"))}</span><select id="api-group"><option value="all">${escapeHtml(t("api.allGroups"))}</option>${
          groups.map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")
        }</select></label>
        <label class="api-writes"><input type="checkbox" id="api-writes">${escapeHtml(t("api.allowWrites"))}</label>
        <output id="api-count" class="muted small" aria-live="polite">${escapeHtml(t("api.count", { shown: ctx.i18n.number(operations.length), total: ctx.i18n.number(operations.length) }))}</output>
      </div>
      <p class="note">${escapeHtml(t("api.allowWritesHint"))}</p>
      ${sections}
      <p class="api-empty" id="api-empty" hidden>${escapeHtml(t("api.none"))}</p>`;
}

export function renderApiPage({ ctx, document }: { ctx: PageContext; document: OpenApiDocument }): string {
  return renderPage({ ctx, title: ctx.i18n.t("api.title"), nav: "api", wide: true,
    css: API_CSS, body: renderApiPlayground(ctx, document), script: API_SCRIPT, messages: ["api."] });
}
