import { escapeHtml, renderPage, type PageContext } from "./shell";
import { PASSKEY_SCRIPT } from "./passkey-script";

export function renderSecurityPage(ctx: PageContext): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx, title: t("auth.security.title"), nav: "security", messages: ["auth."],
    css: `.security-section { margin-block: var(--s6); } .security-list { padding: 0; list-style: none; }
      .security-list li { border-block-end: var(--rule-w) solid var(--line); padding-block: var(--s3); overflow-wrap: anywhere; }
      .security-list small { display: block; margin-block: var(--s2); }`,
    body: `<h1>${escapeHtml(t("auth.security.title"))}</h1>
      <p>${escapeHtml(t("auth.security.intro"))}</p>
      <p class="note">${escapeHtml(t("auth.security.lifetime"))}</p>
      <div class="bar"><a href="/sign-in?reauth=1&amp;next=%2Fsettings%2Fsecurity">${escapeHtml(t("auth.security.verify"))}</a>
        <button type="button" class="btn" data-sign-out>${escapeHtml(t("auth.security.signOut"))}</button></div>
      <p class="feedback" role="status" data-security-feedback></p>
      <section class="security-section"><h2>${escapeHtml(t("auth.security.passkeys"))}</h2>
        <p>${escapeHtml(t("auth.security.recovery"))}</p>
        <ul class="security-list" data-passkeys></ul>
        <form data-register-passkey>
          <label class="field"><span>${escapeHtml(t("auth.security.name"))}</span><input name="name" maxlength="100" required></label>
          <button type="submit" class="btn btn-primary">${escapeHtml(t("auth.security.add"))}</button>
        </form><p class="note" data-passkey-unavailable hidden>${escapeHtml(t("auth.passkey.unavailable"))}</p>
      </section>
      <section class="security-section"><h2>${escapeHtml(t("auth.security.browsers"))}</h2><ul class="security-list" data-sessions></ul></section>`,
    script: `(() => {
      ${PASSKEY_SCRIPT}
      const feedback = document.querySelector("[data-security-feedback]");
      const form = document.querySelector("[data-register-passkey]");
      form.hidden = !passkeysSupported;
      document.querySelector("[data-passkey-unavailable]").hidden = !!passkeysSupported;
      const fail = error => ht.say(feedback, error.message || ht.t("auth.passkey.failed"), "bad");
      const date = value => new Date(value).toLocaleString(document.documentElement.lang);
      function row(list, name, details, action) {
        const li = document.createElement("li"), title = document.createElement("strong"), small = document.createElement("small");
        title.textContent = name; small.textContent = details; li.append(title, small);
        const button = document.createElement("button"); button.type = "button"; button.className = "btn btn-small btn-danger";
        button.textContent = ht.t("auth.security.revoke");
        button.addEventListener("click", () => action().catch(fail)); li.append(button); list.append(li);
      }
      async function refresh() {
        const [keys, browsers] = await Promise.all([ht.request("/api/auth/passkeys"), ht.request("/api/auth/sessions")]);
        const keyList = document.querySelector("[data-passkeys]"), sessions = document.querySelector("[data-sessions]");
        keyList.replaceChildren(); sessions.replaceChildren();
        if (!keys.passkeys.length) keyList.textContent = ht.t("auth.security.noPasskeys");
        if (!browsers.sessions.length) sessions.textContent = ht.t("auth.security.noSessions");
        for (const key of keys.passkeys) row(keyList, key.name, ht.t("auth.security.created") + " " + date(key.createdAt), async () => {
          await ht.request("/api/auth/passkeys/" + encodeURIComponent(key.id) + "/revoke", { method: "POST", body: "{}" });
          // Removing the key used for this session also signs this browser out.
          window.location.reload();
        });
        for (const browser of browsers.sessions) row(sessions, browser.name + (browser.current ? " · " + ht.t("auth.security.current") : ""),
          ht.t("auth.security.lastUsed") + " " + date(browser.lastUsedAt) + " · " + ht.t("auth.security.expires") + " " + date(browser.expiresAt), async () => {
          await ht.request("/api/auth/sessions/" + encodeURIComponent(browser.id) + "/revoke", { method: "POST", body: "{}" });
          if (browser.current) window.location.assign("/sign-in"); else await refresh();
        });
      }
      form.addEventListener("submit", async event => {
        event.preventDefault(); const button = form.querySelector("button"); button.disabled = true;
        try {
          const options = await ht.request("/api/auth/passkeys/register/options", { method: "POST", body: "{}" });
          const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
          if (!credential) throw new Error(ht.t("auth.passkey.failed"));
          await ht.request("/api/auth/passkeys/register/verify", { method: "POST", body: JSON.stringify({ name: form.elements.namedItem("name").value, credential: credential.toJSON() }) });
          form.reset(); await refresh(); ht.say(feedback, ht.t("auth.security.added"), "ok");
        } catch (error) { fail(error); } finally { button.disabled = false; }
      });
      document.querySelector("[data-sign-out]").addEventListener("click", async () => {
        try { await ht.request("/api/auth/sign-out", { method: "POST", body: "{}" }); window.location.assign("/sign-in"); } catch (error) { fail(error); }
      });
      refresh().catch(fail);
    })();`,
  });
}
