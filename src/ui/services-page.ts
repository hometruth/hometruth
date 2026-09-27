import type { ServiceEvent } from "../models/event-log";
import { countDetectionLabels } from "../models/detection-labels";
import type { RegisteredService } from "../site";
import { escapeHtml, renderPage, renderStatus, type PageContext } from "./shell";
import { DETECTION_PREVIEW_SCRIPT } from "./detection-preview";
import { EVENT_FILTER_CONTROLS_SCRIPT, renderSavedFilterControls } from "./event-filter-controls";

export interface ServicesPageOptions {
  ctx: PageContext;
  services: readonly RegisteredService[];
}

/** One device a service's events can be filtered to. */
export interface EventSubjectView {
  id: string;
  name: string;
  page?: string;
}

/** One event type, as the filter menu and the rich views need it. */
export interface EventTypeView {
  id: string;
  label: string;
  description: string;
  level: "info" | "warn" | "error";
  view: "plain" | "thumbnail" | "properties" | "request" | "network";
}

/** One momentary action a service offers, and whatever it has standing right now. */
export interface ServiceActionView {
  id: string;
  /** When the action's current effect lapses (ISO 8601); absent when nothing is in force. */
  until?: string;
}

export interface ServicePageOptions {
  ctx: PageContext;
  service: RegisteredService;
  /** Devices this service's events are about; the "filter by device" menu. */
  subjects?: readonly EventSubjectView[];
  /** The event type catalog, for the type menu and for rendering each row. */
  types?: readonly EventTypeView[];
  detectionLabels?: readonly string[];
  /** What this service can be told to do once; a service with none shows no controls. */
  actions?: readonly ServiceActionView[];
  events?: readonly ServiceEvent[];
}

export const SERVICES_API = {
  list: "/api/services",
  events: "/api/services/:id/events",
  stream: "/api/services/:id/stream",
} as const;

/** The message prefixes the event log script reads. */
export const EVENT_LOG_MESSAGES: readonly string[] = ["services.", "events.", "filters."];

/** The site's services: what is running, and a link to each one's event log. */
export function renderServicesPage({ ctx, services }: ServicesPageOptions): string {
  const { t } = ctx.i18n;
  const body = services.length === 0
    ? `<p class="empty">${escapeHtml(t("services.empty"))}</p>`
    : `<ul class="rows">${services.map((service) => `
        <li><a class="row" href="${escapeHtml(service.page)}">
          <span class="row-name">${escapeHtml(service.title)}</span>
          <span class="row-meta">${escapeHtml(service.detail)}</span>
          <span class="row-side">${renderStatus(ctx, service.availability, { text: t(`status.${service.availability}`) })}</span>
        </a></li>`).join("")}</ul>`;
  return renderPage({
    ctx,
    title: t("services.title"),
    nav: "services",
    body: `<h1>${escapeHtml(t("services.title"))}</h1>${body}`,
  });
}

const MAX_EVENT_ROWS = 200;

/**
 * The event log's behaviour, shared by the service page, the device log,
 * and the camera page's Events tab: it reads its service id (and, on a
 * device page, its fixed subject) from the element it is attached to, asks
 * the server for an already-filtered backlog and stream, and renders each
 * row through its type's own view.
 */
