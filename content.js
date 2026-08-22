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
  let autoConvertAll = false; // toggled from the popup, persisted in chrome.storage.sync

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
