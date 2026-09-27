import type { RegisteredDevice } from "../site";
import { escapeHtml, renderDeviceHead, renderPage, renderStatus, type PageContext } from "./shell";

export interface CameraPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  photoHistory?: boolean;
}

/** The same-origin routes used by the plain camera page. */
export const CAMERA_API = {
  /** The device's object document (`homeTruthObjectSchema`). */
  state: "/api/devices/:id",
  stream: "/api/cameras/:id/stream.mjpeg",
  snapshot: "/api/cameras/:id/snapshot",
  photos: "/api/cameras/:id/photos",
} as const;

const CAMERA_SCRIPT = String.raw`
  (() => {
    const root = document.querySelector("[data-camera-page]");
    if (!(root instanceof HTMLElement)) return;
    const id = encodeURIComponent(root.dataset.deviceId || "");
    const api = JSON.parse(root.dataset.api || "{}");
    const url = (route) => route.replace(":id", id);
    const status = document.querySelector("#camera-status");
    const image = document.querySelector("#viewer-image");
    const placeholder = document.querySelector("#viewer-placeholder");
    const feedback = document.querySelector("#feedback");
    const buttons = Array.from(document.querySelectorAll("button[data-action]"));
    const hasHistory = root.dataset.photoHistory === "true";
    let mode = "idle";
    let streamAvailable = false;
    let snapshotAvailable = false;
    const setStatus = (availability, text) => {
      if (!(status instanceof HTMLElement)) return;
      status.dataset.availability = availability;
      const mark = status.querySelector(".mark");
      if (mark instanceof HTMLElement) mark.dataset.availability = availability;
      const label = status.querySelector(".status-text");
      if (label instanceof HTMLElement) label.textContent = text;
    };
    const showImage = (source, alt) => {
      if (!(image instanceof HTMLImageElement)) return;
      image.alt = alt;
      image.src = source;
      image.hidden = false;
      if (placeholder instanceof HTMLElement) placeholder.hidden = true;
    };
    const live = () => { mode = "live"; showImage(url(api.stream) + "?t=" + Date.now(), ht.t("camera.liveAlt")); };
    const still = () => { mode = "still"; showImage(url(api.snapshot) + "?t=" + Date.now(), ht.t("camera.stillAlt")); };
    const stop = () => {
      mode = "idle";
      if (image instanceof HTMLImageElement) { image.removeAttribute("src"); image.hidden = true; }
      if (placeholder instanceof HTMLElement) placeholder.hidden = false;
    };
    const gallery = document.querySelector("#photo-gallery");
    const caption = document.querySelector("#photo-caption");
    const summary = document.querySelector("#photo-summary");
    const more = document.querySelector("#photo-more");
    const syncAll = document.querySelector("#photo-sync-all");
    const play = document.querySelector("#photo-play");
    const playStop = document.querySelector("#photo-play-stop");
    const speed = document.querySelector("#photo-speed");
    const playStatus = document.querySelector("#photo-play-status");
    let playing = false;
    let playTimer;
    let playGeneration = 0;
    let playPage = [];
    let playIndex = 0;
    let playCursor;
    let playStarted = false;
    let played = 0;
    const playCursors = new Set();
    const pausePlayback = () => {
      playing = false;
      playGeneration++;
      clearTimeout(playTimer);
      if (play) { play.textContent = ht.t(playStarted ? "camera.photosResume" : "camera.photosPlay"); play.setAttribute("aria-pressed", "false"); }
    };
    const stopPlayback = () => {
      playStarted = false;
      pausePlayback();
      playPage = []; playIndex = 0; playCursor = undefined; played = 0; playCursors.clear();
      if (playStop) playStop.hidden = true;
    };
    let nextCursor;
    let selected;
    let expanded = false;
    let loadingPhotos = false;
    const cameraTime = (value) => {
      const raw = String(value);
      const match = /^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})?$/.exec(raw);
      return match ? match[3] + "-" + match[1] + "-" + match[2] + " " + match[4] + ":" + match[5] + (match[6] ? ":" + match[6] : "") : raw;
    };
    const photoLabel = (photo) => photo.capturedAt != null
      ? ht.t("camera.photoCaptured", { time: cameraTime(photo.capturedAt) })
      : ht.t("camera.photoTimeUnknown");
    const photoUrl = (photo) => url(api.photos) + "/" + encodeURIComponent(photo.id);
    const labelText = (photo) => {
      const labeling = photo.labeling;
      if (!labeling) return "";
      if (labeling.status !== "complete") return ht.t(labeling.status === "retrying" ? "camera.labelsRetrying" : "camera.labelsPending");
      const result = labeling.result;
      const classification = result?.classification;
      if (classification) {
        const label = classification.label === "blank" ? ht.t("camera.labelsNoDetection") : classification.label;
        return ht.t(classification.uncertain ? "camera.labelsPossible" : "camera.labelsPrediction", { label, score: Math.round(classification.score * 100) });
      }
      return [...new Set((result?.detections || []).map(item => item.label))].join(", ") || ht.t("camera.labelsNoDetection");
    };
    const selectPhoto = (photo) => {
      selected = photo.id;
      mode = "photo";
      showImage(photoUrl(photo), photoLabel(photo));
      if (caption) {
        caption.replaceChildren();
        const label = document.createElement("span");
        label.textContent = photoLabel(photo) + (photo.uploadedAt != null ? " · " + ht.t("camera.photoUploaded", { time: new Date(photo.uploadedAt).toLocaleString() }) : "");
        const download = document.createElement("a");
        download.href = photoUrl(photo);
        download.download = photo.id + ".jpg";
        download.textContent = ht.t("camera.photoDownload");
        caption.append(label, document.createTextNode(" · "), download);
        if (photo.labeling) {
          const labels = document.createElement("span");
          labels.textContent = " · " + labelText(photo);
          if (photo.labeling.result) labels.title = photo.labeling.result.engine + " · " + photo.labeling.result.model;
          caption.append(labels);
        }
      }
      gallery?.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.photoId === selected)));
    };
    const advancePlayback = async (generation) => {
      try {
        while (playIndex >= playPage.length) {
          if (playStarted && !playCursor) {
            stopPlayback();
            ht.say(playStatus, ht.t("camera.photosFinished"));
            return;
          }
          const requestedCursor = playCursor;
          const payload = await ht.request(url(api.photos) + "?order=oldest" + (requestedCursor ? "&cursor=" + encodeURIComponent(requestedCursor) : ""));
          if (!playing || generation !== playGeneration) return;
          if (requestedCursor) playCursors.add(requestedCursor);
          if (payload.nextCursor && playCursors.has(payload.nextCursor)) throw new Error(ht.t("camera.photosPlaybackFailed"));
          playPage = payload.photos; playIndex = 0; playCursor = payload.nextCursor; playStarted = true;
        }
        const photo = playPage[playIndex];
        const preload = new Image();
        preload.src = photoUrl(photo);
        await preload.decode();
        if (!playing || generation !== playGeneration) return;
        selectPhoto(photo);
        playIndex++; played++;
        ht.say(playStatus, ht.t("camera.photosPlaying", { count: played }));
        playTimer = setTimeout(() => void advancePlayback(generation), Number(speed?.value || 2) * 1000);
      } catch (error) {
        if (generation !== playGeneration) return;
        pausePlayback();
        ht.say(playStatus, error instanceof Error ? error.message : ht.t("camera.photosPlaybackFailed"), "bad");
      }
    };
    play?.addEventListener("click", () => {
      if (playing) { pausePlayback(); return; }
      playing = true;
      play.textContent = ht.t("camera.photosPause");
      play.setAttribute("aria-pressed", "true");
      if (playStop) playStop.hidden = false;
      void advancePlayback(++playGeneration);
    });
    playStop?.addEventListener("click", () => { stopPlayback(); ht.say(playStatus, ""); });
    window.addEventListener("pagehide", stopPlayback, { once: true });
    const refreshPhotos = async (append = false) => {
      if (loadingPhotos) return;
      loadingPhotos = true;
      if (more) more.disabled = true;
      try {
        const payload = await ht.request(url(api.photos) + (append && nextCursor ? "?cursor=" + encodeURIComponent(nextCursor) : ""));
        if (!append) { gallery?.replaceChildren(); expanded = false; }
        else expanded = true;
        for (const photo of payload.photos) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.photoId = photo.id;
          button.setAttribute("aria-pressed", String(selected === photo.id));
          const thumbnail = document.createElement("img");
          thumbnail.src = photoUrl(photo);
          thumbnail.alt = "";
          thumbnail.loading = "lazy";
          const label = document.createElement("span");
          label.textContent = photoLabel(photo);
          button.append(thumbnail, label);
          if (photo.labeling) {
            const labels = document.createElement("span");
            labels.className = "photo-labels";
            labels.textContent = labelText(photo);
            button.append(labels);
          }
          button.addEventListener("click", () => { stopPlayback(); ht.say(playStatus, ""); selectPhoto(photo); });
          item.append(button);
          gallery?.append(item);
        }
        nextCursor = payload.nextCursor;
        if (more) more.hidden = !nextCursor;
        if (!selected && payload.photos[0]) selectPhoto(payload.photos[0]);
        else if (!playing) {
          const current = payload.photos.find(photo => photo.id === selected);
          if (current) selectPhoto(current);
        }
        const sync = payload.sync;
        const bits = [ht.t("camera.photoCount", { count: payload.total })];
        if (sync.running) bits.push(ht.t("camera.photosSyncing"));
        if (sync.continuing) bits.push(ht.t("camera.photosContinuing", { count: sync.pagesScanned || 0 }));
        if (sync.fullSyncQueued) bits.push(ht.t("camera.photosQueued"));
        if (payload.labeling) {
          bits.push(ht.t("camera.labelsProgress", { count: payload.labeling.completed, total: payload.total }));
          if (payload.labeling.retrying) bits.push(ht.t("camera.labelsRetryCount", { count: payload.labeling.retrying }));
        }
        if (syncAll) syncAll.disabled = sync.running || sync.continuing || sync.fullSyncQueued;
        if (sync.lastSuccessAt) bits.push(ht.t("camera.photosChecked", { time: new Date(sync.lastSuccessAt).toLocaleString() }));
        if (sync.nextCheckAt) bits.push(ht.t("camera.photosNext", { time: new Date(sync.nextCheckAt).toLocaleTimeString() }));
        if (summary) summary.textContent = bits.join(" · ");
        setStatus(sync.error ? "degraded" : sync.lastSuccessAt ? "online" : "unknown", ht.t(sync.error ? "camera.photosPaused" : "camera.photosCloud"));
        ht.say(feedback, sync.error || "", sync.error ? "bad" : undefined);
      } catch (error) {
        ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.noResponse"), "bad");
      } finally { loadingPhotos = false; if (more) more.disabled = false; }
    };
    syncAll?.addEventListener("click", async () => {
      syncAll.disabled = true;
      try {
        await ht.request(url(api.photos) + "/sync", { method: "POST", body: "{}" });
        await refreshPhotos();
      } catch (error) {
        ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.noResponse"), "bad");
        syncAll.disabled = false;
      }
    });
    more?.addEventListener("click", () => void refreshPhotos(true));
    if (image instanceof HTMLImageElement) {
      image.addEventListener("error", () => {
        if (hasHistory) pausePlayback();
        ht.say(feedback, ht.t(mode === "live" ? "camera.liveFailed" : "camera.snapshotFailed"), "bad");
        stop();
      });
    }
    const refresh = async () => {
      try {
        const payload = await ht.request(url(api.state));
        const object = payload && payload.object ? payload.object : null;
        const camera = object && object.capabilities ? object.capabilities.camera : null;
        const availability = camera && camera.state ? camera.state.availability : "unknown";
        streamAvailable = camera?.state?.streamAvailable === true;
        snapshotAvailable = camera?.state?.snapshotAvailable === true;
        for (const button of buttons) {
          if (button.dataset.action === "live") button.hidden = !streamAvailable;
          if (button.dataset.action === "snapshot") button.disabled = !snapshotAvailable;
        }
        const bits = [ht.availability(availability)];
        if (object && object.model) bits.push(object.model);
        if (object && object.firmwareVersion) bits.push(ht.t("camera.firmware", { version: object.firmwareVersion }));
        setStatus(availability, bits.join(" · "));
        ht.say(feedback, "");
        return availability;
      } catch (error) {
        ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.noResponse"), "bad");
        return "unknown";
      }
    };
    // A live view is a connection held open; a background tab must not keep one of the
    // browser's six connections to this host. It comes back on its own when shown.
    const pauseLive = () => { if (mode === "live" && image instanceof HTMLImageElement) image.removeAttribute("src"); };
    const resumeLive = () => { if (mode === "live" && !document.hidden) live(); };
    document.addEventListener("visibilitychange", () => { if (document.hidden) pauseLive(); else resumeLive(); });
    window.addEventListener("pagehide", pauseLive);
    window.addEventListener("pageshow", resumeLive);
    for (const button of buttons) {
      button.addEventListener("click", () => {
        const action = button.dataset.action;
        if (action === "live") live();
        if (action === "snapshot") still();
        if (action === "stop") stop();
        if (action === "refresh") void (hasHistory ? refreshPhotos() : refresh());
      });
    }
    if (hasHistory) {
      void refreshPhotos();
      const timer = setInterval(() => { if (!document.hidden && !expanded && !playing) void refreshPhotos(); }, 30_000);
      window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
    } else void refresh().then(() => { if (streamAvailable) live(); else if (snapshotAvailable) still(); });
  })();
`;