export const EVENT_LOG_SCRIPT = String.raw`
  (() => {
    const root = document.querySelector("[data-event-log], [data-service-page]");
    if (!(root instanceof HTMLElement)) return;
    const id = encodeURIComponent(root.dataset.serviceId || "");
    const list = document.querySelector("#events");
    const live = document.querySelector("#live");
    const subjectFilter = document.querySelector("#filter-subject");
    const typeFilter = document.querySelector("#filter-type");
    const detectionFilter = document.querySelector("#filter-detections");
    const countLabel = document.querySelector("#event-count");
    const older = document.querySelector("#events-older");
    if (!(list instanceof HTMLElement)) return;
    const eventsPath = root.dataset.eventsPath || ("/api/services/" + id + "/events");
    const streamPath = root.dataset.streamPath || ("/api/services/" + id + "/stream");

    const views = JSON.parse(root.dataset.eventViews || "{}");
    const labels = JSON.parse(root.dataset.eventLabels || "{}");
    const names = JSON.parse(root.dataset.subjectNames || "{}");
    const pages = JSON.parse(root.dataset.subjectPages || "{}");

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    };
    const fact = (parent, label, value) => {
      if (value === undefined || value === null || value === "") return;
      const span = el("span", null, label ? label + " " : "");
      span.append(el("b", null, value));
      parent.append(span);
    };
    const addDetectionOptions = (values) => {
      if (!detectionFilter || !Array.isArray(values)) return;
      const options = detectionFilter.querySelector(".detection-matches");
      const existing = new Set([...detectionFilter.querySelectorAll("input")].map(input => input.value));
      for (const value of values) {
        if (typeof value !== "string" || !value || value.length > 200 || existing.has(value)) continue;
        existing.add(value);
        const label = el("label");
        const input = el("input"); input.type = "checkbox"; input.name = "detection"; input.value = value;
        const count = el("span", "detection-count"); count.setAttribute("aria-hidden", "true");
        label.append(input, el("span", "detection-name", value), count);
        options.append(label);
      }
      [...options.children].sort((a, b) => a.querySelector("input").value.localeCompare(b.querySelector("input").value)).forEach(node => options.append(node));
    };
    const setDetectionCounts = (payload) => {
      if (!detectionFilter) return;
      addDetectionOptions(payload.labels);
      if (!payload.labelCounts || typeof payload.labelCounts !== "object") return;
      const matches = detectionFilter.querySelector(".detection-matches");
      const absent = detectionFilter.querySelector(".detection-absent");
      const details = detectionFilter.querySelector("details");
      const focused = document.activeElement;
      const inputs = [...detectionFilter.querySelectorAll("input")].sort((a, b) => a.value.localeCompare(b.value));
      for (const input of inputs) {
        const count = Object.hasOwn(payload.labelCounts, input.value) ? payload.labelCounts[input.value] : 0;
        if (!Number.isSafeInteger(count) || count < 0) continue;
        const label = input.closest("label");
        label.querySelector(".detection-count").textContent = "(" + count + ")";
        input.setAttribute("aria-description", ht.t("services.filter.detectionCount", { count }));
        (count ? matches : absent).append(label);
        if (!count && input.checked) details.open = true;
      }
      details.hidden = !absent.children.length;
      details.querySelector("summary").textContent = ht.t("services.filter.noDetections", { count: absent.children.length });
      detectionFilter.querySelector(".detection-empty").hidden = !!matches.children.length;
      detectionFilter.removeAttribute("aria-busy");
      if (focused instanceof HTMLInputElement && detectionFilter.contains(focused)) focused.focus({ preventScroll: true });
    };
    const resetDetectionCounts = () => {
      if (!detectionFilter) return;
      detectionFilter.setAttribute("aria-busy", "true");
      const matches = detectionFilter.querySelector(".detection-matches");
      for (const input of detectionFilter.querySelectorAll("input")) {
        const label = input.closest("label");
        label.querySelector(".detection-count").textContent = "…";
        input.removeAttribute("aria-description");
        matches.append(label);
      }
      detectionFilter.querySelector("details").hidden = true;
      detectionFilter.querySelector(".detection-empty").hidden = true;
    };

    ${DETECTION_PREVIEW_SCRIPT}
    const renderBody = (event) => {
      const data = event.data || {};
      const view = views[event.type] || "plain";
      const body = el("div", "event-body");
      const photoPath = event.type === "photo_labeled" && data.source === "reveal"
        && /^[a-f0-9]{64}$/.test(data.photoId || "") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(event.subject || "")
        ? "/api/cameras/" + encodeURIComponent(event.subject) + "/photos/" + data.photoId : null;
      const framePath = ["camera_object", "camera_classified"].includes(event.type) && data.source === "frigate"
        && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(data.camera || "") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(data.objectId || "")
        ? "/api/services/frigate/frames/" + encodeURIComponent(data.camera) + "/" + encodeURIComponent(data.objectId)
          + (Number.isFinite(data.frameTime) ? "?at=" + encodeURIComponent(data.frameTime) : "") : null;
      const previewPath = photoPath || framePath;
      if (previewPath) {
        const preview = el("div", "event-preview");
        const image = el("img", "event-detection-image");
        image.alt = ht.t(photoPath ? "events.photoAlt" : "events.frameAlt");
        image.loading = "lazy";
        image.decoding = "async";
        const link = el("a", "event-frame-link");
        link.href = previewPath;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = ht.t(photoPath ? "events.photoBoxHint" : "events.frameHint");
        link.append(image);
        // REVEAL boxes use normalized left/top/right/bottom coordinates. Preserve the
        // image's aspect ratio so portrait and 4:3 frames align as well as 16:9 frames.
        if (photoPath && Array.isArray(data.detections)) {
          const ns = "http://www.w3.org/2000/svg";
          const overlay = document.createElementNS(ns, "svg");
          overlay.setAttribute("class", "event-detection-boxes");
          overlay.setAttribute("viewBox", "0 0 100 100");
          overlay.setAttribute("preserveAspectRatio", "none");
          overlay.setAttribute("aria-hidden", "true");
          for (const detection of data.detections.slice(0, 500)) {
            const box = detection?.box;
            if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
              || box[0] >= box[2] || box[1] >= box[3]) continue;
            const rect = document.createElementNS(ns, "rect");
            for (const [attribute, value] of Object.entries({ x: box[0] * 100, y: box[1] * 100,
              width: (box[2] - box[0]) * 100, height: (box[3] - box[1]) * 100 })) rect.setAttribute(attribute, String(value));
            rect.setAttribute("vector-effect", "non-scaling-stroke");
            overlay.append(rect);
          }
          if (overlay.childElementCount) link.append(overlay);
        }
        const missing = el("div", "event-frame-missing"); missing.hidden = true;
        missing.append(el("span", null, ht.t("events.frameUnavailable")));
        const retry = el("button", "subtle", ht.t("events.retryFrame")); retry.type = "button";
        retry.addEventListener("click", () => { missing.hidden = true; link.hidden = false; image.src = previewPath + (previewPath.includes("?") ? "&" : "?") + "retry=" + Date.now(); });
        missing.append(retry);
        image.addEventListener("error", () => { link.hidden = true; missing.hidden = false; });
        image.addEventListener("load", () => { missing.hidden = true; link.hidden = false; });
        image.src = previewPath;
        preview.append(link, missing);
        if (framePath) {
          const frameTime = data.frameTime;
          if (typeof frameTime === "number" && Number.isFinite(frameTime) && frameTime >= 0) {
            attachDetectionPreview(preview, link, image, previewPath, data.camera, data.objectId, frameTime);
          } else preview.append(el("div", "event-frame-caption", ht.t("events.objectSnapshot")));
        }
        body.append(preview);
      }
      if (view === "thumbnail" && data.thumbnailUrl) {
        const image = el("img", "event-thumb");
        image.src = String(data.thumbnailUrl);
        image.alt = ht.t("events.thumbAlt");
        image.loading = "lazy";
        const link = el("a");
        link.href = String(data.thumbnailUrl);
        link.target = "_blank";
        link.rel = "noreferrer";
        link.append(image);
        body.append(link);
      }
      const column = el("div");
      column.append(el("div", null, event.message));
      const facts = el("div", "event-facts");
      if (photoPath) {
        const link = el("a", "event-photo", ht.t("events.viewPhoto"));
        link.href = photoPath;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        facts.append(link);
        const capture = String(data.capturedAt || "").replace(/^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})$/, "$3-$1-$2 $4:$5:$6");
        fact(facts, ht.t("events.cameraTime"), capture);
      }
      if ((event.type === "camera_object" || event.type === "camera_classified") && typeof data.recordingUrl === "string") {
        try {
          const url = new URL(data.recordingUrl);
          if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash
            && /^\/(?:consoles\/[a-zA-Z0-9:_-]+\/)?protect\/timelapse\/[a-f0-9]{24}$/.test(url.pathname)
            && /^\?start=\d+$/.test(url.search)) {
            const link = el("a", "event-recording", ht.t("events.watchVideo"));
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = ht.t("events.watchVideoHint");
            facts.append(link);
          }
        } catch { /* Malformed event links are never actionable. */ }
      }
      if (view === "thumbnail") {
        fact(facts, ht.t("events.clip"), data.clipSeconds === undefined ? undefined : ht.t("events.seconds", { count: ht.number(data.clipSeconds) }));
        fact(facts, ht.t("events.loudness"), data.decibel === undefined ? undefined : ht.t("events.decibel", { count: ht.number(data.decibel) }));
        fact(facts, ht.t("events.cameraTime"), data.eventTime);
        fact(facts, ht.t("events.thumbnail"), data.bytes === undefined ? undefined : ht.t("events.kb", { count: ht.number(Math.round(Number(data.bytes) / 1024)) }));
      } else if (view === "request") {
        fact(facts, "", (data.method || "") + " " + (data.host || ""));
        fact(facts, ht.t("events.status"), data.status);
        fact(facts, ht.t("events.answeredBy"), data.relayed ? ht.t("events.relayed") : data.answeredBy);
        fact(facts, ht.t("events.sent"), data.responseBytes === undefined ? undefined : ht.t("events.bytes", { count: ht.number(data.responseBytes) }));
      } else if (view === "network") {
        fact(facts, "", data.name || data.serverName || data.destination);
        fact(facts, ht.t("events.port"), data.port);
        fact(facts, ht.t("events.resolver"), data.resolver);
        if (data.blocked) fact(facts, "", ht.t("events.blocked"));
        if (data.addresses && data.addresses.length) fact(facts, ht.t("events.answered"), data.addresses.join(", "));
      } else if (view === "properties" && Array.isArray(data.changed)) {
        column.append(el("div", "event-codes", data.changed.join(", ")));
      }
      if (facts.childElementCount > 0) column.append(facts);
      body.append(column);
      return body;
    };

    const renderRow = (event, isNew) => {
      const li = el("li", "event" + (isNew ? " is-new" : ""));
      li.dataset.level = String(event.level || "info");
      li.dataset.type = String(event.type || "");
      if (event.subject) li.dataset.subject = String(event.subject);
      const head = el("div", "event-head");
      if (event.level === "warn" || event.level === "error") {
        const mark = el("span", "mark");
        mark.dataset.availability = event.level === "error" ? "offline" : "degraded";
        mark.setAttribute("aria-hidden", "true");
        head.append(mark);
      }
      head.append(el("span", "event-at", ht.time(event.at)));
      head.append(el("span", "event-type", labels[event.type] || event.type));
      if (event.subject) {
        const subject = el(pages[event.subject] ? "a" : "span", "event-subject", names[event.subject] || event.subject);
        if (pages[event.subject]) subject.href = pages[event.subject];
        head.append(subject);
      }
      li.append(head, renderBody(event));
      return li;
    };

    const setConnected = (connected) => { if (live instanceof HTMLElement) live.dataset.connected = String(connected); };

    const initial = JSON.parse(root.querySelector("[data-event-seed]")?.textContent || '{"events":[]}');
    const eventKey = event => event.type === "photo_labeled" && event.data?.eventId ? "photo:" + event.data.eventId : event.at + "|" + event.type + "|" + event.message;
    const seen = new Set(initial.events.map(eventKey));
    let shown = initial.events.length;
    const setCount = () => { if (countLabel) countLabel.textContent = ht.t("services.count", { count: shown }); };
    const addEvent = (event, isNew, append = false) => {
      const key = eventKey(event);
      if (seen.has(key)) return;
      seen.add(key);
      const empty = list.querySelector(".empty");
      if (empty) empty.remove();
      if (append) list.append(renderRow(event, false));
      else list.insertBefore(renderRow(event, isNew), list.firstChild);
      shown += 1;
      if (!older) while (list.children.length > ${MAX_EVENT_ROWS}) list.removeChild(list.lastChild);
      setCount();
    };

    // One Event predicate describes the draft, history, pagination and live subscription.
    let condition = { all: [] };
    const query = () => "?where=" + encodeURIComponent(JSON.stringify(condition));

    let source = null;
    /** The query the live stream follows, once the history read for it landed. */
    let listening = null;
    let nextCursor = null;
    let loadGeneration = 0;
    let countsSubject = null;
    const setNextCursor = (cursor) => {
      nextCursor = typeof cursor === "string" ? cursor : null;
      if (older) older.hidden = !nextCursor;
    };
    const clear = () => {
      ++loadGeneration;
      listening = null;
      if (source) { source.close(); source = null; }
      setConnected(false);
      seen.clear(); shown = 0; list.replaceChildren(); setCount(); setNextCursor(null);
    };
    // The stream replays its matching backlog, closing the gap after the history read
    // (and after a hidden spell); rows already shown are skipped by their key.
    const listen = (generation, suffix) => {
      if (document.hidden) return;
      source = new EventSource(streamPath + suffix);
      source.addEventListener("open", () => { if (generation === loadGeneration) setConnected(true); });
      source.addEventListener("error", () => { if (generation === loadGeneration) setConnected(false); });
      source.addEventListener("service-event", (message) => {
        if (generation !== loadGeneration) return;
        setConnected(true);
        try { addEvent(JSON.parse(message.data), true); } catch {}
      });
      source.addEventListener("detection-labels", (message) => {
        if (generation !== loadGeneration) return;
        try { setDetectionCounts(JSON.parse(message.data)); } catch {}
      });
    };
    // A background tab must not hold one of the browser's six connections to this host.
    const pause = () => { if (source) { source.close(); source = null; setConnected(false); } };
    const resume = () => { if (!source && listening !== null && !document.hidden) listen(loadGeneration, listening); };
    document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); else resume(); });
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", resume);
    const load = async () => {
      clear();
      const generation = loadGeneration;
      const subject = JSON.stringify(readEventSelection(condition).subjects);
      if (subject !== countsSubject) { resetDetectionCounts(); countsSubject = subject; }
      if (older) older.disabled = false;
      const suffix = query();
      try {
        const payload = await ht.request(eventsPath + suffix);
        if (generation !== loadGeneration) return;
        setDetectionCounts(payload);
        setNextCursor(payload.nextCursor);
        for (const event of [...payload.events].reverse()) addEvent(event, false);
        if (!shown) list.append(el("li", "empty", ht.t("services.noEvents")));
        listening = suffix;
        listen(generation, suffix);
      } catch (error) {
        if (generation === loadGeneration) list.append(el("li", "empty", error.message));
      }
    };

    if (older instanceof HTMLButtonElement) older.addEventListener("click", () => {
      if (!nextCursor || older.disabled) return;
      const generation = loadGeneration;
      const suffix = query();
      older.disabled = true;
      ht.request(eventsPath + suffix + (suffix ? "&" : "?") + "before=" + encodeURIComponent(nextCursor)).then((payload) => {
        if (generation !== loadGeneration || !payload || !Array.isArray(payload.events)) return;
        for (const event of payload.events) addEvent(event, false, true);
        setNextCursor(payload.nextCursor);
      }).catch(() => {}).finally(() => { if (generation === loadGeneration) older.disabled = false; });
    });

    ${EVENT_FILTER_CONTROLS_SCRIPT}
    mountEventFilterControls({ root, subjectFilter, typeFilter, detectionFilter, addDetectionOptions, clear,
      apply: next => { condition = next; void load(); } });
  })();
`;

