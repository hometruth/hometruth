/**
 * Every token, what it may do, and what it reaches.
 *
 * A token can name one device or use group membership. Criteria fields reuse
 * the group builder. A token's
 * `criteriaRoom` / `schemaId` / `tagIds` are the group builder's own field
 * names, which is what lets the route hand them to `automaticGroupMembers`
 * untouched.
 *
 * A freshly issued token is shown once, in full, above the table. There is no
 * second chance by construction — the server kept only a hash — so the page
 * says so plainly rather than implying it can be looked up later.
 */
import { criteriaFields, type GroupTagChoice } from "./device-group-page";
import type { GroupSchemaChoice } from "../models/automatic-group";
import { PERMISSIONS, describeSubject, type Permission } from "../auth/model";
import type { TokenRecord } from "../auth/store";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export interface TokensPageOptions {
  readonly ctx: PageContext;
  readonly tokens: readonly TokenRecord[];
  readonly devices: readonly { readonly id: string; readonly name: string }[];
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  readonly rooms?: readonly string[];
  readonly schemas?: readonly GroupSchemaChoice[];
  readonly tags?: readonly GroupTagChoice[];
  /** Whether the local network is trusted; the list would otherwise imply it is the whole story. */
  readonly localNetworkTrusted?: boolean;
}

function permissionChoices(ctx: PageContext): string {
  const { t } = ctx.i18n;
  return PERMISSIONS.map((permission: Permission) => `<label class="perm">
    <input type="radio" name="permissions" value="${permission}"${permission === "read" ? " checked" : ""}>
    <span><b>${escapeHtml(t(`perm.${permission}`))}</b><small class="muted">${escapeHtml(t(`perm.${permission}.hint`))}</small></span>
  </label>`).join("");
}

function tokenRow(ctx: PageContext, token: TokenRecord, groupName: (id: string) => string | undefined): string {
  const { t, dateTime } = ctx.i18n;
  const revoked = Boolean(token.revokedAt);
  return `<tr data-token="${escapeHtml(token.kid)}"${revoked ? ' data-revoked="true"' : ""}>
    <th scope="row">${escapeHtml(token.name)}<br><small class="muted mono">${escapeHtml(token.kid)}</small></th>
    <td>${token.permissions.map(permission => escapeHtml(t(`perm.${permission}`))).join(", ")}</td>
    <td>${escapeHtml(describeSubject(token.subject, groupName))}</td>
    <td class="num"><time datetime="${escapeHtml(token.createdAt)}">${escapeHtml(dateTime(token.createdAt))}</time></td>
    <td class="num">${token.expiresAt ? `<time datetime="${escapeHtml(token.expiresAt)}">${escapeHtml(dateTime(token.expiresAt))}</time>` : escapeHtml(t("tokens.never"))}</td>
    <td class="num">${token.lastUsedAt ? `<time datetime="${escapeHtml(token.lastUsedAt)}">${escapeHtml(dateTime(token.lastUsedAt))}</time>` : `<span class="muted">${escapeHtml(t("tokens.unused"))}</span>`}</td>
    <td>${revoked
      ? `<span class="muted">${escapeHtml(t("tokens.revoked"))}</span>`
      : `<button type="button" class="btn btn-small btn-danger" data-revoke="${escapeHtml(token.kid)}">${escapeHtml(t("tokens.revoke"))}</button>`}</td>
  </tr>`;
}

