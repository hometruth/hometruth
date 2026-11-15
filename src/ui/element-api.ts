import { skillMarkdown, type ElementApi } from "../element-api/contract";
import { escapeHtml, type PageContext } from "./shell";
import { clientExamples } from "../client/methods";
import { commandUsage, shellWord } from "../ht/commands";
import { API_CSS, API_SCRIPT, renderApiPlayground } from "./api-page";
import { API_TABS, activeApiTab, pageStateHref } from "./page-state";

export const ELEMENT_API_CSS = `${API_CSS}
  .element-tabs { flex-wrap:wrap; gap:0 var(--s4); }
  [data-element-page-panel][hidden], .element-api[hidden] { display:none; }
  .element-api { margin-block:var(--s4); }
  .element-api select { width:100%; min-width:0; max-width:100%; }
  .element-api h3, .element-api code { overflow-wrap:anywhere; }
  .element-api [hidden] { display:none; }
  .element-api pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--panel); padding:var(--s3); max-height:32rem; overflow:auto; }
  .element-api textarea { width:100%; font: .875rem/1.6 var(--font-mono); min-height:14rem; }
  .element-api table { width:100%; border-collapse:collapse; font-size:.875rem; }
  .element-api td, .element-api th { text-align:start; vertical-align:top; border-bottom:1px solid var(--hair); padding:var(--s2); overflow-wrap:anywhere; }
  .element-api .property-type { max-width:28rem; }
  .element-api .api-table { overflow:auto; }
  .element-api .api-command { border-bottom:1px solid var(--hair); padding-block:var(--s3); }
  .element-api iframe { display:none; }
`;
const copyBlock = (value: string, prompt?: "mcp" | "skill") => `<div data-copy-block${prompt ? ` data-install-prompt="${prompt}"` : ""}><button type="button" class="btn" data-copy>${prompt ? "Copy installation request" : "Copy"}</button><pre><code>${escapeHtml(value)}</code></pre></div>`;

const panels = new WeakMap<ElementApi, Map<string, string>>();
const PANEL_NONCE = "__HOMETRUTH_PANEL_NONCE__";

export function renderElementApiTabs(path: string): string {
  return API_TABS.map(({ value, label }, i) => `<a href="${escapeHtml(pageStateHref(path, "tab", value))}" data-element-api-tab="${value}" id="api-tab-${i}" aria-controls="api-panel-${i}"${activeApiTab(path) === value ? ' aria-current="page"' : ""}>${label}</a>`).join("");
}

/** HTML belongs in the presentation cache; insert the request's fresh CSP nonce last. */
export function renderElementApi(ctx: PageContext, api: ElementApi): string {
  let variants = panels.get(api);
  if (!variants) { variants = new Map(); panels.set(api, variants); }
  const key = ctx.i18n.locale;
  let panel = variants.get(key);
  if (!panel) { panel = compileElementApiPanel({ ...ctx, nonce: PANEL_NONCE }, api); variants.set(key, panel); }
  const active = API_TABS.findIndex(tab => tab.value === activeApiTab(ctx.path));
  if (active >= 0) panel = panel.replace('data-element-api hidden', 'data-element-api').replace(`aria-labelledby="api-tab-${active}" hidden`, `aria-labelledby="api-tab-${active}"`);
  return panel.replaceAll(`nonce="${PANEL_NONCE}"`, `nonce="${escapeHtml(ctx.nonce)}"`);
}