/**
 * The catalog the page's script needs to render each row: which view a type
 * wants, its human label, and each device's name. Carried as data attributes
 * so the script needs no second request before first paint.
 */
export function eventViewData(subjects: readonly EventSubjectView[], types: readonly EventTypeView[]): string {
  const views = Object.fromEntries(types.map((type) => [type.id, type.view]));
  const labels = Object.fromEntries(types.map((type) => [type.id, type.label]));
  const names = Object.fromEntries(subjects.map((subject) => [subject.id, subject.name]));
  return [
    `data-event-views="${escapeHtml(JSON.stringify(views))}"`,
    `data-event-labels="${escapeHtml(JSON.stringify(labels))}"`,
    `data-subject-names="${escapeHtml(JSON.stringify(names))}"`,
    `data-subject-pages="${escapeHtml(JSON.stringify(Object.fromEntries(subjects.flatMap(subject => subject.page ? [[subject.id, subject.page]] : []))))}"`,
  ].join(" ");
}

/** The two filter menus: which device, and which kind of event. */
export function renderEventFilters(ctx: PageContext, subjects: readonly EventSubjectView[], types: readonly EventTypeView[], options: { omitSubject?: boolean } = {}): string {
  const { t } = ctx.i18n;
  const subjectMenu = options.omitSubject || subjects.length === 0
    ? ""
    : `<div class="subject-filter"><span id="subject-filter-label">${escapeHtml(t("services.filter.device"))}</span>
      <details id="filter-subject" class="subject-dropdown"><summary aria-labelledby="subject-filter-label subject-selection"><span class="subject-selection" id="subject-selection">${escapeHtml(t("services.filter.all"))}</span></summary>
        <div class="subject-menu"><button type="button" class="btn btn-small" disabled>${escapeHtml(t("services.filter.all"))}</button>
          <div class="subject-options" role="group" aria-labelledby="subject-filter-label">${subjects.map(subject => `<label><input type="checkbox" name="event-subject" value="${escapeHtml(subject.id)}"><span>${escapeHtml(subject.name)}</span></label>`).join("")}</div>
        </div>
      </details></div>`;
  const typeMenu = types.length === 0
    ? ""
    : `<label>${escapeHtml(t("services.filter.event"))}<select id="filter-type"><option value="">${escapeHtml(t("services.filter.all"))}</option>${types.map((type) => `<option value="${escapeHtml(type.id)}" title="${escapeHtml(type.description)}">${escapeHtml(type.label)}</option>`).join("")}</select></label>`;
  return `${renderSavedFilterControls(ctx)}<div class="filters">${subjectMenu}${typeMenu}<span class="count" id="event-count"></span></div>`;
}

