// Detects images on every page (for the popup's list), but only *converts*
// an image to a live video stream when the tab itself is a directly-opened
// image — i.e. Chrome's built-in single-image viewer, where
// document.contentType starts with "image/". Regular pages that merely
// embed <img> tags get detected and listed, but left untouched.
(function () {
  if (window.__rtxHdrBoosterInstalled) return;
  window.__rtxHdrBoosterInstalled = true;

  const isImagePage = !!(document.contentType && document.contentType.startsWith("image/"));

  const MIN_AREA = 40000; // skip tiny icons/avatars
  let totalConverted = 0;
  let autoConvertAll = false; // toggled from the popup, persisted in chrome.storage.local

  // Registry of every image we've looked at, keyed by src — powers the
  // popup's "detected images" list. status is one of:
  //   "converted" | "blocked" | "pending" | "detected"
  // ("detected" = found on a regular page, never attempted — conversion
  // only runs on image pages.)
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

  // Draws sourceEl into canvas once. Throws synchronously (SecurityError) if
  // the canvas got tainted (cross-origin draw without CORS clearance) —
  // that's how we detect the failure case.
  function drawOnce(ctx, sourceEl, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sourceEl, 0, 0, w, h);
  }

  // Best-effort: clones liveSource into a hidden-but-still-rendered element
  // positioned off-screen, so it keeps animating (Chrome only steps an
  // animated GIF's frames while the element is part of the render tree —
  // a detached Image() or a removed <img> freezes on its last frame) and we
  // have something live left to keep drawing into the canvas after the
  // original element is gone. Explicitly forces eager loading/decoding —
  // sites commonly mark real <img> tags loading="lazy", and an off-screen
  // clone of one of those may never actually load, so this must never be
  // something the *first* conversion draw depends on, only later frames.
  function makeHiddenClone(liveSource, w, h) {
    const el = liveSource.cloneNode();
    el.loading = "eager";
    el.decoding = "sync";
    el.style.cssText =
      `position:fixed; left:-99999px; top:-99999px; width:${w}px; height:${h}px; pointer-events:none;`;
    el.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(el);
    return el;
  }

  // Replaces img with a live <video> fed by canvas.captureStream(). canvas
  // already has one good frame drawn into it (from the initial synchronous
  // draw), so the photo shows correctly right away regardless of what
  // happens next. On top of that, it keeps redrawing a hidden clone of
  // liveSource into the canvas every frame so anything that changes over
  // time — animated GIFs above all — keeps showing motion instead of
  // freezing on that first frame.
  function swap(img, liveSource, canvas, ctx, stream, src, w, h) {
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

    const hiddenClone = makeHiddenClone(liveSource, w, h);
    let rafId;
    function tick() {
      if (!video.isConnected) {
        cancelAnimationFrame(rafId);
        hiddenClone.remove();
        return;
      }
      try {
        ctx.drawImage(hiddenClone, 0, 0, w, h);
      } catch (e) {
        // shouldn't happen once the initial taint check passed, but never
        // let a stray draw error silently kill the animation loop
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
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
      // img is already loaded — attemptConvert only calls doConversion once
      // img.complete is true — so this runs synchronously, no race with
      // lazy-loading or network timing.
      drawOnce(ctx, img, w, h);
      const stream = canvas.captureStream(30);
      swap(img, img, canvas, ctx, stream, src, w, h);
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
        // origin-clean flag is permanently false the moment drawImage()
        // ran on the tainted source, even though the exception came later at
        // captureStream() — there's no way to "un-taint" it.
        const retryCanvas = document.createElement("canvas");
        retryCanvas.width = w;
        retryCanvas.height = h;
        const retryCtx = retryCanvas.getContext("2d");
        try {
          drawOnce(retryCtx, fresh, w, h);
          const stream = retryCanvas.captureStream(30);
          swap(img, fresh, retryCanvas, retryCtx, stream, src, w, h);
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
        width: img.naturalWidth,
        height: img.naturalHeight,
        status: "detected",
      });
      return;
    }

    img.dataset.rtxHdrDone = "1"; // mark before the async CORS retry can land
    setStatus(img.src, {
      width: img.naturalWidth,
      height: img.naturalHeight,
      status: "pending",
    });
    doConversion(img);
  }

  function scan() {
    document.querySelectorAll("img").forEach(attemptConvert);
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
      sendResponse({ images: Array.from(registry.values()), isImagePage, autoConvertAll });
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
})();