function compileElementApiPanel(ctx: PageContext, api: ElementApi): string {
  const fieldRows = api.properties.map(field => `<tr><td><code>${escapeHtml(field.path)}</code></td><td class="property-type"><code>${escapeHtml(field.type)}</code></td><td>${field.required ? "Required" : "Optional"}${field.description ? `<br>${escapeHtml(field.description)}` : ""}</td></tr>`).join("");
  const properties = `<details open><summary>Public properties (${api.properties.length})</summary><div class="api-table"><table><thead><tr><th>Property</th><th>Type</th><th>Schema</th></tr></thead><tbody>${fieldRows}</tbody></table></div></details>`;
  const origin = new URL(String(api.document.servers[0]?.url)).origin;
  const skill = skillMarkdown(origin);
  const focus = `${JSON.stringify(api.name)} (friendly address: ${api.address})`;
  const mcpPrompt = `Install and configure the HomeTruth MCP server at ${origin}/mcp using Streamable HTTP and my existing HomeTruth access; when authentication is required, use an existing HomeTruth API token in your secure connection settings. This connection covers the entire installation; my current element of interest is ${focus}.`;
  const skillPrompt = `Install the hometruth skill from ${origin}/SKILL.md using my existing HomeTruth access when authentication is required. The skill covers the entire installation; my current element of interest is ${focus}.`;
  const interest = `<p>Current element of interest: <strong>${escapeHtml(api.name)}</strong> · <code>${escapeHtml(api.address)}</code></p>`;
  const examples = clientExamples(api);
  const code = examples[0]!.code;
  const inventoryCode = `import ht from "./ht";\nawait ht.connect(${JSON.stringify(api.document.servers[0]?.url)});\n\nconsole.log(ht.inventory);\nconsole.log(Object.keys(ht.devices));`;
  const installCli = `mkdir -p "$HOME/.local/bin" &&\nht_download="$(mktemp "$HOME/.local/bin/ht.XXXXXX")" &&\ncurl --fail --show-error --location ${shellWord(`${origin}/ht-cli.js`)} --output "$ht_download" &&\nchmod +x "$ht_download" &&\nmv "$ht_download" "$HOME/.local/bin/ht"\nexport PATH="$HOME/.local/bin:$PATH"\nht --help`;
  return `<section class="element-api" data-element-api hidden data-nonce="${escapeHtml(ctx.nonce)}" data-page="${escapeHtml(api.page)}">
    <h2>API · ${escapeHtml(api.name)}</h2><p><code>${escapeHtml(api.address)}</code> · ${api.properties.length} properties · ${api.operations.length} methods</p>
    <div role="region" id="api-panel-0" aria-labelledby="api-tab-0" hidden>
      <p>One HomeTruth library for the whole install. Connect once, then use <code>ht.devices[address]</code> or <code>ht.elements[address]</code>. <a href="/ht.ts" download="ht.ts">Download shared TypeScript library</a> · <a href="/api/inventory">Browse element inventory</a></p>
      <details><summary>Use the client in your code</summary>${copyBlock(code)}</details>
      <details><summary>Explore every element</summary>${copyBlock(inventoryCode)}</details>
      <h3>Playground</h3><p>Runs against this HomeTruth instance using your current session. <code>describe()</code> lists an element’s properties and methods. For a token in your own code, use <code>ht.connect(url, { token: "…" })</code>.</p>
      <label class="field">Example<select data-ts-example>${examples.map(example => `<option value="${escapeHtml(example.name)}">${escapeHtml(example.name)}</option>`).join("")}</select></label>
      <label class="field">TypeScript<textarea data-ts-code spellcheck="false" aria-label="TypeScript code">${escapeHtml(code)}</textarea></label>
      <div class="bar"><button type="button" class="btn btn-primary" data-ts-run>Run TypeScript</button><button type="button" class="btn" data-ts-stop disabled>Stop</button><label><input type="checkbox" data-ts-writes> Enable changes</label></div>
      <pre data-ts-output role="status" aria-live="polite">Ready.</pre>
      ${properties}
      <details open><summary>All methods (${examples.length})</summary>${examples.map(example => `<div class="api-command"><h3>${escapeHtml(example.name)}</h3><p>${escapeHtml(example.description)}</p><p><code>${escapeHtml(example.signature)}</code></p>${copyBlock(example.code)}</div>`).join("")}</details>
    </div>
    <div role="region" id="api-panel-1" aria-labelledby="api-tab-1" hidden>${properties}${renderApiPlayground(ctx, api.document, `${api.page}/openapi.json`)}</div>
    <div role="region" id="api-panel-2" aria-labelledby="api-tab-2" hidden>
      <h3>Install ht (if needed)</h3>
      <p>Try <code>ht --help</code> in your terminal. If it works, skip to Connect. If the command is not found, install <a href="https://bun.sh/docs/installation" target="_blank" rel="noopener noreferrer">Bun 1.3.12 or newer</a>, then run these commands on macOS or Linux:</p>
      ${copyBlock(installCli)}
      <p>This downloads the CLI from this HomeTruth server, ready for the commands below. Keep Bun installed. Add <code>export PATH="$HOME/.local/bin:$PATH"</code> to your shell profile (such as <code>~/.zshrc</code> or <code>~/.bashrc</code>) to use <code>ht</code> in new terminals.</p>
      <details><summary>Windows and other options</summary><p><a href="/ht-cli.js" download="ht-cli.js">Download the CLI</a> and run <code>bun ht-cli.js --help</code>. Use <code>bun ht-cli.js</code> in place of <code>ht</code> below. In PowerShell, set the server with <code>$env:HOMETRUTH_URL = ${escapeHtml(JSON.stringify(origin))}</code>.</p></details>
      <h3>Connect</h3><p>Set the server URL in your terminal. Set <code>HOMETRUTH_TOKEN</code> through your secure environment settings when authentication is required. Your computer must be able to reach this server and trust its HTTPS certificate.</p>
      ${copyBlock(`export HOMETRUTH_URL=${shellWord(origin)}`)}
      <h3>Try it</h3><p>Read this element and list its commands. Replace example values and parameters before running other commands.</p>
      ${copyBlock(`ht ${shellWord(api.address)}\nht ${shellWord(api.address)} help`)}${properties}${api.commands.map(command => `<div class="api-command"><h3>${escapeHtml(command.name)}</h3><p>${escapeHtml(command.summary)}</p><p><code>${escapeHtml(commandUsage(command))}</code></p>${copyBlock(command.example)}</div>`).join("")}
    </div>
    <div role="region" id="api-panel-3" aria-labelledby="api-tab-3" hidden>
      <h3>Connect your agent to HomeTruth</h3><p>One MCP server for the entire installation, using your existing HomeTruth access and permissions.</p>${interest}
      <p>Copy this request and paste it into your agent:</p>${copyBlock(mcpPrompt, "mcp")}
      <p>MCP endpoint: <a href="/mcp"><code>${escapeHtml(origin)}/mcp</code></a> · Streamable HTTP</p>
      <p>Your agent must be able to reach this HomeTruth installation. A cloud agent may not reach a local network address. If authentication is required, configure an existing HomeTruth API token through the agent’s secure connection settings.</p>
    </div>
    <div role="region" id="api-panel-4" aria-labelledby="api-tab-4" hidden>
      <h3>Install the HomeTruth skill</h3><p>One skill for the entire installation. The current element stays in your request, so you can use the same skill for other elements.</p>${interest}
      <p>Copy this request and paste it into your agent:</p>${copyBlock(skillPrompt, "skill")}
      <p>Your agent needs network access to this installation. If authentication is required, use your existing HomeTruth token through the agent’s secure settings.</p>
      <p><a href="/SKILL.md">Open HomeTruth SKILL.md</a></p><details><summary>Preview the HomeTruth skill</summary>${copyBlock(skill)}</details>
    </div>
    <script type="application/json" nonce="${escapeHtml(ctx.nonce)}" data-api-examples>${JSON.stringify(examples.map(({ name, code }) => ({ name, code }))).replaceAll("<", "\\u003c")}</script>
  </section>`;
}