/**
 * A service's momentary actions: one button each, labelled from the catalog by
 * the action's own id (`link-button` → `services.action.linkButton`), falling
 * back to the id itself for an action no catalog has been taught yet. Nothing
 * here knows which service it is looking at.
 */
export const SERVICE_ACTIONS_SCRIPT = String.raw`
  (() => {
    const page = document.querySelector("[data-service-page]");
    if (!(page instanceof HTMLElement)) return;
    const serviceId = encodeURIComponent(page.dataset.serviceId || "");
    for (const panel of document.querySelectorAll("[data-service-action]")) {
      const button = panel.querySelector("button[data-action]");
      const remaining = panel.querySelector("[data-action-state]");
      const feedback = panel.querySelector("[data-action-feedback]");
      if (!(button instanceof HTMLButtonElement)) continue;
      let timer = null;
      // Counting down to a deadline the server already sent: the clock is local, nothing is re-fetched,
      // and it stops itself the moment the window lapses.
      const countDown = (until) => {
        if (timer) { clearInterval(timer); timer = null; }
        const at = Date.parse(until || "");
        const tick = () => {
          const left = Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
          if (remaining) remaining.textContent = left > 0 ? ht.t("services.action.remaining", { count: left }) : "";
          if (!button.disabled) { if (left > 0) button.dataset.state = "active"; else delete button.dataset.state; }
          if (left <= 0 && timer) { clearInterval(timer); timer = null; }
        };
        tick();
        if (Number.isFinite(at) && at > Date.now()) timer = setInterval(tick, 1000);
      };
      countDown(button.dataset.until);
      button.addEventListener("click", () => {
        const label = button.textContent;
        const held = button.dataset.state;
        button.disabled = true;
        button.dataset.state = "updating";
        ht.say(feedback, "");
        ht.request("/api/services/" + serviceId + "/actions/" + encodeURIComponent(button.dataset.action || ""), { method: "POST", body: "{}" })
          .then((payload) => {
            button.disabled = false;
            ht.say(feedback, (payload && payload.detail) || "", "ok");
            countDown(payload && payload.until);
          })
          .catch((error) => {
            button.disabled = false;
            if (held) button.dataset.state = held; else delete button.dataset.state;
            ht.say(feedback, ht.t("services.action.failed", { action: label, problem: error.message }), "bad");
          });
      });
    }
  })();
`;

