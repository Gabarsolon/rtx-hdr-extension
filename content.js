// Detects images, videos, AND streams on every page (for the popup's
// list), but only *converts* an image to a live video stream when the tab
// itself is a directly-opened image — i.e. Chrome's built-in single-image
// viewer, where document.contentType starts with "image/". Regular pages
// that merely embed <img> tags get detected and listed, but left
// untouched. <video> elements are already real videos — nothing to
// convert — so they're just detected and listed for visibility/opening,
// same as images. "Streams" covers two cases DOM inspection alone can't:
// live WebRTC/getUserMedia video (video.srcObject, no URL at all) and
// MSE-backed players like Instagram/Twitter/TikTok, where the <video>
// element's own src is just a page-scoped blob: URL — their real segment
// URLs only ever show up as network requests, sniffed here via
// PerformanceObserver. GIFs get special handling in the conversion path
// itself (see isGifSrc/startGifDecodeLoop below): a plain single draw would
// only ever capture frame 0, so animated sources are decoded frame-by-frame
// with WebCodecs' ImageDecoder and painted on a timer, independent of
// whatever Chrome itself does with the (now hidden) original <img>.
(function () {
  if (window.__rtxHdrBoosterInstalled) return;
  window.__rtxHdrBoosterInstalled = true;

  const isImagePage = !!(document.contentType && document.contentType.startsWith("image/"));

  const MIN_AREA = 40000; // skip tiny icons/avatars
  let totalConverted = 0;
  let autoConvertAll = false; // toggled from the popup, persisted in chrome.storage.sync

  // Registry of every image/video/stream we've looked at, keyed by src (or
  // a synthetic key for sourceless live streams) — powers the popup's
  // "detected" list. Each entry has a "kind": "image" | "video" | "stream".
  // Image entries have a status, one of:
  //   "converted" | "blocked" | "pending" | "detected"
  // ("detected" = found on a regular page, never attempted — conversion
  // only runs on image pages.) Video/stream entries are always "native" —
  // they're already real video, nothing to convert. Stream entries also
  // carry "openable": false for live WebRTC (no URL exists at all) vs true
  // for sniffed CDN segment URLs (a real, if possibly time-limited, URL).
  const registry = new Map();

  function setStatus(src, patch) {
    const prev = registry.get(src) || { src };
    registry.set(src, { ...prev, ...patch });
  }

  function reportCount() {
    try {
      chrome.runtime.sendMessage({ type: "rtx-hdr-count", count: totalConverted });
    } catch (e) {
      // extension context can go away on navigation; ignore
    }
  }

  // GIFs are the one case where a single draw-and-capture isn't enough:
  // captureStream() snapshots whatever's on the canvas at that instant, so
  // without ongoing redraws the "video" is just a frozen frame-0 stream.
  // Detected by extension since the Performance/Image APIs don't expose an
  // animated-vs-static flag cheaply.
  function isGifSrc(src) {
    try {
      const u = new URL(src, location.href);
      return /\.gif(?:[?#]|$)/i.test(u.pathname);
    } catch (e) {
      return /\.gif(?:[?#]|$)/i.test(src);
    }
  }

  function swap(img, canvas, stream, src) {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.style.cssText = img.style.cssText;
    video.className = img.className;
    if (img.width) video.width = img.width;
    if (img.height) video.height = img.height;
    img.replaceWith(video);
    video.play().catch(() => {});
    totalConverted++;
    setStatus(src, { status: "converted" });
    reportCount();
    return video;
  }

  // Draws sourceImg into canvas and captures it. captureStream() throws
  // synchronously if the canvas got tainted (cross-origin draw without CORS
  // clearance) — that's how we detect the failure case.
  function drawAndCapture(canvas, ctx, sourceImg, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sourceImg, 0, 0, w, h);
    return canvas.captureStream(30);
  }

  // Primary GIF-animation path: decode the file's actual frames ourselves
  // with WebCodecs' ImageDecoder and paint them on a timer matched to each
  // frame's real duration. This sidesteps Chrome's own (and apparently
  // unreliable in practice) decision about whether a hidden/off-canvas <img>
  // keeps animating — we never rely on the browser's built-in GIF player at
  // all past the very first frame. bytesUrl is fetched fresh here (not read
  // off the <img> itself) since Image elements don't expose their raw bytes.
  async function startGifDecodeLoop(bytesUrl, canvas, ctx, w, h, video) {
    if (!window.ImageDecoder) return false;

    let buf;
    try {
      buf = await fetch(bytesUrl).then((r) => r.arrayBuffer());
    } catch (e) {
      return false;
    }

    let decoder;
    try {
      decoder = new ImageDecoder({ data: buf, type: "image/gif" });
      await decoder.tracks.ready;
      await decoder.completed; // ensures frameCount is fully known, not still growing
    } catch (e) {
      try { decoder && decoder.close(); } catch (e2) {}
      return false;
    }

    const track = decoder.tracks.selectedTrack;
    const frameCount = (track && track.frameCount) || 1;
    if (frameCount <= 1) {
      decoder.close();
      return false; // not actually animated — the single frame already drawn is enough
    }

    let frameIndex = 0;
    let stopped = false;

    async function playNext() {
      if (stopped || !video.isConnected) {
        stopped = true;
        decoder.close();
        return;
      }
      let result;
      try {
        result = await decoder.decode({ frameIndex });
      } catch (e) {
        stopped = true;
        decoder.close();
        return;
      }
      const frame = result.image;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(frame, 0, 0, w, h);
      const durationMs = frame.duration ? frame.duration / 1000 : 100;
      frame.close();
      frameIndex = (frameIndex + 1) % frameCount;
      setTimeout(playNext, Math.max(20, durationMs));
    }

    playNext();
    return true;
  }

  // Fallback GIF-animation path for when ImageDecoder isn't available: keep
  // the source <img> connected to the DOM (hidden, not removed — Chrome only
  // advances a GIF's frames while its <img> is part of the render tree) and
  // keep redrawing it into the canvas every animation frame. Less reliable
  // than the decode-it-ourselves path above (depends on the browser actually
  // continuing to animate a hidden element, which isn't guaranteed), kept
  // only as a second line of defense on browsers without WebCodecs support.
  function startLegacyRedrawLoop(sourceImg, canvas, ctx, w, h, video) {
    sourceImg.style.position = "absolute";
    sourceImg.style.opacity = "0";
    sourceImg.style.pointerEvents = "none";
    sourceImg.removeAttribute("loading");
    sourceImg.setAttribute("aria-hidden", "true");
    if (!sourceImg.isConnected) {
      video.insertAdjacentElement("afterend", sourceImg);
    }
    function tick() {
      if (!video.isConnected) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(sourceImg, 0, 0, w, h);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function animate(bytesUrl, sourceImg, canvas, ctx, w, h, video) {
    startGifDecodeLoop(bytesUrl, canvas, ctx, w, h, video).then((ok) => {
      if (!ok) startLegacyRedrawLoop(sourceImg, canvas, ctx, w, h, video);
    });
  }

  function doConversion(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const src = img.src;
    const animated = isGifSrc(src);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    try {
      const stream = drawAndCapture(canvas, ctx, img, w, h);
      const video = swap(img, canvas, stream, src);
      if (animated) animate(src, img, canvas, ctx, w, h, video);
      return;
    } catch (e) {
      // Tainted canvas — cross-origin image whose CDN doesn't send
      // Access-Control-Allow-Origin. Ask the background service worker to
      // fetch the bytes instead: extensions with host_permissions can fetch
      // cross-origin resources without CORS restrictions (unlike page JS),
      // and the data: URL it hands back never taints a canvas.
    }

    chrome.runtime.sendMessage({ type: "rtx-hdr-fetch-image", url: src }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        console.warn("RTX HDR Booster: cross-origin fetch failed, skipped", src, resp && resp.error);
        setStatus(src, { status: "blocked", reason: (resp && resp.error) || "fetch failed" });
        return;
      }
      const fresh = new Image();
      fresh.onload = () => {
        // Must use a brand new canvas/context here: the original's
        // origin-clean flag is permanently false the moment drawImage() ran
        // on the tainted source, even though the exception came later at
        // captureStream() — there's no way to "un-taint" it.
        const retryCanvas = document.createElement("canvas");
        retryCanvas.width = w;
        retryCanvas.height = h;
        const retryCtx = retryCanvas.getContext("2d");
        try {
          const stream = drawAndCapture(retryCanvas, retryCtx, fresh, w, h);
          const video = swap(img, retryCanvas, stream, src);
          // resp.dataUrl is already the raw bytes as a data: URL — reuse it
          // directly instead of re-fetching src (which would just fail with
          // the same CORS error all over again).
          if (animated) animate(resp.dataUrl, fresh, retryCanvas, retryCtx, w, h, video);
        } catch (e2) {
          console.warn("RTX HDR Booster: still tainted after data-URL retry, skipped", src);
          setStatus(src, { status: "blocked", reason: "tainted after retry" });
        }
      };
      fresh.onerror = () => {
        console.warn("RTX HDR Booster: data URL failed to decode", src);
        setStatus(src, { status: "blocked", reason: "data URL decode failed" });
      };
      fresh.src = resp.dataUrl;
    });
  }

  function attemptConvert(img) {
    if (!img.src || img.dataset.rtxHdrDone) return;

    if (!img.complete || img.naturalWidth === 0) {
      img.addEventListener("load", () => attemptConvert(img), { once: true });
      return;
    }

    if (img.naturalWidth * img.naturalHeight < MIN_AREA) return;

    const shouldConvert = isImagePage || autoConvertAll;

    if (!shouldConvert) {
      // List it for the popup, but don't mark it permanently done — if the
      // "auto-convert on all pages" toggle gets flipped on later, the next
      // rescan (triggered by the storage change listener below) needs to
      // still be able to pick this element up.
      setStatus(img.src, {
        kind: "image",
        width: img.naturalWidth,
        height: img.naturalHeight,
        status: "detected",
      });
      return;
    }

    img.dataset.rtxHdrDone = "1"; // mark before the async CORS retry can land
    setStatus(img.src, {
      kind: "image",
      width: img.naturalWidth,
      height: img.naturalHeight,
      status: "pending",
    });
    doConversion(img);
  }

  // Re-checks a video once its metadata/dimensions might have shown up —
  // covers both the "still loading" and "still 0x0" cases below.
  function watchForMetadata(video) {
    video.addEventListener("loadedmetadata", () => attemptDetectVideo(video), { once: true });
    video.addEventListener("resize", () => attemptDetectVideo(video), { once: true });
  }

  let streamCounter = 0;
  const streamKeys = new WeakMap();
  function keyForStream(video) {
    if (!streamKeys.has(video)) streamKeys.set(video, `stream:${location.href}#${++streamCounter}`);
    return streamKeys.get(video);
  }

  // Videos are already real <video> elements — no conversion needed, just
  // list them. currentSrc is used over .src since it's what the browser
  // actually resolved (handles <source> children, picks the active track).
  function attemptDetectVideo(video) {
    if (video.dataset.rtxHdrSeen) return;

    if (video.srcObject) {
      // Fed by getUserMedia/WebRTC (or occasionally a raw MediaSource) —
      // there's no URL on the element at all. currentSrc stays "" per spec
      // whenever srcObject is used, so this can't be treated as "not
      // resolved yet" the way a missing src attribute can.
      const w = video.videoWidth || video.clientWidth;
      const h = video.videoHeight || video.clientHeight;
      if (w * h === 0) {
        watchForMetadata(video);
        return;
      }
      if (w * h < MIN_AREA) return;
      video.dataset.rtxHdrSeen = "1";
      setStatus(keyForStream(video), {
        kind: "stream",
        label: "Live stream",
        width: w,
        height: h,
        status: "native",
        openable: false,
      });
      return;
    }

    const src = video.currentSrc || video.src;
    if (!src) {
      // Not resolved yet (e.g. <source> children still loading) — try
      // again once metadata is available.
      watchForMetadata(video);
      return;
    }
    if (src.startsWith("blob:")) {
      // MSE-backed player (hls.js/dash.js/Shaka — Instagram, Twitter,
      // TikTok, etc.) — this URL is page-scoped and won't resolve in a new
      // tab anyway. The network-level sniffer below finds the real,
      // openable segment URLs for these instead.
      return;
    }

    const w = video.videoWidth || video.clientWidth;
    const h = video.videoHeight || video.clientHeight;
    if (w * h < MIN_AREA) return;

    video.dataset.rtxHdrSeen = "1";
    setStatus(src, { kind: "video", width: w, height: h, status: "native" });
  }

  // Catches streamed video that never appears as a clean element src: MSE
  // players fetch their actual segments (real CDN URLs, often signed/
  // time-limited) via fetch()/XHR, which — unlike the <video> element's own
  // blob: src — do show up as ordinary "resource" performance entries.
  const STREAM_URL_PATTERN = /\.(mp4|m3u8|mpd|webm|ts)(\?|$)|[?&](bytestart|byterange|range)=/i;
  const sniffedStreamKeys = new Set();

  function maybeRegisterStreamUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch (e) {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) return;
    if (!STREAM_URL_PATTERN.test(url.pathname + url.search)) return;

    // Dedupe by origin+pathname so repeated byte-range segment requests for
    // the same clip collapse into a single listing (only the first URL seen
    // is kept, so the query string — including any signature — is real).
    const key = url.origin + url.pathname;
    if (sniffedStreamKeys.has(key)) return;
    sniffedStreamKeys.add(key);

    setStatus(rawUrl, { kind: "stream", width: 0, height: 0, status: "native", openable: true });
  }

  if (window.PerformanceObserver) {
    try {
      const perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) maybeRegisterStreamUrl(entry.name);
      });
      // buffered: true also picks up requests that fired before this
      // content script attached.
      perfObserver.observe({ type: "resource", buffered: true });
    } catch (e) {
      // PerformanceObserver unsupported/blocked in this context — skip.
    }
  }

  function scan() {
    document.querySelectorAll("img").forEach(attemptConvert);
    document.querySelectorAll("video").forEach(attemptDetectVideo);
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const debouncedScan = debounce(scan, 300);

  // Watch for new <img> elements and src changes (infinite scroll, lazy
  // loading, client-side routing).
  const observer = new MutationObserver(debouncedScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  // Messages from the background worker / popup.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "rtx-hdr-rescan") {
      scan();
      return;
    }

    if (msg.type === "rtx-hdr-get-images") {
      sendResponse({ items: Array.from(registry.values()), isImagePage, autoConvertAll });
      return;
    }
  });

  // Load the toggle's persisted value, then do the initial scan. Using
  // storage.local (not .sync) — sync depends on being signed into Chrome
  // sync and can lag or silently no-op if that's off; local is instant and
  // has no such dependency. Defaults to true: auto-convert everywhere.
  chrome.storage.local.get({ autoConvertAll: true }, (result) => {
    autoConvertAll = !!result.autoConvertAll;
    scan();
  });

  // Live-apply the toggle without needing a page reload. Turning it on
  // re-scans so already-seen-but-skipped ("detected") images get converted.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.autoConvertAll) return;
    autoConvertAll = !!changes.autoConvertAll.newValue;
    if (autoConvertAll) scan();
  });

  // Fullscreen hotkey for any <video> on the page — native ones (Instagram,
  // etc.) included, not just ones this extension touched. RTX Video HDR/
  // Super Resolution are driver-level features with no web API to invoke;
  // there's nothing this extension can call to turn them on for a given
  // video. But there are real reports they only engage once a video is
  // displayed large enough, fullscreen being the reliable case — this just
  // makes that cheap to test directly, in place, no popup/tab involved.
  // Uses capture-phase listeners so it works even inside a site's own
  // player controls, and never touches the page's DOM (no risk of
  // disturbing a site's own player/React state).
  //
  // Alt+Shift+F, not plain Alt+F: Chrome itself owns Alt+F (opens the
  // browser's 3-dot menu) and Alt+E as menu-access accelerators — those
  // never even reach page JS as a keydown event, the browser chrome
  // intercepts them first. Alt+Shift+F isn't claimed by Chrome or any site
  // convention.
  let hoveredVideo = null;

  document.addEventListener(
    "mouseover",
    (e) => {
      const v = e.target && e.target.closest && e.target.closest("video");
      if (v) hoveredVideo = v;
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      const v = e.target && e.target.closest && e.target.closest("video");
      if (v && v === hoveredVideo) hoveredVideo = null;
    },
    true
  );

  // Falls back to "whichever playing video is most visible in the
  // viewport" when hover-tracking comes up empty — plenty of sites
  // (Instagram very much included) layer their own UI controls directly on
  // top of the <video> with a higher z-index, so the mouse is actually
  // hovering that overlay, not the video underneath, and closest("video")
  // never finds it. This heuristic works even then, since there's usually
  // exactly one video actually autoplaying on screen.
  function pickTargetVideo() {
    if (hoveredVideo && hoveredVideo.isConnected) return hoveredVideo;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      if (!v.isConnected || v.paused || v.readyState === 0) continue;
      const r = v.getBoundingClientRect();
      const visibleW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const area = visibleW * visibleH;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  // Registered on window, not document, and as the very first capture
  // listener added in this frame: capture-phase dispatch always visits
  // window before document before anything else, so this runs before any
  // page-level keydown handler could see the event, let alone
  // stopPropagation()/stopImmediatePropagation() it. That matters a lot in
  // practice — plenty of sites with their own video player (Mega.nz
  // included) register their own global keyboard-shortcut handler (space,
  // arrows, "f" for their own fullscreen toggle) that swallows keydowns
  // broadly, sometimes checking only e.key and ignoring modifiers, which
  // would eat an Alt+Shift+F meant for us before a document-level listener
  // ever got a look at it.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const target = pickTargetVideo();
      if (!target) {
        console.warn("RTX HDR Booster: Alt+Shift+F pressed but no video found (hover one, or make sure one is playing on screen)");
        return;
      }
      e.preventDefault();
      e.stopPropagation(); // don't let the page's own handler act on it too
      target.requestFullscreen().catch((err) => {
        console.warn("RTX HDR Booster: fullscreen request failed", err);
      });
    },
    true
  );
})();
