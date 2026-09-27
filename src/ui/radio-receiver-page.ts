import type { RegisteredDevice } from "../site";
import { TMNT_SESSION_PLAN } from "../protocols/nrf24-bridge/session-plan";
import { escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";

export const RADIO_RECEIVER_API = {
  state: "/api/radio-receivers/:id",
  start: "/api/radio-receivers/:id/start",
  stop: "/api/radio-receivers/:id/stop",
  quiet: "/api/radio-receivers/:id/quiet",
  save: "/api/radio-receivers/:id/codes",
  send: "/api/radio-receivers/:id/codes/:codeId/send",
  delete: "/api/radio-receivers/:id/codes/:codeId/delete",
} as const;

const RADIO_RECEIVER_SCRIPT = String.raw`
(() => {
  const root = document.querySelector("[data-radio-receiver-page]");
  if (!(root instanceof HTMLElement)) return;
  const id = encodeURIComponent(root.dataset.deviceId || "");
  const api = JSON.parse(root.dataset.api || "{}");
  const url = (route, codeId) => route.replace(":id", id).replace(":codeId", encodeURIComponent(codeId || ""));
  const mark = document.querySelector("#state-mark");
  const label = document.querySelector("#state-label");
  const detail = document.querySelector("#state-detail");
  const config = document.querySelector("#radio-config");
  const observations = document.querySelector("#radio-observations");
  const empty = document.querySelector("#observations-empty");
  const feedback = document.querySelector("#listener-feedback");
  const scan = document.querySelector("#listener-scan");
  const sweep = document.querySelector("#listener-sweep");
  const sweepStatus = document.querySelector("#sweep-status");
  const quietOff = document.querySelector("#quiet-off");
  const quietOn = document.querySelector("#quiet-on");
  const quietStatus = document.querySelector("#quiet-status");
  const quietProfile = document.querySelector("#quiet-profile");
  const quietChannel = document.querySelector("#quiet-channel");
  const quietDuration = document.querySelector("#quiet-duration");
  const sessionStart = document.querySelector("#session-start");
  const sessionReady = document.querySelector("#session-ready");
  const sessionCue = document.querySelector("#session-cue");
  const sessionPlan = JSON.parse(root.dataset.sessionPlan || "{}");
  let sessionStatus;
  const showSessionCue = () => {
    if (!sessionCue || sessionStatus?.session !== sessionPlan.id) return;
    const quiet = sessionStatus;
    let message;
    if (quiet.phase === "capturing") {
      const age = Date.now() - Date.parse(quiet.updatedAt);
      if (!Number.isFinite(age) || age < 0 || age > 3000) message = ht.t("radioReceiver.session.stale");
      else {
        // Interpolate between 1 Hz firmware reports, not the request-click time.
        // These are approximate cues; the log never claims measured button edges.
        const elapsed = (quiet.elapsedMs || 0) + age;
        const step = sessionPlan.steps.find(step => elapsed >= step.startMs && elapsed < step.endMs);
        message = step ? ht.t("radioReceiver.session.cue", {
          action: ht.t("radioReceiver.session." + step.action),
          seconds: Math.ceil((step.endMs - elapsed) / 1000),
        }) : ht.t("radioReceiver.session.finished");
      }
    } else message = ht.t(["preparing", "starting"].includes(quiet.phase)
      ? "radioReceiver.session.wait" : "radioReceiver.session.finished");
    if (sessionCue.textContent !== message) sessionCue.textContent = message;
  };
  const cueTimer = setInterval(showSessionCue, 100);
  const repeatedAddresses = document.querySelector("#repeated-addresses");
  const capture = document.querySelector("#listener-capture");
  const stop = document.querySelector("#listener-stop");
  const channel = document.querySelector("#capture-channel");
  const crc = document.querySelector("#capture-crc");
  const selected = document.querySelector("#selected-packet");
  const name = document.querySelector("#code-name");
  const save = document.querySelector("#code-save");
  const codes = document.querySelector("#saved-codes");
  const codesEmpty = document.querySelector("#saved-codes-empty");
  const recordBaseline = document.querySelector("#record-baseline");
  const measureRemote = document.querySelector("#measure-remote");
  const candidates = document.querySelector("#channel-candidates");
  const recording = document.querySelector("#capture-recording");
  const captureNote = document.querySelector("#capture-note");
  let selectedSequence;
  let baselineTotals;
  let timer;
  let busy = false;
  let bridgeLive = false;

  const field = (parent, termText, value) => {
    const term = document.createElement("dt"); term.textContent = termText;
    const description = document.createElement("dd"); description.textContent = value;
    parent.append(term, description);
  };
  const button = (text, className, action) => {
    const element = document.createElement("button");
    element.type = "button"; element.className = className; element.textContent = text;
    element.disabled = busy || !bridgeLive; element.addEventListener("click", action); return element;
  };
  const request = async (route, body = {}, codeId) => {
    const note = captureNote instanceof HTMLInputElement ? captureNote.value.trim() : "";
    return ht.request(url(route, codeId), { method: "POST", body: JSON.stringify({ ...body, ...((route === api.start || route === api.quiet) ? { note } : {}) }) });
  };
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const sampleEnergy = async (messageKey) => {
    const first = await ht.request(url(api.state));
    let sequence = first.sequence;
    const totals = new Map();
    const endsAt = Date.now() + 15000;
    while (Date.now() < endsAt) {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      ht.say(feedback, ht.t(messageKey, { seconds: ht.number(remaining) }));
      await sleep(750);
      const state = await ht.request(url(api.state));
      for (const observation of state.observations || []) {
        if (observation.sequence <= sequence || observation.kind !== "energy") continue;
        const value = totals.get(observation.channel) || { hits: 0, events: 0 };
        value.hits += observation.hits || 0; value.events += 1; totals.set(observation.channel, value);
      }
      sequence = Math.max(sequence, state.sequence);
    }
    return totals;
  };
  const showCandidates = (measured) => {
    if (!(candidates instanceof HTMLElement) || !baselineTotals) return;
    const ranked = [...measured].map(([candidateChannel, value]) => {
      const baseline = baselineTotals.get(candidateChannel) || { hits: 0, events: 0 };
      return { channel: candidateChannel, extraHits: value.hits - baseline.hits, extraEvents: value.events - baseline.events };
    }).filter((entry) => entry.extraHits > 0).sort((left, right) => right.extraHits - left.extraHits || right.extraEvents - left.extraEvents).slice(0, 10);
    candidates.replaceChildren();
    for (const candidate of ranked) {
      const item = document.createElement("li"); item.className = "row";
      const title = document.createElement("span"); title.className = "row-name";
      title.textContent = ht.t("radioReceiver.candidateChannel", { channel: ht.number(candidate.channel) });
      const meta = document.createElement("span"); meta.className = "row-meta";
      meta.textContent = ht.t("radioReceiver.candidateDelta", { hits: ht.number(candidate.extraHits), events: ht.number(candidate.extraEvents) });
      const chooseChannel = button(ht.t("radioReceiver.useChannel"), "btn btn-primary", () => {
        if (busy) return;
        if (channel instanceof HTMLInputElement) channel.value = String(candidate.channel);
        ht.say(feedback, ht.t("radioReceiver.channelSelected", { channel: ht.number(candidate.channel) }), "ok");
      });
      item.append(title, meta, chooseChannel); candidates.append(item);
    }
    if (ranked.length === 0) {
      const item = document.createElement("li"); item.className = "empty"; item.textContent = ht.t("radioReceiver.noCandidates"); candidates.append(item);
    }
  };
  const measure = async (kind) => {
    if (busy) return;
    busy = true; clearTimeout(timer);
    try {
      render(await request(api.start, { mode: "energy" }));
      const totals = await sampleEnergy(kind === "baseline" ? "radioReceiver.baselineCountdown" : "radioReceiver.remoteCountdown");
      // Result buttons are created with the current busy state.
      busy = false;
      if (kind === "baseline") {
        baselineTotals = totals;
        if (measureRemote instanceof HTMLButtonElement) measureRemote.disabled = false;
        if (candidates instanceof HTMLElement) candidates.replaceChildren();
        ht.say(feedback, ht.t("radioReceiver.baselineRecorded", { channels: ht.number(totals.size) }), "ok");
      } else {
        showCandidates(totals);
        ht.say(feedback, ht.t("radioReceiver.remoteMeasured"), "ok");
      }
    } catch (error) { ht.say(feedback, error.message || ht.t("feedback.requestFailed"), "bad"); }
    finally { busy = false; await refresh(); }
  };
  const run = async (progress, done, action) => {
    if (busy) return;
    busy = true; clearTimeout(timer); ht.say(feedback, ht.t(progress));
    try { render(await action()); ht.say(feedback, ht.t(done), "ok"); }
    catch (error) { ht.say(feedback, error.message || ht.t("feedback.requestFailed"), "bad"); }
    finally { busy = false; await refresh(); }
  };
  const renderCodes = (state) => {
    if (!(codes instanceof HTMLElement)) return;
    codes.replaceChildren();
    for (const code of state.codes || []) {
      const item = document.createElement("li"); item.className = "row";
      const title = document.createElement("span"); title.className = "row-name"; title.textContent = code.name;
      const meta = document.createElement("span"); meta.className = "row-meta";
      meta.textContent = code.frequencyHz ? ht.t("radioReceiver.savedFrequency", { mhz: ht.number(code.frequencyHz / 1000000) }) : "nRF24";
      const actions = document.createElement("span"); actions.className = "bar row-side";
      actions.append(
        button(ht.t("radioReceiver.replay"), "btn btn-primary", () => run("radioReceiver.replaying", "radioReceiver.replayed", () => request(api.send, { repeatCount: 1 }, code.id))),
        button(ht.t("radioReceiver.delete"), "btn", () => run("radioReceiver.deleting", "radioReceiver.deleted", () => request(api.delete, {}, code.id))),
      );
      item.append(title, meta, actions); codes.append(item);
    }
    if (codesEmpty instanceof HTMLElement) codesEmpty.hidden = (state.codes || []).length > 0;
  };
  const choose = (observation) => {
    selectedSequence = observation.sequence;
    if (selected) selected.textContent = ht.t("radioReceiver.selectedPacket", {
      channel: ht.number(observation.channel), address: observation.address, payload: observation.payloadHex,
    });
    if (save instanceof HTMLButtonElement) save.disabled = false;
    if (name instanceof HTMLInputElement) name.focus();
  };
  const render = (state) => {
    const quiet = state.quiet;
    sessionStatus = quiet;
    showSessionCue();
    const quietActive = quiet && ["preparing", "starting", "capturing", "reconnecting"].includes(quiet.phase);
    bridgeLive = state.live !== false && !state.recording?.error;
    if (quietActive) bridgeLive = false;
    for (const control of [quietProfile, quietChannel, quietDuration]) {
      if (control instanceof HTMLSelectElement) control.disabled = busy || !!quietActive;
    }
    const sweeping = state.listening && state.config.mode === "sweep";
    if (sessionStart instanceof HTMLButtonElement) sessionStart.disabled = busy || !bridgeLive || !state.radioPresent || sweeping;
    if (sessionReady instanceof HTMLInputElement) sessionReady.disabled = busy || !!quietActive;
    if (captureNote instanceof HTMLInputElement) captureNote.disabled = busy || !!quietActive;
    const availability = !bridgeLive ? "offline" : state.radioPresent ? "online" : "degraded";
    if (mark instanceof HTMLElement) mark.dataset.availability = availability;
    if (label) label.textContent = !bridgeLive ? ht.t("radioReceiver.savedOffline") : !state.radioPresent ? ht.t("radioReceiver.radioMissing")
      : state.listening ? ht.t("radioReceiver.listening") : ht.t("radioReceiver.stopped");
    if (detail) detail.textContent = state.connectionError || state.recording?.error || ht.t("radioReceiver.sequence", { sequence: ht.number(state.sequence) });
    if (quietActive && label) label.textContent = ht.t("radioReceiver.quietActive");
    if (quietActive && detail) detail.textContent = ht.t("radioReceiver.quietExpected");
    for (const control of [quietOff, quietOn]) {
      if (control instanceof HTMLButtonElement) control.disabled = busy || !bridgeLive || !state.radioPresent || sweeping;
    }
    if (quietStatus) quietStatus.textContent = quiet ? ht.t("radioReceiver.quietResult", {
      phase: ht.t("radioReceiver.quietPhase." + quiet.phase),
      wifi: quiet.wifiOff ? ht.t("radioReceiver.quietWifiOff") : ht.t("radioReceiver.quietWifiOn"),
      profile: quiet.profile || "—",
      channel: quiet.channel === null ? ht.t("radioReceiver.quietSweep") : typeof quiet.channel === "number" ? String(quiet.channel) : "—",
      duration: ht.number(quiet.durationMs / 1000),
      seconds: ht.number(Math.min(quiet.durationMs / 1000, Math.floor((quiet.elapsedMs || 0) / 1000))),
      packets: ht.number(quiet.packets || 0), frames: ht.number(quiet.rawFramesSeen || 0),
      path: quiet.path, error: quiet.error || "",
    }) : "";
    if (scan instanceof HTMLButtonElement) scan.disabled = busy || !bridgeLive || sweeping || !state.radioPresent;
    if (sweep instanceof HTMLButtonElement) sweep.disabled = busy || !bridgeLive || sweeping || !state.radioPresent;
    if (capture instanceof HTMLButtonElement) capture.disabled = busy || !bridgeLive || sweeping || !state.radioPresent;
    if (stop instanceof HTMLButtonElement) stop.disabled = busy || !bridgeLive || !state.radioPresent || !state.listening;
    if (recordBaseline instanceof HTMLButtonElement) recordBaseline.disabled = busy || !bridgeLive || sweeping || !state.radioPresent;
    if (measureRemote instanceof HTMLButtonElement) measureRemote.disabled = busy || !bridgeLive || sweeping || !state.radioPresent || !baselineTotals;
    if (save instanceof HTMLButtonElement) save.disabled = busy || !bridgeLive || selectedSequence === undefined;
    if (recording) {
      const savedAt = state.lastSeenAt || state.recording?.lastStateAt;
      recording.textContent = state.recording ? ht.t(state.recording.error ? "radioReceiver.recordingFailed" : "radioReceiver.recordingStatus", {
        path: state.recording.path, count: ht.number(state.recording.records),
        time: savedAt ? new Date(savedAt).toLocaleString() : ht.t("radioReceiver.recordingPending"),
      }) : ht.t("radioReceiver.recordingUnavailable");
    }
    if (sweepStatus) {
      sweepStatus.textContent = !bridgeLive ? ht.t("radioReceiver.offlineCaptureHelp") : state.sweep ? ht.t(sweeping ? "radioReceiver.sweepCountdown"
        : state.sweep.completed ? "radioReceiver.sweepComplete" : "radioReceiver.sweepStopped", {
        seconds: ht.number(Math.max(0, Math.ceil((state.sweep.durationMs - state.sweep.elapsedMs) / 1000))),
        channels: ht.number(state.sweep.channelsVisited), passes: ht.number(state.sweep.passes),
        frames: ht.number(state.rawFramesSeen || 0),
      }) : "";
    }
    if (repeatedAddresses instanceof HTMLElement) {
      repeatedAddresses.replaceChildren();
      const groups = new Map();
      for (const packet of state.observations || []) {
        if (packet.kind !== "packet" || !packet.crcValid || packet.length === 0) continue;
        const key = packet.address + "/" + packet.crcBytes;
        const group = groups.get(key) || { address: packet.address, count: 0, channels: new Set() };
        group.count++; group.channels.add(packet.channel); groups.set(key, group);
      }
      const repeated = [...groups.values()].filter((group) => group.count >= 3).sort((a, b) => b.count - a.count);
      for (const group of repeated) {
        const item = document.createElement("li"); item.className = "row";
        const title = document.createElement("span"); title.className = "row-name mono"; title.textContent = group.address;
        const meta = document.createElement("span"); meta.className = "row-meta";
        meta.textContent = ht.t("radioReceiver.repeatedAddress", {
          count: ht.number(group.count), channels: [...group.channels].sort((a, b) => a - b).map((value) => ht.number(value)).join(", "),
        });
        item.append(title, meta); repeatedAddresses.append(item);
      }
      if (!repeated.length) {
        const item = document.createElement("li"); item.className = "empty";
        item.textContent = ht.t("radioReceiver.noRepeatedAddresses"); repeatedAddresses.append(item);
      }
    }
    if (config instanceof HTMLElement) {
      config.replaceChildren();
      field(config, ht.t("radioReceiver.radio"), state.radioPresent ? ht.t("radioReceiver.present") : ht.t("radioReceiver.missing"));
      field(config, ht.t("radioReceiver.mode"), ht.t("radioReceiver.mode." + (state.config.mode || "energy")));
      field(config, ht.t("radioReceiver.channels"), state.config.mode !== "energy" && state.config.mode !== "sweep" && typeof state.config.channel === "number"
        ? ht.number(state.config.channel)
        : state.config.channelMin === state.config.channelMax
        ? ht.number(state.config.channelMin)
        : ht.t("radioReceiver.channelRange", { minimum: ht.number(state.config.channelMin), maximum: ht.number(state.config.channelMax) }));
      field(config, ht.t("radioReceiver.dataRate"), ht.t("radioReceiver.kbps", { value: ht.number(state.config.dataRateKbps) }));
      field(config, ht.t("radioReceiver.dropped"), ht.number(state.dropped));
    }
    if (observations instanceof HTMLElement) {
      observations.replaceChildren();
      for (const observation of state.observations || []) {
        const item = document.createElement("li"); item.className = "row";
        const activity = document.createElement("span"); activity.className = "row-name mono";
        activity.textContent = observation.kind === "packet" ? observation.payloadHex || ht.t("radioReceiver.bytes", { count: 0 }) : ht.t("radioReceiver.channelActivity");
        const meta = document.createElement("span"); meta.className = "row-meta";
        const parts = [ht.t("radioReceiver.uptime", { seconds: ht.number(observation.uptimeMs / 1000, { maximumFractionDigits: 3 }) })];
        if (observation.kind === "energy" && typeof observation.hits === "number" && typeof observation.samples === "number") {
          parts.push(ht.t("radioReceiver.rpdSamples", { hits: ht.number(observation.hits), samples: ht.number(observation.samples) }));
        }
        if (observation.kind === "packet") parts.push(ht.t("radioReceiver.candidateChannel", { channel: ht.number(observation.channel) }));
        if (observation.kind === "packet") parts.push(ht.t("radioReceiver.address", { address: observation.address }));
        if (observation.kind === "packet") parts.push(ht.t("radioReceiver.bytes", { count: observation.length }));
        if (observation.rpd === true) parts.push(ht.t("radioReceiver.strongSignal"));
        meta.textContent = parts.join(" · ");
        const side = document.createElement("span"); side.className = "row-side";
        if (observation.kind === "packet" && observation.crcValid && observation.length > 0) {
          side.append(button(ht.t("radioReceiver.select"), "btn", () => choose(observation)));
        } else side.textContent = ht.t("radioReceiver.channel", { channel: ht.number(observation.channel), sequence: ht.number(observation.sequence) });
        item.append(activity, meta, side); observations.append(item);
      }
      if (empty instanceof HTMLElement) empty.hidden = state.observations.length > 0;
    }
    renderCodes(state);
  };
  const refresh = async () => {
    clearTimeout(timer);
    if (document.hidden || busy) return;
    try { render(await ht.request(url(api.state))); }
    catch (error) {
      bridgeLive = false;
      if (sessionStatus?.session === sessionPlan.id && sessionCue) sessionCue.textContent = ht.t("radioReceiver.session.stale");
      sessionStatus = undefined;
      for (const control of [scan, sweep, capture, stop, quietOff, quietOn, sessionStart, recordBaseline, measureRemote, save,
        ...(observations?.querySelectorAll("button") || []), ...(codes?.querySelectorAll("button") || [])]) {
        if (control instanceof HTMLButtonElement) control.disabled = true;
      }
      if (mark instanceof HTMLElement) mark.dataset.availability = "offline";
      if (label) label.textContent = ht.t("radioReceiver.unreachable");
      if (detail) detail.textContent = error.message || ht.t("feedback.noResponse");
    } finally { timer = setTimeout(refresh, 1000); }
  };
  scan?.addEventListener("click", () => run("radioReceiver.starting", "radioReceiver.started", () => request(api.start, { mode: "energy" })));
  const quietCapture = async (wifiOff, session) => {
    if (busy) return;
    if (!(captureNote instanceof HTMLInputElement) || !captureNote.value.trim()) {
      ht.say(feedback, ht.t("radioReceiver.quietNoteRequired"), "bad"); captureNote?.focus(); return;
    }
    busy = true;
    for (const control of [quietOff, quietOn, sessionStart]) if (control instanceof HTMLButtonElement) control.disabled = true;
    ht.say(feedback, ht.t("radioReceiver.starting"));
    try {
      const result = await request(api.quiet, { wifiOff, durationMs: Number(quietDuration.value),
        channel: quietChannel.value === "sweep" ? null : Number(quietChannel.value),
        profile: quietProfile instanceof HTMLSelectElement ? quietProfile.value : "esb-1000",
        ...(session ? { session } : {}) });
      sessionStatus = result.quiet;
      showSessionCue();
      if (sessionReady instanceof HTMLInputElement) sessionReady.checked = false;
      selectedSequence = undefined;
      // The polled quiet status owns progress and completion. Do not leave a
      // second, stale "recording" message here after the recorder finishes.
      ht.say(feedback, "");
    } catch (error) { ht.say(feedback, error.message, "bad"); }
    finally { busy = false; refresh(); }
  };
  quietOff?.addEventListener("click", () => quietCapture(true));
  quietOn?.addEventListener("click", () => quietCapture(false));
  sessionStart?.addEventListener("click", () => {
    if (busy) return;
    if (!(sessionReady instanceof HTMLInputElement) || !sessionReady.checked) {
      ht.say(feedback, ht.t("radioReceiver.session.ready"), "bad"); sessionReady?.focus(); return;
    }
    quietProfile.value = "esb-1000"; quietChannel.value = "40"; quietDuration.value = String(sessionPlan.durationMs);
    captureNote.value = ht.t("radioReceiver.session.note");
    quietCapture(true, sessionPlan.id);
  });
  sweep?.addEventListener("click", () => run("radioReceiver.starting", "radioReceiver.sweepStarted", async () => {
    const state = await request(api.start, { mode: "sweep", durationMs: 30000, crcBytes: 2 });
    selectedSequence = undefined;
    if (selected) selected.textContent = ht.t("radioReceiver.noSelection");
    if (save instanceof HTMLButtonElement) save.disabled = true;
    return state;
  }));
  capture?.addEventListener("click", () => {
    const requestedChannel = channel instanceof HTMLInputElement ? Number(channel.value) : NaN;
    const crcBytes = crc instanceof HTMLSelectElement ? Number(crc.value) : 2;
    if (!Number.isInteger(requestedChannel) || requestedChannel < 5 || requestedChannel > 75) {
      ht.say(feedback, ht.t("radioReceiver.invalidChannel"), "bad"); return;
    }
    run("radioReceiver.starting", "radioReceiver.started", () => request(api.start, { mode: "raw", channel: requestedChannel, crcBytes }));
  });
  stop?.addEventListener("click", () => run("radioReceiver.stopping", "radioReceiver.stoppedDone", () => request(api.stop)));
  save?.addEventListener("click", () => {
    const codeName = name instanceof HTMLInputElement ? name.value.trim() : "";
    if (!codeName || selectedSequence === undefined) { ht.say(feedback, ht.t("radioReceiver.nameRequired"), "bad"); return; }
    run("radioReceiver.saving", "radioReceiver.saved", async () => {
      const state = await request(api.save, { name: codeName, sequence: selectedSequence });
      selectedSequence = undefined; if (name instanceof HTMLInputElement) name.value = "";
      if (save instanceof HTMLButtonElement) save.disabled = true;
      if (selected) selected.textContent = ht.t("radioReceiver.noSelection");
      return state;
    });
  });
  recordBaseline?.addEventListener("click", () => measure("baseline"));
  measureRemote?.addEventListener("click", () => measure("remote"));
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pagehide", () => { clearTimeout(timer); clearInterval(cueTimer); });
  refresh();
})();`;

export function renderRadioReceiverPage({ ctx, device }: { ctx: PageContext; device: RegisteredDevice }): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: device.name,
    nav: "devices",
    mainAttributes: `data-radio-receiver-page data-device-id="${escapeHtml(device.id)}" data-api="${escapeHtml(JSON.stringify(RADIO_RECEIVER_API))}" data-session-plan="${escapeHtml(JSON.stringify(TMNT_SESSION_PLAN))}"`,
    body: `${renderDeviceHead(ctx, device, "controls")}
      <div class="state" aria-live="polite">
        <span class="mark" id="state-mark" data-availability="unknown" aria-hidden="true"></span>
        <span class="state-value" id="state-label">${escapeHtml(t("radioReceiver.connecting"))}</span>
        <span class="state-detail" id="state-detail"></span>
      </div>
      <section><h2>${escapeHtml(t("radioReceiver.session.title"))}</h2>
        <p>${escapeHtml(t("radioReceiver.session.help"))}</p>
        <ol>${TMNT_SESSION_PLAN.steps.filter(step => step.action !== "release").map(step => `<li>${step.startMs / 1000}–${step.endMs / 1000} s: ${escapeHtml(t(`radioReceiver.session.${step.action}`))}</li>`).join("")}</ol>
        <p><label><input id="session-ready" type="checkbox"> ${escapeHtml(t("radioReceiver.session.ready"))}</label></p>
        <button class="btn btn-primary" id="session-start" type="button" disabled>${escapeHtml(t("radioReceiver.session.start"))}</button>
        <p id="session-cue" role="status" style="font-size:2rem;min-height:3em">${escapeHtml(t("radioReceiver.session.wait"))}</p>
      </section>
      <section><h2>${escapeHtml(t("radioReceiver.quietTitle"))}</h2>
        <p class="muted small" id="capture-recording" role="status">${escapeHtml(t("radioReceiver.recordingPending"))}</p>
        <p><label>${escapeHtml(t("radioReceiver.captureNote"))} <input id="capture-note" type="text" maxlength="1000" placeholder="${escapeHtml(t("radioReceiver.captureNoteHint"))}"></label></p>
        <p class="muted small">${escapeHtml(t("radioReceiver.quietHelp"))}</p>
        <p><label>${escapeHtml(t("radioReceiver.quietProfile"))} <select id="quiet-profile">
          <option value="esb-1000">Nordic ESB · 1 Mbps</option>
          <option value="esb-250">Nordic ESB · 250 kbps</option>
          <option value="esb-2000">Nordic ESB · 2 Mbps</option>
          <option value="xn297-1000">XN297 · 1 Mbps</option>
          <option value="xn297-250">XN297 · 250 kbps</option>
          <option value="xn297-2000">XN297 · 2 Mbps</option>
        </select></label></p>
        <div class="bar">
          <label>${escapeHtml(t("radioReceiver.quietChannel"))} <select id="quiet-channel">
            <option value="sweep">${escapeHtml(t("radioReceiver.quietSweep"))}</option>
            ${Array.from({ length: 71 }, (_, i) => `<option value="${i + 5}"${i + 5 === 40 ? " selected" : ""}>${i + 5} · ${i + 2405} MHz</option>`).join("")}
          </select></label>
          <label>${escapeHtml(t("radioReceiver.quietDuration"))} <select id="quiet-duration">
            <option value="10000">10 s</option><option value="20000" selected>20 s</option>
          </select></label>
        </div>
        <div class="bar">
          <button class="btn" id="quiet-on" type="button" disabled>${escapeHtml(t("radioReceiver.quietOnButton"))}</button>
          <button class="btn btn-primary" id="quiet-off" type="button" disabled>${escapeHtml(t("radioReceiver.quietOffButton"))}</button>
        </div>
        <p id="quiet-status" class="feedback" role="status"></p>
        <details><summary>${escapeHtml(t("radioReceiver.sweepTitle"))}</summary>
          <p class="muted small">${escapeHtml(t("radioReceiver.sweepHelp"))}</p>
          <button class="btn" id="listener-sweep" type="button" disabled>${escapeHtml(t("radioReceiver.sweepButton"))}</button>
          <p id="sweep-status" class="feedback" role="status"></p>
        </details>
      </section>
      <section><h2>${escapeHtml(t("radioReceiver.listen"))}</h2>
        <p class="muted small">${escapeHtml(t("radioReceiver.listenHelp"))}</p>
        <div class="bar">
          <button class="btn" id="listener-scan" type="button" disabled>${escapeHtml(t("radioReceiver.scan"))}</button>
          <label>${escapeHtml(t("radioReceiver.captureChannel"))} <input id="capture-channel" type="number" min="5" max="75" value="42" inputmode="numeric"></label>
          <label>${escapeHtml(t("radioReceiver.crc"))} <select id="capture-crc"><option value="2">16-bit</option><option value="1">8-bit</option></select></label>
          <button class="btn btn-primary" id="listener-capture" type="button" disabled>${escapeHtml(t("radioReceiver.capture"))}</button>
          <button class="btn" id="listener-stop" type="button" disabled>${escapeHtml(t("radioReceiver.stop"))}</button>
        </div>
      </section>
      <section><h2>${escapeHtml(t("radioReceiver.findChannel"))}</h2>
        <p class="muted small">${escapeHtml(t("radioReceiver.findChannelHelp"))}</p>
        <div class="bar">
          <button class="btn" id="record-baseline" type="button" disabled>${escapeHtml(t("radioReceiver.recordBaseline"))}</button>
          <button class="btn btn-primary" id="measure-remote" type="button" disabled>${escapeHtml(t("radioReceiver.measureRemote"))}</button>
        </div>
        <ol class="rows" id="channel-candidates"></ol>
      </section>
      <p id="listener-feedback" class="feedback" role="status"></p>
      <section><h2>${escapeHtml(t("radioReceiver.configuration"))}</h2><dl class="kv" id="radio-config"></dl></section>
      <section><h2>${escapeHtml(t("radioReceiver.repeatedTitle"))}</h2>
        <p class="muted small">${escapeHtml(t("radioReceiver.repeatedHelp"))}</p>
        <ol class="rows" id="repeated-addresses"></ol>
      </section>
      <section><h2>${escapeHtml(t("radioReceiver.observations"))}</h2>
        <p class="muted small">${escapeHtml(t("radioReceiver.observationsHelp"))}</p>
        <ol class="rows" id="radio-observations"></ol>
        <p class="empty" id="observations-empty">${escapeHtml(t("radioReceiver.empty"))}</p>
      </section>
      <section><h2>${escapeHtml(t("radioReceiver.saveCode"))}</h2>
        <p class="muted small" id="selected-packet">${escapeHtml(t("radioReceiver.noSelection"))}</p>
        <div class="bar"><label>${escapeHtml(t("radioReceiver.codeName"))} <input id="code-name" type="text" maxlength="100" autocomplete="off"></label>
          <button class="btn btn-primary" id="code-save" type="button" disabled>${escapeHtml(t("radioReceiver.save"))}</button></div>
      </section>
      <section><h2>${escapeHtml(t("radioReceiver.savedCodes"))}</h2>
        <p class="muted small">${escapeHtml(t("radioReceiver.replayWarning"))}</p>
        <ol class="rows" id="saved-codes"></ol>
        <p class="empty" id="saved-codes-empty">${escapeHtml(t("radioReceiver.noSavedCodes"))}</p>
      </section>`,
    script: RADIO_RECEIVER_SCRIPT,
    messages: ["radioReceiver."],
  });
}