export const ELEMENT_API_SCRIPT = `${API_SCRIPT}\n` + String.raw`
(() => {
  const root = document.querySelector('[data-element-api]');
  if (!root) return;
  const navigation = document.querySelector('[data-element-tabs]');
  const page = document.querySelector('[data-element-page-panel]');
  const pageTab = navigation.querySelector('[data-element-page-tab]');
  const tabs = [...navigation.querySelectorAll('[data-element-api-tab]')];
  const select = (tab) => {
    root.hidden = !tab;
    page.hidden = Boolean(tab);
    if (tab) pageTab?.removeAttribute('aria-current'); else pageTab?.setAttribute('aria-current', 'page');
    for (const entry of tabs) {
      if (entry === tab) entry.setAttribute('aria-current', 'page'); else entry.removeAttribute('aria-current');
      document.getElementById(entry.getAttribute('aria-controls')).hidden = entry !== tab;
    }
  };
  ht.pageState.watch(['tab'], query => select(tabs.find(tab => tab.dataset.elementApiTab === query.get('tab'))));
  ht.pageState.watch(null, () => {
    for (const tab of [...tabs, pageTab].filter(Boolean)) {
      const url = new URL(location.href);
      if (tab === pageTab) url.searchParams.delete('tab'); else url.searchParams.set('tab', tab.dataset.elementApiTab);
      tab.href = url.pathname + url.search + url.hash;
    }
  });
  for (const tab of [...tabs, pageTab].filter(Boolean)) tab.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); ht.pageState.update({ tab: tab === pageTab ? null : tab.dataset.elementApiTab });
  });
  root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.closest('[data-copy-block]').querySelector('code').textContent); button.textContent = 'Copied'; }
    catch { button.textContent = 'Select and copy the code below'; }
  }));
  const examples = JSON.parse(root.querySelector('[data-api-examples]').textContent);
  const editor = root.querySelector('[data-ts-code]');
  const example = root.querySelector('[data-ts-example]');
  ht.pageState.bind(example, 'example', () => { editor.value = examples.find(entry => entry.name === example.value).code; });
  const output = root.querySelector('[data-ts-output]');
  const run = root.querySelector('[data-ts-run]'); const stop = root.querySelector('[data-ts-stop]');
  const writes = root.querySelector('[data-ts-writes]');
  let frame, timeout, controller;
  const finish = () => { clearTimeout(timeout); controller?.abort(); frame?.remove(); frame = undefined; run.disabled = false; stop.disabled = true; };
  stop.addEventListener('click', () => { finish(); output.textContent += '\nStopped.'; });
  window.addEventListener('message', async event => {
    if (!frame || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (message?.type === 'output') output.textContent += message.text + '\n';
    if (message?.type === 'done') finish();
    if (message?.type !== 'request') return;
    const sender = event.source;
    try {
      const url = new URL(message.path, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) throw new Error('Only this install’s API is available.');
      const method = String(message.init?.method || 'GET').toUpperCase();
      if (method !== 'GET' && !writes.checked) throw new Error('Enable changes before calling a method that writes.');
      const response = await fetch(url, { method, body: message.init?.body, headers: { 'content-type': message.init?.headers?.['content-type'] || 'application/json', ...(message.init?.headers?.authorization ? { authorization: message.init.headers.authorization } : {}) }, credentials: 'same-origin', signal: controller.signal });
      const type = response.headers.get('content-type') || '';
      if (type.includes('event-stream') || type.startsWith('multipart/')) { await response.body?.cancel(); throw new Error('Use the REST URL or downloaded client to consume this stream.'); }
      const result = type.includes('json') ? await response.json() : type.startsWith('text/') ? await response.text() : { contentType: type, bytes: (await response.blob()).size };
      if (!response.ok) throw new Error(result?.error?.message || String(response.status));
      sender.postMessage({ type: 'result', id: message.id, result }, '*');
    } catch (error) { sender.postMessage({ type: 'result', id: message.id, error: String(error.message || error) }, '*'); }
  });
  run.addEventListener('click', async () => {
    finish(); controller = new AbortController(); run.disabled = true; stop.disabled = false; output.textContent = '';
    timeout = setTimeout(() => { finish(); output.textContent += '\nStopped after 30 seconds.'; }, 30000);
    try {
      const response = await fetch('/api/playground', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: editor.value }), signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result?.error?.message || 'Compilation failed');
      frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts'); frame.title = 'TypeScript sandbox';
      const nonce = root.dataset.nonce;
      const code = result.code.replace(/<\/script/gi, '<\\/script');
      frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce + '\'; connect-src \'none\'"><script nonce="' + nonce + '">' + code + '</scr' + 'ipt>';
      root.append(frame);
    } catch (error) { output.textContent = String(error.message || error); finish(); }
  });
})();`;
