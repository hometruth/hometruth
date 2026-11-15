import { escapeHtml, type PageContext } from "./shell";

/** The single room field in the shared element editor. */
export function renderRoomPicker(ctx: PageContext, rooms: readonly string[], current?: string): string {
  const { t } = ctx.i18n;
  const choices = [...new Set([...rooms, ...(current ? [current] : [])])].sort((a, b) => a.localeCompare(b, ctx.i18n.locale));
  return `<form class="room-picker" data-room-picker>
    <div class="field-row">
      <select name="room" aria-label="${escapeHtml(t("room.label"))}"><option value="">${escapeHtml(t("room.none"))}</option>${choices.map(room => `<option value="room:${escapeHtml(room)}"${room === current ? " selected" : ""}>${escapeHtml(room)}</option>`).join("")}<option value="new">${escapeHtml(t("room.add"))}</option></select>
      <input name="newRoom" aria-label="${escapeHtml(t("room.new"))}" maxlength="100" placeholder="${escapeHtml(t("room.placeholder"))}" autocomplete="off" disabled hidden>
      <button type="submit" class="btn">${escapeHtml(t("room.save"))}</button>
    </div>
    <output class="feedback" data-room-feedback role="status" aria-live="polite"></output>
  </form>`;
}
