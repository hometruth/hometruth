import type { DogAnnouncer } from "../automations/dog-announcer";
import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import type { HomeTruthObject } from "../schemas";
import { automationNode } from "../state/protocol";
import { escapeHtml, htElement, renderPage, type PageContext } from "./shell";

export type DogPageData = ReturnType<DogAnnouncer["view"]> & { cameras: readonly RegisteredDevice[]; speakers: readonly RegisteredDevice[] };
export function renderDogAutomationPage(ctx: PageContext, servicePage: string | undefined, data: DogPageData): string {
  const { t } = ctx.i18n;
  const volume = (ctx.state.snapshot([deviceNode(data.config.speakerId)])[0]?.value as HomeTruthObject | undefined)?.capabilities?.speaker?.state;
  const volumeKnown = typeof volume?.volumePercent === "number";
  const options = (devices: readonly RegisteredDevice[], selected: string, placeholder: string) => `<option value="">${escapeHtml(placeholder)}</option>${devices.map(device => `<option value="${escapeHtml(device.id)}"${device.id === selected ? " selected" : ""}>${escapeHtml(device.name)}</option>`).join("")}`;
  const label = (key: Parameters<typeof t>[0]) => escapeHtml(t(key));
  return renderPage({
    ctx, title: t("dog.title"), nav: "automations",
    css: `.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0 var(--s4); }`,
    nodes: [automationNode("dog-announcer"), ...data.speakers.map(speaker => deviceNode(speaker.id))],
    body: `<script type="application/json" nonce="${escapeHtml(ctx.nonce)}" data-dog-state>${JSON.stringify(data).replaceAll("<", "\\u003c")}</script><div class="page-head"><h1>${label("dog.title")}</h1><a href="${escapeHtml(servicePage ?? "/services")}">${label("dog.log")}</a></div>
      <p class="note">${label("dog.intro")}</p>
      ${htElement(ctx, "ht-switch", automationNode("dog-announcer"))}
      <h2>${label("dog.rule")}</h2>
      <p>${label("dog.anyDog")}</p>
      <div class="fields">
        <label class="field"><span>${label("dog.camera")}</span><select id="camera">${options(data.cameras, data.config.cameraId, t("dog.chooseCamera"))}</select></label>
        <label class="field"><span>${label("dog.speaker")}</span><select id="speaker">${options(data.speakers, data.config.speakerId, t("dog.chooseSpeaker"))}</select></label>
        <label class="field"><span>${label("dog.text")}</span><input id="text" maxlength="100" value="${escapeHtml(data.config.text)}"></label>
      </div>
      <p class="note">${label("dog.timing")}</p>
      <p class="note">${label("dog.frameRate")}</p>
      <section aria-labelledby="video-heading">
        <div class="page-head"><h2 id="video-heading">${label("dog.videoTitle")}</h2><a id="camera-link" hidden>${label("dog.openCamera")}</a></div>
        <div class="stage" id="video-stage" style="--stage-aspect: 4 / 3">
          <img id="video-image" alt="${label("dog.videoAlt")}" hidden>
          <span class="placeholder" id="video-placeholder">${label("dog.loading")}</span>
        </div>
        <div class="bar">
          <button type="button" id="video-toggle" class="btn" disabled>${label("dog.videoPause")}</button>
          <button type="button" id="video-refresh" class="btn" disabled>${label("action.refresh")}</button>
          <span id="video-status" class="muted small" role="status" aria-live="polite"></span>
        </div>
      </section>
      <div class="field">
        <label class="field-value" for="speaker-volume">${label("dog.volume")} <output id="volume-value" for="speaker-volume">${volumeKnown ? escapeHtml(ctx.i18n.number(volume!.volumePercent! / 100, { style: "percent" })) : "—"}</output></label>
        <input id="speaker-volume" type="range" min="0" max="100" step="1" value="${volume?.volumePercent ?? 0}"${volumeKnown ? "" : " disabled"}>
        <p class="note" id="volume-note" role="status">${label(volumeKnown ? volume?.muted ? "dog.muted" : "dog.volumeApplies" : "dog.volumeUnavailable")}</p>
      </div>
      <div class="bar"><button id="save" class="btn btn-primary">${label("dog.save")}</button><button id="preview" class="btn">${label("dog.check")}</button></div>
      <p id="feedback" class="feedback" role="status" aria-live="polite">${escapeHtml(data.status.detail)}</p>
      <p id="result" role="status">${data.last ? escapeHtml(t(data.last.dog ? "dog.detected" : "dog.notDetected", { ms: ctx.i18n.number(data.last.elapsedMs) })) : ""}</p>
      <p class="note">${label("dog.speechNote")}</p>`,
    script: DOG_SCRIPT, messages: ["dog.", "speaker."],
  });
}

