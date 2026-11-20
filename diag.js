// Diagnostics: explains why RTX Video HDR / VSR may not engage on a page's
// video. Nothing here changes the page — it only reads styles and geometry.
// Exposed as window.RtxHdrDiag for content.js (same isolated world), which
// logs a one-line summary when a video starts playing and builds the full
// report on request (Alt+Shift+D, or the popup's Diagnose button).
(() => {
  const OPAQUE_ATTR = "data-rtx-hdr-opaque";

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function describe(el) {
    if (!el || !el.tagName) return "(none)";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (cls.length) s += "." + cls.join(".");
    return trunc(s, 70);
  }

  // Origin + path only (no query string), and blob:/data: collapsed.
  function shortUrl(u) {
    if (!u) return "(none)";
    if (u.startsWith("blob:")) return "blob: (MSE / object URL)";
    if (u.startsWith("data:")) return "data:";
    try {
      const x = new URL(u, location.href);
      return trunc(x.origin + x.pathname, 90);
    } catch (e) {
      return trunc(u, 90);
    }
  }

  const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;

  function allVideos(root, out) {
    for (const v of root.querySelectorAll("video")) out.push(v);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) allVideos(el.shadowRoot, out);
    return out;
  }

  function bigVisible(el, minArea) {
    const r = el.getBoundingClientRect();
    return r.width * r.height >= minArea && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // CSS that keeps Chrome from giving a video its own overlay layer.
  function styleIssues(cs, isVideo) {
    const out = [];
    const op = parseFloat(cs.opacity);
    if (op < 1) out.push(`opacity ${op}`);
    if (cs.filter && cs.filter !== "none") out.push(`filter ${trunc(cs.filter, 40)}`);
    if (cs.backdropFilter && cs.backdropFilter !== "none") out.push(`backdrop-filter ${trunc(cs.backdropFilter, 40)}`);
    if (cs.clipPath && cs.clipPath !== "none") out.push(`clip-path ${trunc(cs.clipPath, 40)}`);
    const mask = cs.maskImage || cs.webkitMaskImage;
    if (mask && mask !== "none") out.push("mask");
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") out.push(`mix-blend-mode ${cs.mixBlendMode}`);
    if (cs.transform && cs.transform !== "none") {
      if (cs.transform.startsWith("matrix3d")) out.push("3D transform");
      else {
        const m = cs.transform.match(/matrix\(([^)]+)\)/);
        const n = m ? m[1].split(",").map(parseFloat) : [];
        out.push(n[1] || n[2] ? `rotate/skew transform ${trunc(cs.transform, 50)}` : `transform ${trunc(cs.transform, 50)}`);
      }
    }
    if (cs.perspective && cs.perspective !== "none") out.push("perspective");
    if (cs.willChange && cs.willChange !== "auto") out.push(`will-change ${trunc(cs.willChange, 30)}`);
    if (cs.isolation === "isolate") out.push("isolation: isolate");
    if (cs.visibility !== "visible") out.push(`visibility ${cs.visibility}`);
    const rounded = parseFloat(cs.borderTopLeftRadius) > 0 || parseFloat(cs.borderBottomRightRadius) > 0;
    if (rounded && (isVideo || cs.overflow !== "visible")) out.push(isVideo ? "rounded corners on the video" : "rounded corners + overflow clip");
    return out;
  }

  // Walks the video and every ancestor (through shadow roots) and lists the CSS blockers.
  function ancestorIssues(v, ctx) {
    const found = [];
    for (let el = v; el; el = parentOf(el)) {
      let cs;
      try {
        cs = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      const iss = styleIssues(cs, el === v);
      const forced = el.hasAttribute && el.hasAttribute(OPAQUE_ATTR);
      if (forced) {
        // Computed opacity is what Chrome uses: if it is still < 1 the override did not take.
        iss.push(iss.some((s) => s.startsWith("opacity ")) ? "!! opacity forcing NOT effective (page overrides it)" : "opacity forced to 1 by this extension (worked)");
      }
      if (iss.length) found.push({ el, iss, forced });
    }
    return found;
  }

  // Elements drawn over the video that can stop the overlay: blur, blend
  // mode or filter on top. Uses elementsFromPoint, so a pointer-events:none
  // overlay is invisible to it (noted in the report).
  function coveringIssues(v) {
    const r = v.getBoundingClientRect();
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth);
    const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
    if (x1 - x0 < 4 || y1 - y0 < 4) return { covering: [], note: "video is off screen" };
    const pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    const seen = new Map();
    for (const [fx, fy] of pts) {
      const x = x0 + (x1 - x0) * fx;
      const y = y0 + (y1 - y0) * fy;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === v || el.contains(v) || v.contains(el)) break; // reached the video's own layer
        if (!seen.has(el)) seen.set(el, true);
      }
    }
    const covering = [];
    for (const el of seen.keys()) {
      const cs = getComputedStyle(el);
      const iss = [];
      if (cs.backdropFilter && cs.backdropFilter !== "none") iss.push("backdrop-filter");
      if (cs.mixBlendMode && cs.mixBlendMode !== "normal") iss.push(`mix-blend-mode ${cs.mixBlendMode}`);
      if (cs.filter && cs.filter !== "none") iss.push("filter");
      const bg = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
      const a = bg ? (bg[1].split(",").length > 3 ? parseFloat(bg[1].split(",")[3]) : 1) : 0;
      if (a >= 0.9) iss.push("opaque background");
      covering.push({ el, iss });
    }
    return { covering, note: "" };
  }

  // The short list used for the one-line log when a video starts playing.
  function blockers(v) {
    const out = [];
    for (const { el, iss, forced } of ancestorIssues(v)) {
      if (forced && iss.length === 1) continue;
      out.push(`${el === v ? "video" : describe(el)}: ${iss.filter((s) => !s.startsWith("opacity forced")).join(", ")}`);
    }
    const { covering } = coveringIssues(v);
    for (const { el, iss } of covering) {
      const bad = iss.filter((s) => s !== "opaque background");
      if (bad.length) out.push(`over the video ${describe(el)}: ${bad.join(", ")}`);
    }
    return out;
  }

  function summary(v) {
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const b = blockers(v);
    return (
      `video playing: ${v.videoWidth}x${v.videoHeight}, ` +
      `${v.mediaKeys ? "DRM (EME), " : ""}${v.srcObject ? "srcObject, " : ""}` +
      `decoded ${v.webkitDecodedFrameCount ?? "?"} / dropped ${q ? q.droppedVideoFrames : "?"} frames, ` +
      (b.length ? `CSS blockers: ${b.join(" | ")}` : "no CSS blockers found (run Alt+Shift+D for the full report)")
    );
  }

  function videoReport(v, ctx) {
    const L = [];
    const r = v.getBoundingClientRect();
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const cs = getComputedStyle(v);
    L.push(`VIDEO ${describe(v)}  ${v.paused ? "PAUSED" : v.ended ? "ENDED" : "playing"}  readyState ${v.readyState}`);
    L.push(`  source: ${v.srcObject ? "srcObject (MediaStream)" : shortUrl(v.currentSrc || v.src)}`);
    L.push(`  stream ${v.videoWidth}x${v.videoHeight}, on screen ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}, devicePixelRatio ${devicePixelRatio}`);
    L.push(`  frames: decoded ${v.webkitDecodedFrameCount ?? "?"}, total ${q ? q.totalVideoFrames : "?"}, dropped ${q ? q.droppedVideoFrames : "?"}`);
    L.push(`  DRM (EME mediaKeys): ${v.mediaKeys ? "YES" : "no"}   object-fit ${cs.objectFit}   controls ${v.controls}`);
    if (v.disablePictureInPicture) L.push("  disablePictureInPicture is set");
    const anc = ancestorIssues(v, ctx);
    if (anc.length === 0) L.push("  CSS on the video and its ancestors: nothing that blocks the overlay");
    for (const { el, iss } of anc) L.push(`  ${el === v ? "video" : "ancestor " + describe(el)}: ${iss.join(", ")}`);
    const cov = coveringIssues(v);
    if (cov.note) L.push(`  over the video: ${cov.note}`);
    else if (cov.covering.length === 0) L.push("  over the video: nothing found (pointer-events:none overlays can't be seen from here)");
    for (const { el, iss } of cov.covering) L.push(`  over the video: ${describe(el)}${iss.length ? " [" + iss.join(", ") + "]" : ""}`);
    return L;
  }

  // Codecs the page gave MediaSource (recorded by mse-spy.js), each checked
  // with Chrome's own decode-capability query: powerEfficient = hardware.
  async function mseLines() {
    const L = [];
    let list = [];
    try {
      list = JSON.parse(document.documentElement.getAttribute("data-rtx-hdr-mse") || "[]");
    } catch (e) {}
    for (const type of list) {
      let extra = "";
      if (/^\s*video|avc|hev|hvc|vp0?9|av01/i.test(type) && navigator.mediaCapabilities) {
        try {
          // Ask about the video codec alone: a type that also lists the audio
          // codec (video/mp4;codecs=mp4a...,av01...) is rejected as a video config.
          const mime = type.split(";")[0].trim();
          const codecs = ((type.match(/codecs\s*=\s*"?([^"]+)"?/i) || [])[1] || "").split(",").map((c) => c.trim());
          const vc = codecs.find((c) => /^(avc|hev|hvc|vp0?[89]|av01)/i.test(c));
          const info = await navigator.mediaCapabilities.decodingInfo({
            type: "media-source",
            video: { contentType: vc ? `${mime}; codecs="${vc}"` : type, width: 1920, height: 1080, bitrate: 4e6, framerate: 30 },
          });
          extra = ` -> supported ${info.supported}, smooth ${info.smooth}, hardware (powerEfficient) ${info.powerEfficient}`;
        } catch (e) {
          extra = " -> capability query failed";
        }
      }
      L.push(`  MSE source buffer: ${type}${extra}`);
    }
    if (!list.length) L.push("  MSE source buffers seen: none (not MSE, or created before the extension attached)");
    return L;
  }

  async function frameReport(ctx) {
    const videos = allVideos(document, []);
    const canvases = [...document.querySelectorAll("canvas")].filter((c) => bigVisible(c, 100 * 100));
    const iframes = [...document.querySelectorAll("iframe")].filter((f) => bigVisible(f, 100 * 100));
    const isTop = window === window.top;
    if (!isTop && videos.length === 0 && canvases.length === 0) return null;

    const L = [];
    L.push(`--- frame: ${isTop ? "TOP" : "IFRAME"} ${shortUrl(location.href)}`);
    L.push(
      `extension: unblock ${ctx.unblockVideos ? "on" : "off"}, auto-convert ${ctx.autoConvertAll ? "on" : "off"}, ` +
        `photo pages ${ctx.convertPhotoPages ? "on" : "off"}`
    );
    L.push(
      `chrome sees HDR display: ${matchMedia("(dynamic-range: high)").matches}, video HDR: ${matchMedia("(video-dynamic-range: high)").matches}`
    );
    L.push(`${videos.length} <video>, ${canvases.length} big canvas, ${iframes.length} big iframe in this frame`);
    L.push(`fullscreen element: ${document.fullscreenElement ? describe(document.fullscreenElement) : "none"}`);
    const playing = videos.filter((v) => !v.paused && !v.ended && bigVisible(v, 1));
    if (playing.length > 1) L.push(`!! ${playing.length} videos playing on screen at once (Chrome gives one layer to the best one; others can block it)`);
    for (const v of videos) for (const line of videoReport(v, ctx)) L.push(line);
    if (videos.length) for (const line of await mseLines()) L.push(line);
    if (videos.length === 0) {
      if (canvases.length) L.push("NO <video> in this frame, but big canvases: the player may draw frames itself (WebGL/2D canvas); RTX never sees that");
      for (const c of canvases) L.push(`  canvas ${describe(c)} ${c.width}x${c.height}`);
      for (const f of iframes) L.push(`  iframe ${describe(f)} -> ${shortUrl(f.src)}`);
    }
    return L.join("\n");
  }

  window.RtxHdrDiag = { summary, frameReport, describe };
})();
