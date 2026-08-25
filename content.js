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
// PerformanceObserver.
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
  }

  // Draws sourceImg into canvas and captures it. captureStream() throws
  // synchronously if the canvas got tainted (cross-origin draw without CORS
  // clearance) — that's how we detect the failure case.
  function drawAndCapture(canvas, ctx, sourceImg, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sourceImg, 0, 0, w, h);
    return canvas.captureStream(30);
  }

  function doConversion(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const src = img.src;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    try {
      const stream = drawAndCapture(canvas, ctx, img, w, h);
      swap(img, canvas, stream, src);
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
          swap(img, retryCanvas, stream, src);
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

  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if (!hoveredVideo || !hoveredVideo.isConnected) return;
      e.preventDefault();
      hoveredVideo.requestFullscreen().catch((err) => {
        console.warn("RTX HDR Booster: fullscreen request failed", err);
      });
    },
    true
  );
})();