/** A live view, a still picture, and the status line for a device whose only capability is a camera. */
export function renderCameraPage({ ctx, device, photoHistory = false }: CameraPageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: device.name,
    nav: "devices",
    mainAttributes: `data-camera-page data-device-id="${escapeHtml(device.id)}" data-photo-history="${photoHistory}" data-api="${escapeHtml(JSON.stringify(CAMERA_API))}"`,
    body: `${renderDeviceHead(ctx, device, "controls")}
      <p>${renderStatus(ctx, "unknown", { id: "camera-status" })}</p>
      <div class="stage" id="viewer">
        <img id="viewer-image" alt="" hidden>
        <span class="placeholder" id="viewer-placeholder">${escapeHtml(t("camera.noPicture"))}</span>
      </div>
      ${photoHistory ? `<p id="photo-caption" class="photo-caption"></p>` : ""}
      <div class="bar" role="toolbar" aria-label="${escapeHtml(t("camera.controls"))}">
        ${photoHistory ? `
          <button type="button" class="btn btn-primary" id="photo-play" aria-pressed="false">${escapeHtml(t("camera.photosPlay"))}</button>
          <button type="button" class="btn" id="photo-play-stop" hidden>${escapeHtml(t("action.stop"))}</button>
          <label for="photo-speed">${escapeHtml(t("camera.photosSpeed"))}</label>
          <select id="photo-speed"><option value="0.5">0.5 s</option><option value="1">1 s</option><option value="2" selected>2 s</option><option value="5">5 s</option><option value="10">10 s</option></select>
        ` : ""}
        ${photoHistory ? "" : `
        <button type="button" class="btn btn-primary" data-action="live" hidden>${escapeHtml(t("camera.live"))}</button>
        <button type="button" class="btn" data-action="snapshot" disabled>${escapeHtml(t("camera.snapshot"))}</button>
        <button type="button" class="btn" data-action="stop">${escapeHtml(t("action.stop"))}</button>`}
        <button type="button" class="btn" data-action="refresh">${escapeHtml(t("action.refresh"))}</button>
        ${photoHistory ? `<button type="button" class="btn" id="photo-sync-all">${escapeHtml(t("camera.photosFetchAll"))}</button>` : ""}
      </div>
      ${photoHistory ? `<p id="photo-play-status" role="status" aria-live="polite"></p>` : ""}
      <p class="feedback" id="feedback" role="status" aria-live="polite"></p>
      ${photoHistory ? `<section aria-label="${escapeHtml(t("camera.photos"))}">
        <h2>${escapeHtml(t("camera.photos"))}</h2>
        <p>${escapeHtml(t("camera.photosDescription"))}</p>
        <p id="photo-summary" role="status" aria-live="polite">${escapeHtml(t("camera.photosWaiting"))}</p>
        <ul id="photo-gallery" class="photo-gallery"></ul>
        <button class="btn" type="button" id="photo-more" hidden>${escapeHtml(t("camera.photosMore"))}</button>
      </section>` : ""}`,
    css: `.photo-caption { font-size: .875rem; color: var(--fg-2); }
      .photo-gallery { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--s2); }
      .photo-gallery button { width: 100%; cursor: pointer; padding: 0; background: var(--bg); color: inherit; border: 2px solid var(--rule); text-align: start; }
      .photo-gallery button[aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: 2px; }
      .photo-gallery img { width: 100%; aspect-ratio: 16/9; object-fit: contain; display: block; background: #111; }
      .photo-gallery span { display: block; font-size: .8125rem; padding: .5rem; }`,
    script: CAMERA_SCRIPT,
    messages: ["camera."],
  });
}