const SERVICE_ACTIONS_CSS = String.raw`
  .service-action + .service-action { margin-block-start: var(--s3); }
  .service-action .bar { margin-block-end: 0; }
  .action-state { color: var(--fg-2); font-size: .875rem; font-variant-numeric: tabular-nums; }
`;

/** `link-button` → `services.action.linkButton`: the shape every key in the catalog has. */
function actionMessageKey(id: string): string {
  return `services.action.${id.replace(/-+([a-z0-9])/gu, (_match, character: string) => character.toUpperCase())}`;
}

/** Whole seconds left until `until`; zero when it has passed or was never set. */
function secondsUntil(until: string | undefined, now: number): number {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

/**
 * One control per action the service declares. What an action has standing
 * right now is rendered here, from the server's own reading, so the first paint
 * is already the truth and the script only counts it down.
 */
export function renderServiceActions(ctx: PageContext, actions: readonly ServiceActionView[], now = Date.now()): string {
  if (actions.length === 0) return "";
  const { t, lookup } = ctx.i18n;
  return actions.map((action) => {
    const left = secondsUntil(action.until, now);
    const active = left > 0 ? ` data-state="active" data-until="${escapeHtml(action.until!)}"` : "";
    return `<div class="service-action" data-service-action="${escapeHtml(action.id)}">
      <div class="bar">
        <button type="button" class="btn" data-action="${escapeHtml(action.id)}"${active}>${escapeHtml(lookup(actionMessageKey(action.id)) ?? action.id)}</button>
        <span class="action-state" data-action-state>${left > 0 ? escapeHtml(t("services.action.remaining", { count: left })) : ""}</span>
      </div>
      <p class="feedback" data-action-feedback></p>
    </div>`;
  }).join("");
}

const SERVICE_CONNECTIONS_CSS = String.raw`
  .connections { display: flex; flex-wrap: wrap; gap: var(--s3) var(--s5); margin-block: var(--s3); }
  .connections h3 { font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); margin: 0 0 var(--s1); }
  .conn-list { list-style: none; margin: 0; padding: 0; }
  .conn-list li { padding-block: .1rem; }
  .conn-list a { text-decoration: none; }
  .conn-list a:hover .conn-label { text-decoration: underline; }
  .conn-label { font-variant-numeric: tabular-nums; }
  .conn-detail { color: var(--fg-2); margin-inline-start: var(--s2); }
  .conn-list .mark { margin-inline-end: var(--s1); }
`;

/**
 * What a service is joined to, from its model: `in` is what connected to it, `out`
 * is what it reaches. Each carries the endpoint's own link when one exists, and a
 * live dot when it is carrying traffic now. A service that fronts nothing renders nothing.
 */
export function renderServiceEndpoints(ctx: PageContext, connections: RegisteredService["endpoints"]): string {
  if (connections.length === 0) return "";
  const { t } = ctx.i18n;
  const group = (direction: "in" | "out", heading: string): string => {
    const items = connections.filter((connection) => connection.direction === direction);
    if (items.length === 0) return "";
    const rows = items.map((connection) => {
      const dot = connection.active ? `<span class="mark" data-availability="online" title="${escapeHtml(t("services.connection.active"))}" aria-hidden="true"></span>` : "";
      const inner = `${dot}<span class="conn-label">${escapeHtml(connection.label)}</span>${connection.detail ? `<span class="conn-detail">${escapeHtml(connection.detail)}</span>` : ""}`;
      return `<li>${connection.href ? `<a href="${escapeHtml(connection.href)}">${inner}</a>` : inner}</li>`;
    }).join("");
    return `<div class="conn-group"><h3>${escapeHtml(heading)}</h3><ul class="conn-list">${rows}</ul></div>`;
  };
  return `<div class="connections">${group("in", t("services.connection.in"))}${group("out", t("services.connection.out"))}</div>`;
}

/** The "live" indicator next to an event log's heading. */
export function renderLiveIndicator(ctx: PageContext): string {
  return `<span class="live" id="live" data-connected="false"><span class="mark" aria-hidden="true"></span>${escapeHtml(ctx.i18n.t("services.live"))}</span>`;
}

/** The complete first page of events is HTML; the stream only supplies later changes. */
export function renderEventList(ctx: PageContext, events: readonly ServiceEvent[] = [], subjects: readonly EventSubjectView[] = [], types: readonly EventTypeView[] = []): string {
  const names = new Map(subjects.map(subject => [subject.id, subject]));
  const labels = new Map(types.map(type => [type.id, type.label]));
  const views = new Map(types.map(type => [type.id, type.view]));
  const rows = events.map(event => {
    const subject = event.subject ? names.get(event.subject) : undefined;
    const data = event.data ?? {}, view = views.get(event.type), t = ctx.i18n.t;
    const fields: [string, unknown][] = [];
    const fact = (label: string, value: unknown) => { if (value !== undefined && value !== null && value !== "") fields.push([label, value]); };
    if (view === "request") {
      fact("", `${data.method ?? ""} ${data.host ?? ""}`); fact(t("events.status"), data.status);
      fact(t("events.answeredBy"), data.relayed ? t("events.relayed") : data.answeredBy);
      fact(t("events.sent"), data.responseBytes === undefined ? undefined : t("events.bytes", { count: ctx.i18n.number(Number(data.responseBytes)) }));
    } else if (view === "network") {
      fact("", data.name || data.serverName || data.destination); fact(t("events.port"), data.port); fact(t("events.resolver"), data.resolver);
      if (data.blocked) fact("", t("events.blocked"));
      if (Array.isArray(data.addresses) && data.addresses.length) fact(t("events.answered"), data.addresses.join(", "));
    } else if (view === "thumbnail") {
      fact(t("events.clip"), data.clipSeconds === undefined ? undefined : t("events.seconds", { count: ctx.i18n.number(Number(data.clipSeconds)) }));
      fact(t("events.loudness"), data.decibel === undefined ? undefined : t("events.decibel", { count: ctx.i18n.number(Number(data.decibel)) }));
      fact(t("events.cameraTime"), data.eventTime);
      fact(t("events.thumbnail"), data.bytes === undefined ? undefined : t("events.kb", { count: ctx.i18n.number(Math.round(Number(data.bytes) / 1024)) }));
    }
    const photoPath = event.type === "photo_labeled" && data.source === "reveal" && /^[a-f0-9]{64}$/.test(String(data.photoId)) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(event.subject ?? "")
      ? `/api/cameras/${encodeURIComponent(event.subject!)}/photos/${data.photoId}` : undefined;
    const framePath = ["camera_object", "camera_classified"].includes(event.type) && data.source === "frigate" && [data.camera, data.objectId].every(value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))
      ? `/api/services/frigate/frames/${encodeURIComponent(String(data.camera))}/${encodeURIComponent(String(data.objectId))}${Number.isFinite(data.frameTime) ? `?at=${encodeURIComponent(String(data.frameTime))}` : ""}` : undefined;
    const imagePath = photoPath ?? framePath ?? (view === "thumbnail" && typeof data.thumbnailUrl === "string" && /^https?:\/\//.test(data.thumbnailUrl) ? data.thumbnailUrl : undefined);
    const preview = imagePath ? `<div class="event-preview"><a class="event-frame-link" href="${escapeHtml(imagePath)}" target="_blank" rel="noopener noreferrer"><img class="event-detection-image" src="${escapeHtml(imagePath)}" alt="${escapeHtml(t(photoPath ? "events.photoAlt" : "events.frameAlt"))}" loading="lazy" decoding="async"></a></div>` : "";
    const changed = view === "properties" && Array.isArray(data.changed) ? `<div class="event-codes">${escapeHtml(data.changed.join(", "))}</div>` : "";
    const facts = fields.map(([key, value]) => `<span>${escapeHtml(key)} <b>${escapeHtml(String(value))}</b></span>`).join(" ");
    return `<li class="event" data-level="${escapeHtml(event.level)}" data-type="${escapeHtml(event.type)}"${event.subject ? ` data-subject="${escapeHtml(event.subject)}"` : ""}><div class="event-head">${event.level === "info" ? "" : `<span class="mark" data-availability="${event.level === "error" ? "offline" : "degraded"}" aria-hidden="true"></span>`}<span class="event-at">${escapeHtml(ctx.i18n.time(event.at))}</span><span class="event-type">${escapeHtml(labels.get(event.type) ?? event.type)}</span>${event.subject ? subject?.page ? `<a class="event-subject" href="${escapeHtml(subject.page)}">${escapeHtml(subject.name)}</a>` : `<span class="event-subject">${escapeHtml(subject?.name ?? event.subject)}</span>` : ""}</div><div class="event-body">${preview}<div>${escapeHtml(event.message)}${changed}${facts ? `<div class="event-facts">${facts}</div>` : ""}</div></div></li>`;
  }).join("");
  const seed = { events, labelCounts: countDetectionLabels(events), nextCursor: events.length === 200 ? events.at(-1)?.at : undefined };
  return `<ul class="events" id="events">${rows || `<li class="empty">${escapeHtml(ctx.i18n.t("services.noEvents"))}</li>`}</ul><script type="application/json" nonce="${escapeHtml(ctx.nonce)}" data-event-seed>${JSON.stringify(seed).replaceAll("<", "\\u003c")}</script>`;
}

/** One service's status and a live tail of its events over Server-Sent Events (no polling). */
export function renderServicePage({ ctx, service, subjects = [], types = [], detectionLabels = [], actions = [], events = [] }: ServicePageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: service.title,
    nav: "services",
    mainAttributes: `data-service-page data-service-id="${escapeHtml(service.id)}" ${eventViewData(subjects, types)}`,
    body: `<h1>${escapeHtml(service.title)}</h1>
      ${subjects.some(subject => subject.page) ? `<p>${escapeHtml(t("relations.uses"))}: ${subjects.filter(subject => subject.page).map(subject => `<a href="${escapeHtml(subject.page!)}">${escapeHtml(subject.name)}</a>`).join(" · ")}</p>` : ""}
      <p class="status" data-availability="${escapeHtml(service.availability)}"><span class="mark" data-availability="${escapeHtml(service.availability)}" aria-hidden="true"></span>${escapeHtml(t(`status.${service.availability}`))} · ${escapeHtml(service.detail)}</p>
      ${renderServiceEndpoints(ctx, service.endpoints)}
      ${renderServiceActions(ctx, actions)}
      <h2>${escapeHtml(t("services.events"))} ${renderLiveIndicator(ctx)}</h2>
      ${renderEventFilters(ctx, subjects, service.id === "frigate" ? [] : types)}
      ${service.id === "frigate" ? `<fieldset id="filter-detections" class="detection-filter">
        <legend>${escapeHtml(t("services.filter.detection"))}</legend>
        <p class="hint">${escapeHtml(t("services.filter.detectionHint"))} <button type="button" class="subtle">${escapeHtml(t("services.filter.clear"))}</button></p>
        <p class="hint">${escapeHtml(t("services.filter.detectionCountsHint"))}</p>
        <div class="detection-options detection-matches">${detectionLabels.map(label => `<label><input type="checkbox" name="detection" value="${escapeHtml(label)}"><span class="detection-name">${escapeHtml(label)}</span><span class="detection-count" aria-hidden="true"></span></label>`).join("")}</div>
        <p class="hint detection-empty" hidden>${escapeHtml(t("services.filter.detectionEmpty"))}</p>
        <details class="detection-missing" hidden><summary></summary><div class="detection-options detection-absent"></div></details>
      </fieldset>` : ""}
      ${renderEventList(ctx, events, subjects, types)}
      ${service.id === "frigate" ? `<button type="button" id="events-older"${events.length < 200 ? " hidden" : ""}>${escapeHtml(t("services.older"))}</button>` : ""}`,
    css: `${service.endpoints.length === 0 ? "" : SERVICE_CONNECTIONS_CSS}${actions.length === 0 ? "" : SERVICE_ACTIONS_CSS}`,
    script: actions.length === 0 ? EVENT_LOG_SCRIPT : `${EVENT_LOG_SCRIPT}${SERVICE_ACTIONS_SCRIPT}`,
    messages: EVENT_LOG_MESSAGES,
  });
}
