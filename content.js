// Only activates when the tab *is* an image — i.e. you navigated directly to
// an image URL and Chrome rendered its built-in single-image viewer
// (document.contentType is "image/..." in that case). Regular web pages that
// merely embed <img> tags are left alone entirely.
(function () {
  if (window.__rtxHdrBoosterInstalled) return;
  window.__rtxHdrBoosterInstalled = true;

  if (!document.contentType || !document.contentType.startsWith("image/")) {
    return; // not a directly-opened image — do nothing on this page
  }

  const MIN_AREA = 40000; // skip tiny icons/avatars
  let totalConverted = 0;

  // Registry of every image we've looked at, keyed by src — powers the
  // popup's "detected images" list. status is one of:
  //   "converted" | "blocked" | "pending"
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

  // Initial pass.
  scan();

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
      sendResponse({ images: Array.from(registry.values()) });
      return;
    }
  });
})();
