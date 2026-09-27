/** Shared by device and service event results. At most one animated preview runs per page. */
export const DETECTION_PREVIEW_SCRIPT = String.raw`
    let activePreview = null;
    const previewCache = new Map();
    let previewCacheBytes = 0;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const attachDetectionPreview = (preview, link, image, path, camera, objectId, frameTime) => {
      const caption = el("div", "event-frame-caption", ht.t("events.previewHint"));
      const button = el("button", "subtle event-preview-toggle", ht.t("events.playPreview"));
      button.type = "button"; button.setAttribute("aria-pressed", "false");
      preview.append(caption, button);
      const originalAlt = image.alt;
      let controller = null, delay = null, timer = null, generation = 0, pinned = false, playing = false;
      let failureUntil = 0, failureMessage = "";
      const cacheKey = camera + "/" + objectId + "/" + frameTime;
      const stop = () => {
        generation++; clearTimeout(delay); clearTimeout(timer); delay = timer = null;
        controller?.abort(); controller = null; pinned = false;
        if (playing) { image.src = path; image.alt = originalAlt; }
        playing = false; button.textContent = ht.t("events.playPreview"); button.setAttribute("aria-pressed", "false");
        caption.textContent = failureUntil > Date.now() ? failureMessage : ht.t("events.previewHint");
        if (activePreview?.stop === stop) activePreview = null;
      };
      const begin = async () => {
        clearTimeout(delay); delay = null;
        if (activePreview?.stop === stop || document.hidden || !preview.isConnected) return;
        activePreview?.stop(); activePreview = { stop, node: preview };
        const run = ++generation;
        controller = new AbortController();
        const signal = controller.signal;
        button.textContent = ht.t("events.stopPreview"); button.setAttribute("aria-pressed", "true");
        caption.textContent = ht.t("events.previewLoading");
        try {
          if (Date.now() < failureUntil) throw new Error(failureMessage);
          let cached = previewCache.get(cacheKey);
          if (cached && Date.now() >= cached.until) {
            previewCacheBytes -= cached.bytes; previewCache.delete(cacheKey); cached = null;
          }
          if (!cached) {
            const response = await fetch("/api/services/frigate/previews/" + encodeURIComponent(camera) + "/" + encodeURIComponent(objectId)
              + "?at=" + encodeURIComponent(frameTime), { signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]) });
            if (!response.ok) throw new Error(ht.t(response.status === 503 ? "events.previewAccess" : "events.previewUnavailable"));
            const value = await response.json();
            if (!Array.isArray(value.frames) || value.frames.length < 2 || value.frames.length > 10 || value.playbackRate !== 5
              || value.frames.some((frame, index) => !Number.isFinite(frame.time)
                || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(frame.image || "") || frame.image.length > 350000
                || (index && frame.time <= value.frames[index - 1].time))
              || value.frames.at(-1).time - value.frames[0].time > 9) throw new Error(ht.t("events.previewUnavailable"));
            if (signal.aborted || run !== generation) return;
            // Decode all frames before playback to avoid flashing or stuttering at 5 fps.
            await Promise.all(value.frames.map(frame => { const preload = new Image(); preload.src = frame.image; return preload.decode(); }));
            if (signal.aborted || run !== generation) return;
            const bytes = value.frames.reduce((sum, frame) => sum + frame.image.length * 2, 0);
            while (previewCache.size && (previewCache.size >= 8 || previewCacheBytes + bytes > 16 * 1024 * 1024)) {
              const key = previewCache.keys().next().value;
              previewCacheBytes -= previewCache.get(key).bytes; previewCache.delete(key);
            }
            cached = { frames: value.frames, bytes, until: Date.now() + (value.frames.length === 10 ? 300000 : 5000) };
            previewCache.set(cacheKey, cached); previewCacheBytes += bytes;
          }
          const frames = cached.frames;
          const duration = frames.at(-1).time - frames[0].time + 1;
          const started = performance.now();
          playing = true; image.alt = ht.t("events.previewAlt");
          caption.textContent = ht.t("events.previewPlaying", { seconds: ht.number(duration) });
          const tick = () => {
            if (run !== generation) return;
            if (!preview.isConnected || document.hidden) { stop(); return; }
            // Respect missing seconds: hold the preceding frame rather than compressing gaps.
            const time = frames[0].time + ((performance.now() - started) * 5 / 1000) % duration;
            const frame = frames.findLast(frame => frame.time <= time) || frames[0];
            if (image.getAttribute("src") !== frame.image) image.src = frame.image;
            timer = setTimeout(tick, 40);
          };
          tick();
        } catch (error) {
          if (signal.aborted || run !== generation) return;
          failureMessage = error instanceof Error && [ht.t("events.previewAccess"), ht.t("events.previewUnavailable")].includes(error.message)
            ? error.message : ht.t("events.previewUnavailable");
          failureUntil = Date.now() + 10000; stop();
        }
      };
      preview.addEventListener("pointerenter", event => {
        if (event.pointerType === "mouse" && !reducedMotion.matches) delay = setTimeout(begin, 180);
      });
      preview.addEventListener("pointerleave", () => { if (!pinned) stop(); });
      link.addEventListener("focus", () => { if (!reducedMotion.matches) void begin(); });
      preview.addEventListener("focusout", event => { if (!pinned && !preview.contains(event.relatedTarget)) stop(); });
      button.addEventListener("click", () => {
        if (activePreview?.stop === stop) stop();
        else { pinned = true; void begin(); }
      });
      preview.addEventListener("keydown", event => { if (event.key === "Escape") stop(); });
    };
    document.addEventListener("visibilitychange", () => { if (document.hidden) activePreview?.stop(); });
    window.addEventListener("pagehide", () => activePreview?.stop());
    reducedMotion.addEventListener("change", () => activePreview?.stop());
    new MutationObserver(() => {
      if (activePreview && !activePreview.node.isConnected) activePreview.stop();
    }).observe(list, { childList: true });
`;
