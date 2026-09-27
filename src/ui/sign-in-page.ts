/**
 * Where a browser exchanges a token for a session.
 *
 * Deliberately the plainest page in the site: no navigation, because there is
 * nothing yet to navigate; one field; and the one sentence a person needs when
 * they have just started HomeTruth for the first time and do not yet know a
 * token exists. The footer stays, so the theme and language chosen here carry
 * into the session.
 *
 * The field is `type="password"` so a password manager offers to keep the
 * token, and so it is not left legible on a screen in a kitchen.
 */
import { escapeHtml, renderPage, type PageContext } from "./shell";

/** A path this server would route to, so the redirect cannot be aimed off-site. */
export function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/**
 * What the local network means for *this* request, not for the site.
 *
 * `trusted`  this caller came from a private address and needs no token
 * `enabled`  the site trusts the local network, but this request did not
 *            arrive from a local address — which is nearly always a stale
 *            server in front of new code, so the page says so
 * `off`      local-network trust is switched off; a token is the only way in
 */
export type LocalNetworkState = "trusted" | "enabled" | "off";

export function renderSignInPage(ctx: PageContext, next = "/", localNetwork: LocalNetworkState = "off"): string {
  next = safeNext(next);
  const path = new URL(ctx.path, "http://hometruth.local");
  if (next === "/") path.searchParams.delete("next"); else path.searchParams.set("next", next);
  ctx = { ...ctx, path: path.pathname + path.search };
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: t("auth.signIn.title"),
    bare: true,
    messages: ["auth."],
    css: `
      .sign-in { max-width: 28rem; margin-block: var(--s7); }
      .sign-in input { width: 100%; font-family: var(--font-mono); }
    `,
    body: `<section class="sign-in">
      <h1>${escapeHtml(t("auth.signIn.title"))}</h1>
      <p>${escapeHtml(t("auth.signIn.intro"))}</p>
      ${localNetwork === "off" ? "" : `<p class="note" data-local-network="${localNetwork}">${escapeHtml(t(localNetwork === "trusted" ? "auth.signIn.localNetwork" : "auth.signIn.localNetworkUnseen"))}</p>`}
      <form data-sign-in>
        <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
        <label class="field"><span>${escapeHtml(t("auth.signIn.token"))}</span>
          <input type="password" name="token" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <div class="bar"><button type="submit" class="btn btn-primary">${escapeHtml(t("auth.signIn.submit"))}</button></div>
      </form>
      <p class="feedback" role="status" data-sign-in-feedback></p>
      <p class="note small">${escapeHtml(t("auth.signIn.firstRun"))}</p>
    </section>`,
    script: `
      (() => {
        const form = document.querySelector("[data-sign-in]");
        const feedback = document.querySelector("[data-sign-in-feedback]");
        if (!(form instanceof HTMLFormElement)) return;
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const token = form.elements.namedItem("token").value.trim();
          if (!token) return;
          try {
            await ht.request("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ token }) });
            window.location.assign(form.elements.namedItem("next").value || "/");
          } catch {
            ht.say(feedback, ht.t("auth.signIn.failed"), "bad");
          }
        });
      })();
    `,
  });
}