const DOG_SCRIPT = String.raw`
(() => {
  const $ = id => document.getElementById(id);
  const feedback = (text, tone) => ht.say($("feedback"), text, tone);
  const shipped = JSON.parse(document.querySelector("[data-dog-state]").textContent);
  let config = shipped.config, busy = false, polling = false, resultUntil = 0;
  let cameras = shipped.cameras, videoWanted = true, videoUrl;
  const videoImage = $("video-image"), videoPlaceholder = $("video-placeholder");
  function stopVideo() {
    videoUrl = undefined;
    videoImage.removeAttribute("src"); videoImage.hidden = true;
  }
  function showVideo() {
    stopVideo();
    const camera = cameras.find(item => item.id === $("camera").value);
    $("camera-link").hidden = !camera?.page;
    if (camera?.page) $("camera-link").href = camera.page;
    $("video-toggle").disabled = $("video-refresh").disabled = !camera;
    $("video-toggle").textContent = ht.t(videoWanted ? "dog.videoPause" : "dog.videoResume");
    videoPlaceholder.hidden = false;
    videoPlaceholder.textContent = ht.t(!camera ? "dog.chooseCamera" : videoWanted ? "dog.loading" : "dog.videoPaused");
    $("video-status").textContent = "";
    if (!camera || !videoWanted || document.hidden) return;
    videoImage.hidden = false;
    videoImage.src = videoUrl = "/api/automations/dog-announcer/stream.mjpeg?cameraId=" + encodeURIComponent(camera.id) + "&t=" + Date.now();
  }
  videoImage.onload = () => {
    if (!videoUrl) return;
    videoPlaceholder.hidden = true;
    $("video-stage").style.setProperty("--stage-aspect", videoImage.naturalWidth + " / " + videoImage.naturalHeight);
    $("video-status").textContent = ht.t("dog.videoLive");
  };
  videoImage.onerror = () => {
    if (!videoUrl) return;
    stopVideo(); videoPlaceholder.hidden = false; videoPlaceholder.textContent = ht.t("dog.videoFailed");
    $("video-status").textContent = "";
  };
  $("video-toggle").onclick = () => { videoWanted = !videoWanted; showVideo(); };
  $("video-refresh").onclick = () => { videoWanted = true; showVideo(); };
  $("camera").onchange = showVideo;
  document.addEventListener("visibilitychange", () => { if (config) showVideo(); });
  window.addEventListener("pagehide", stopVideo);
  window.addEventListener("pageshow", () => { if (config) showVideo(); });
  function controls() {
    for (const id of ["camera", "speaker", "text", "save", "preview"]) $(id).disabled = busy || !config;
    volumeDisabled();
  }
  let volumeReady = false, volumeBusy = false, volumeRevision = 0;
  function volumeDisabled() { $("speaker-volume").disabled = busy || volumeBusy || !volumeReady; }
  const percent = (value) => ht.number(value / 100, { style: "percent" });
  function showVolume(body) {
    const state = body.object?.capabilities?.speaker?.state;
    if (state?.availability !== "online" || !Number.isFinite(state.volumePercent)) throw new Error(ht.t("dog.volumeUnavailable"));
    $("speaker-volume").value = state.volumePercent; $("volume-value").textContent = percent(state.volumePercent);
    $("volume-note").textContent = state.muted ? ht.t("dog.muted") : ht.t("dog.volumeApplies");
    volumeReady = true;
  }
  let releaseVolume;
  function loadVolume() {
    ++volumeRevision;
    releaseVolume?.();
    const speakerId = $("speaker").value;
    const subscribe = () => {
      if (!ht.state) { requestAnimationFrame(subscribe); return; }
      releaseVolume = ht.state.subscribe("device/" + speakerId, record => {
        if (volumeBusy) return;
        try { showVolume({ object: record?.value }); }
        catch { volumeReady = false; $("volume-note").textContent = ht.t("dog.volumeUnavailable"); }
        volumeDisabled();
      }, "live");
    };
    subscribe();
  }
  $("speaker").onchange = loadVolume;
  $("speaker-volume").oninput = () => { $("volume-value").textContent = percent(Number($("speaker-volume").value)); };
  $("speaker-volume").onchange = async () => {
    if (!volumeReady || volumeBusy || busy) return;
    const revision = volumeRevision, speakerId = $("speaker").value, value = Number($("speaker-volume").value);
    volumeBusy = true; volumeDisabled(); $("volume-note").textContent = ht.t("dog.settingVolume");
    try {
      const body = await ht.request("/api/devices/" + encodeURIComponent(speakerId) + "/capabilities/speaker/controls/setVolume", { method: "POST", body: JSON.stringify({ value }) });
      if (revision === volumeRevision) showVolume(body);
    } catch (error) { if (revision === volumeRevision) { volumeReady = false; $("volume-note").textContent = error.message + " " + ht.t("dog.reselect"); } }
    finally { if (revision === volumeRevision) { volumeBusy = false; volumeDisabled(); } }
  };
  function input() { return { ...config, cameraId: $("camera").value, speakerId: $("speaker").value, text: $("text").value }; }
  function showResult(result) {
    $("result").textContent = result ? ht.t(result.dog ? "dog.detected" : "dog.notDetected", { ms: ht.number(result.elapsedMs) }) : "";
  }
  async function action(kind) {
    if (busy || !config) return;
    busy = true; controls();
    feedback(ht.t(kind === "preview" ? "dog.checking" : "dog.saving"));
    try {
      const path = "/api/automations/dog-announcer" + (kind === "save" ? "" : "/" + kind);
      const result = await ht.request(path, { method: kind === "preview" ? "POST" : "PUT", body: JSON.stringify(input()) });
      if (kind === "preview") { showResult(result); feedback(ht.t("dog.checkDone"), "ok"); }
      else { config = result.config; showResult(result.last); feedback(result.status.detail, result.status.availability === "degraded" ? "bad" : "ok"); }
    } catch (error) { feedback(error.message, "bad"); }
    finally { resultUntil = Date.now() + 5000; busy = false; controls(); }
  }
  $("save").onclick = () => action("save");
  $("preview").onclick = () => action("preview");
  setInterval(async () => {
    if (!config || busy || polling || document.hidden || Date.now() < resultUntil) return;
    polling = true;
    try {
      const state = await ht.request("/api/automations/dog-announcer");
      if (busy || Date.now() < resultUntil) return;
      if ($("camera").value === state.config.cameraId) showResult(state.last);
      feedback(state.status.detail, state.status.availability === "degraded" ? "bad" : "ok");
    } catch (error) { if (!busy) feedback(error.message, "bad"); }
    finally { polling = false; }
  }, 1000);
  loadVolume(); showVideo();

})();`;