export function renderTokensPage({ ctx, tokens, devices, groups, rooms = [], schemas = [], tags = [], localNetworkTrusted = false }: TokensPageOptions): string {
  const { t } = ctx.i18n;
  const groupName = (id: string) => groups.find(group => group.id === id)?.name;
  return renderPage({
    ctx,
    title: t("tokens.title"),
    nav: "tokens",
    wide: true,
    messages: ["tokens.", "perm.", "grouping."],
    css: `
      .perm { display: flex; gap: var(--s2); align-items: start; padding-block: var(--s2); }
      .perm span { display: flex; flex-direction: column; }
      .perm small { display: block; }
      tr[data-revoked] th, tr[data-revoked] td { opacity: .55; }
      /* The action column is one short word; never break it across lines. */
      .table td:last-child { white-space: nowrap; }
      .issued { border: var(--rule-w) solid var(--accent); padding: var(--s3); margin-block: var(--s4); }
      /* Not a decoration: without it the table below reads as the full list of
         ways in, which it is not while the local network is trusted. */
      .open-network { border-inline-start: var(--mark) solid var(--warn-mark); padding-inline-start: var(--s3); color: var(--fg-2); }
      .issued code { display: block; overflow-wrap: anywhere; margin-block: var(--s2); }
    `,
    body: `<div class="page-head"><h1>${escapeHtml(t("tokens.title"))}</h1></div>
      <p>${escapeHtml(t("tokens.intro"))}</p>
      ${localNetworkTrusted ? `<p class="open-network" role="note">${escapeHtml(t("tokens.localNetworkOpen"))}</p>` : ""}
      <div class="issued" hidden data-issued>
        <p>${escapeHtml(t("tokens.issued"))}</p>
        <code class="mono" data-issued-token></code>
        <div class="bar"><button type="button" class="btn btn-small" data-copy>${escapeHtml(t("tokens.copy"))}</button></div>
      </div>
      <section>
        <h2>${escapeHtml(t("tokens.title"))}</h2>
        ${tokens.length === 0 ? `<p class="empty">${escapeHtml(t("tokens.none"))}</p>` : `<div class="table-wrap"><table class="table">
          <thead><tr>
            <th scope="col">${escapeHtml(t("tokens.name"))}</th>
            <th scope="col">${escapeHtml(t("tokens.permissions"))}</th>
            <th scope="col">${escapeHtml(t("tokens.reaches"))}</th>
            <th scope="col">${escapeHtml(t("tokens.created"))}</th>
            <th scope="col">${escapeHtml(t("tokens.expires"))}</th>
            <th scope="col">${escapeHtml(t("tokens.lastUsed"))}</th>
            <th scope="col"><span class="sr-only">${escapeHtml(t("tokens.revoke"))}</span></th>
          </tr></thead>
          <tbody>${tokens.map(token => tokenRow(ctx, token, groupName)).join("")}</tbody>
        </table></div>`}
      </section>
      <section>
        <h2>${escapeHtml(t("tokens.create"))}</h2>
        <form data-token-form>
          <label class="field"><span>${escapeHtml(t("tokens.name"))}</span>
            <input type="text" name="name" maxlength="200" required></label>
          <p class="note small">${escapeHtml(t("tokens.nameHint"))}</p>

          <fieldset><legend>${escapeHtml(t("tokens.permissions"))}</legend>${permissionChoices(ctx)}</fieldset>

          <fieldset><legend>${escapeHtml(t("tokens.reaches"))}</legend>
            <label class="perm"><input type="radio" name="subject" value="all" checked><span>${escapeHtml(t("tokens.subjectAll"))}</span></label>
            <label class="perm"><input type="radio" name="subject" value="device"><span>${escapeHtml(t("tokens.subjectDevice"))}</span></label>
            <label class="field" data-subject-device hidden><span>${escapeHtml(t("tokens.device"))}</span>
              <select name="device">${devices.map(device => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)}</option>`).join("")}</select></label>
            <label class="perm"><input type="radio" name="subject" value="group"><span>${escapeHtml(t("tokens.subjectGroup"))}</span></label>
            <label class="field" data-subject-group hidden><span>${escapeHtml(t("tokens.group"))}</span>
              <select name="group">${groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("")}</select></label>
            <label class="perm"><input type="radio" name="subject" value="criteria"><span>${escapeHtml(t("tokens.subjectCriteria"))}</span></label>
            <div data-subject-criteria hidden>${criteriaFields(ctx, rooms, schemas, tags)}</div>
          </fieldset>

          <label class="field"><span>${escapeHtml(t("tokens.expires"))}</span>
            <input type="date" name="expiresAt"></label>
          <p class="note small">${escapeHtml(t("tokens.expiresHint"))}</p>

          <div class="bar"><button type="submit" class="btn btn-primary">${escapeHtml(t("tokens.createSubmit"))}</button></div>
        </form>
        <p class="feedback" role="status" data-token-feedback></p>
      </section>`,
    script: `
      (() => {
        const form = document.querySelector("[data-token-form]");
        const feedback = document.querySelector("[data-token-feedback]");
        if (!(form instanceof HTMLFormElement)) return;
        const groupField = form.querySelector("[data-subject-group]");
        const deviceField = form.querySelector("[data-subject-device]");
        const criteriaField = form.querySelector("[data-subject-criteria]");
        const chosenSubject = () => form.querySelector("input[name=subject]:checked").value;
        const sync = () => {
          const subject = chosenSubject();
          groupField.hidden = subject !== "group";
          deviceField.hidden = subject !== "device";
          criteriaField.hidden = subject !== "criteria";
        };
        form.addEventListener("change", (event) => { if (event.target.name === "subject") sync(); });
        sync();

        const subjectValue = () => {
          const subject = chosenSubject();
          if (subject === "all") return { all: true };
          if (subject === "device") return { device: form.elements.namedItem("device").value };
          if (subject === "group") return { group: form.elements.namedItem("group").value };
          const criteria = {};
          const room = form.elements.namedItem("criteriaRoom").value;
          const schemaId = form.elements.namedItem("schemaId").value;
          const tagIds = [...form.querySelectorAll("input[name=tagIds]:checked")].map((input) => input.value);
          if (room) criteria.room = room;
          if (schemaId) criteria.schemaId = schemaId;
          if (tagIds.length) criteria.tagIds = tagIds;
          return { criteria };
        };

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const name = form.elements.namedItem("name").value.trim();
          const permissions = [...form.querySelectorAll("input[name=permissions]:checked")].map((input) => input.value);
          if (!name) { ht.say(feedback, ht.t("tokens.needName"), "bad"); return; }
          if (!permissions.length) { ht.say(feedback, ht.t("tokens.needPermission"), "bad"); return; }
          const subject = subjectValue();
          // An empty definition would reach nothing at all; say so rather than issuing a dead token.
          if (subject.criteria && !Object.keys(subject.criteria).length) { ht.say(feedback, ht.t("grouping.chooseCriteria"), "bad"); return; }
          const expires = form.elements.namedItem("expiresAt").value;
          try {
            const body = { name, permissions, subject };
            if (expires) body.expiresAt = new Date(expires + "T23:59:59").toISOString();
            const created = await ht.request("/api/tokens", { method: "POST", body: JSON.stringify(body) });
            const banner = document.querySelector("[data-issued]");
            document.querySelector("[data-issued-token]").textContent = created.token;
            banner.hidden = false;
            banner.scrollIntoView({ block: "nearest" });
            ht.say(feedback, "");
            // The page cannot reload to pick the new row up without throwing
            // away the one copy of the token, so the row is added here instead.
            // A table that did not show what was just issued would be lying.
            addRow(created);
            form.reset();
            sync();
          } catch (error) {
            ht.say(feedback, error.message || ht.t("tokens.createFailed"), "bad");
          }
        });

        /** One row, matching what the server rendered, for a token issued just now. */
        function addRow(token) {
          const body = document.querySelector("table.table tbody");
          const empty = document.querySelector(".empty");
          if (!body) { if (empty) empty.textContent = ht.t("tokens.issued"); return; }
          const row = document.createElement("tr");
          row.dataset.token = token.kid;
          const cell = (text, className) => {
            const td = document.createElement("td");
            td.textContent = text;
            if (className) td.className = className;
            return td;
          };
          const name = document.createElement("th");
          name.scope = "row";
          name.append(token.name, document.createElement("br"));
          const kid = document.createElement("small");
          kid.className = "muted mono";
          kid.textContent = token.kid;
          name.append(kid);
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "btn btn-small btn-danger";
          revoke.dataset.revoke = token.kid;
          revoke.textContent = ht.t("tokens.revoke");
          const action = document.createElement("td");
          action.append(revoke);
          row.append(
            name,
            cell(token.permissions.map((permission) => ht.t("perm." + permission)).join(", ")),
            cell(token.reaches),
            cell(ht.dateTime(token.createdAt), "num"),
            cell(token.expiresAt ? ht.dateTime(token.expiresAt) : ht.t("tokens.never"), "num"),
            cell(ht.t("tokens.unused"), "num"),
            action,
          );
          body.prepend(row);
        }

        const copy = document.querySelector("[data-copy]");
        if (copy) copy.addEventListener("click", async () => {
          await navigator.clipboard.writeText(document.querySelector("[data-issued-token]").textContent || "");
          copy.textContent = ht.t("tokens.copied");
        });

        document.addEventListener("click", async (event) => {
          const button = event.target.closest("[data-revoke]");
          if (!button) return;
          button.disabled = true;
          try {
            await ht.request("/api/tokens/" + encodeURIComponent(button.dataset.revoke) + "/revoke", { method: "POST", body: "{}" });
            window.location.reload();
          } catch (error) {
            button.disabled = false;
            ht.say(feedback, error.message || ht.t("tokens.revokeFailed"), "bad");
          }
        });
      })();
    `,
  });
}
