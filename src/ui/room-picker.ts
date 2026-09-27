import type { RegisteredDevice } from "../site";
import { escapeHtml, type PageContext } from "./shell";

/** The room form on a device's Settings page. Needs the `room.` messages. */
export function renderRoomPicker(ctx: PageContext, device: Pick<RegisteredDevice, "id" | "room">, settings?: { endpoint: string; writable: boolean }): string {
  const { t } = ctx.i18n;
  const rooms = [...new Set([...(ctx.rooms ?? []), ...(device.room ? [device.room] : [])])].sort((a, b) => a.localeCompare(b, ctx.i18n.locale));
  const writable = settings?.writable ?? true;
  return `<form class="room-picker" data-room-picker data-device-id="${escapeHtml(device.id)}" data-room="${escapeHtml(device.room ?? "")}"${settings ? ` data-room-endpoint="${escapeHtml(settings.endpoint)}" data-room-writable="${settings.writable}"` : ""}>
    <div class="field-row">
      <select name="room" aria-label="${escapeHtml(t("room.label"))}" ${writable ? "" : "disabled"}><option value="">${escapeHtml(t("room.none"))}</option>${rooms.map(room => `<option value="room:${escapeHtml(room)}"${room === device.room ? " selected" : ""}>${escapeHtml(room)}</option>`).join("")}<option value="new">${escapeHtml(t("room.add"))}</option></select>
      <input name="newRoom" aria-label="${escapeHtml(t("room.new"))}" maxlength="100" placeholder="${escapeHtml(t("room.placeholder"))}" autocomplete="off" disabled hidden>
      <button type="submit" class="btn"${writable ? "" : " disabled"}>${escapeHtml(t("room.save"))}</button>
    </div>
    <output class="feedback" data-room-feedback role="status" aria-live="polite">${writable ? "" : escapeHtml(t("room.readOnly"))}</output>
  </form>`;
}

export const ROOM_PICKER_SCRIPT = String.raw`
(() => {
  const forms = Array.from(document.querySelectorAll("[data-room-picker]"));
  if (!forms.length) return;
  for (const form of forms) {
    const select = form.elements.namedItem("room");
    const input = form.elements.namedItem("newRoom");
    const save = form.querySelector("button[type=submit]");
    const feedback = form.querySelector("[data-room-feedback]");
    const update = () => {
      const adding = select.value === "new";
      input.hidden = !adding;
      input.disabled = !adding;
      input.required = adding;
      if (adding) input.focus();
    };
    select.addEventListener("change", update);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const room = select.value === "new" ? input.value.trim() : select.value.startsWith("room:") ? select.value.slice(5) : null;
      if (room === "") { ht.say(feedback, ht.t("room.enterName"), "bad"); input.focus(); return; }
      save.disabled = true;
      select.disabled = true;
      ht.say(feedback, ht.t("feedback.saving"));
      try {
        await ht.request(form.dataset.roomEndpoint || "/api/devices/" + encodeURIComponent(form.dataset.deviceId) + "/room", { method: "POST", body: JSON.stringify({ room }) });
        ht.say(feedback, ht.t("feedback.savedReloading"), "ok");
        window.location.reload();
      } catch (error) {
        ht.say(feedback, error instanceof Error ? error.message : ht.t("room.saveFailed"), "bad");
        save.disabled = false;
        select.disabled = false;
      }
    });
  }
})();
`;
