// Builds a real, standalone HDR still image file from a plain SDR source —
// a "gain map" JPEG (Google/Adobe's Ultra HDR format, ISO 21496-1): a
// normal baseline JPEG that any app can open, with a second, embedded
// grayscale JPEG describing how much brighter each pixel should be pushed
// on an HDR-capable display, plus XMP metadata describing that mapping.
// Recent Chrome, Android, and Windows Photos all recognize this format and
// render it visibly brighter/more vivid on HDR displays; everything else
// just sees the ordinary base JPEG.
//
// This is NOT a recovery of real HDR data — an 8-bit SDR source never had
// any extra dynamic range to begin with, and RTX Video HDR's own output is
// invisible to page/extension code entirely (see README). What this does
// is synthesize a plausible highlight boost (brighten bright regions,
// leave midtones/shadows alone) and package it in a format real HDR
// viewers will actually recognize and render as HDR — the same basic idea
// as any "AI HDR enhance" photo filter, just exported as a proper file
// instead of only ever existing as a live canvas.
//
// Exposed as window.RtxHdrExport so both content.js (content-script
// context) and viewer.js (extension-page context) can use it without a
// module bundler — content_scripts in manifest.json lists this file before
// content.js so they share one execution context per frame.
(function () {
  const MAX_GAIN_STOPS = 2.0; // log2 — 2 stops = up to 4x brighter in boosted highlights
  const HIGHLIGHT_THRESHOLD = 0.55; // normalized luma below this gets no boost at all

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  // Renders sourceEl (an <img>/<video>/<canvas>-like drawable) into a fresh
  // canvas at its natural size and computes a matching grayscale gain-map
  // canvas from it. Returns { baseCanvas, gainCanvas, maxStops }.
  function buildBaseAndGainCanvases(sourceEl, w, h) {
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = w;
    baseCanvas.height = h;
    const bctx = baseCanvas.getContext("2d");
    bctx.drawImage(sourceEl, 0, 0, w, h);

    const imageData = bctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const gainCanvas = document.createElement("canvas");
    gainCanvas.width = w;
    gainCanvas.height = h;
    const gctx = gainCanvas.getContext("2d");
    const gainData = gctx.createImageData(w, h);
    const gdata = gainData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      let stops = 0;
      if (y > HIGHLIGHT_THRESHOLD) {
        const t = (y - HIGHLIGHT_THRESHOLD) / (1 - HIGHLIGHT_THRESHOLD);
        stops = smoothstep(t) * MAX_GAIN_STOPS;
      }
      const v = Math.round((stops / MAX_GAIN_STOPS) * 255);
      gdata[i] = v;
      gdata[i + 1] = v;
      gdata[i + 2] = v;
      gdata[i + 3] = 255;
    }
    gctx.putImageData(gainData, 0, 0);

    return { baseCanvas, gainCanvas, maxStops: MAX_GAIN_STOPS };
  }

  function canvasToJpegBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/jpeg", quality);
    });
  }

  function buildXmpPacket(maxStops, gainMapByteLength) {
    return (
      `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="RTX HDR Booster">` +
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about=""` +
      ` xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"` +
      ` xmlns:Container="http://ns.google.com/photos/1.0/container/"` +
      ` xmlns:Item="http://ns.google.com/photos/1.0/container/item/"` +
      ` hdrgm:Version="1.0"` +
      ` hdrgm:BaseRenditionIsHDR="False"` +
      ` hdrgm:GainMapMin="0.0"` +
      ` hdrgm:GainMapMax="${maxStops.toFixed(4)}"` +
      ` hdrgm:Gamma="1.0"` +
      ` hdrgm:OffsetSDR="0.0"` +
      ` hdrgm:OffsetHDR="0.0"` +
      ` hdrgm:HDRCapacityMin="0.0"` +
      ` hdrgm:HDRCapacityMax="${maxStops.toFixed(4)}">` +
      `<Container:Directory>` +
      `<rdf:Seq>` +
      `<rdf:li rdf:parseType="Resource">` +
      `<Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/>` +
      `</rdf:li>` +
      `<rdf:li rdf:parseType="Resource">` +
      `<Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapByteLength}"/>` +
      `</rdf:li>` +
      `</rdf:Seq>` +
      `</Container:Directory>` +
      `</rdf:Description>` +
      `</rdf:RDF>` +
      `</x:xmpmeta>` +
      `<?xpacket end="w"?>`
    );
  }

  function buildXmpApp1Segment(xmpString) {
    const headerBytes = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
    const xmpBytes = new TextEncoder().encode(xmpString);
    const payload = new Uint8Array(headerBytes.length + xmpBytes.length);
    payload.set(headerBytes, 0);
    payload.set(xmpBytes, headerBytes.length);

    const segLen = payload.length + 2; // JPEG segment length includes its own 2 length bytes
    if (segLen > 0xffff) throw new Error("XMP segment too large for a single APP1 marker");

    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff;
    seg[1] = 0xe1; // APP1
    seg[2] = (segLen >> 8) & 0xff;
    seg[3] = segLen & 0xff;
    seg.set(payload, 4);
    return seg;
  }

  // Finds the byte offset to insert our APP1/XMP segment at: right after
  // SOI, but after any existing APP0/JFIF segment(s) so JFIF's "APP0 must
  // be first" convention is preserved for maximum compatibility.
  function findInsertionPoint(buf) {
    let pos = 2; // past SOI (FF D8)
    while (pos + 4 <= buf.length && buf[pos] === 0xff && buf[pos + 1] === 0xe0) {
      const len = (buf[pos + 2] << 8) | buf[pos + 3];
      pos += 2 + len;
    }
    return pos;
  }

  async function insertXmpSegment(jpegBlob, xmpString) {
    const buf = new Uint8Array(await jpegBlob.arrayBuffer());
    const app1 = buildXmpApp1Segment(xmpString);
    const insertAt = findInsertionPoint(buf);
    const out = new Uint8Array(buf.length + app1.length);
    out.set(buf.subarray(0, insertAt), 0);
    out.set(app1, insertAt);
    out.set(buf.subarray(insertAt), insertAt + app1.length);
    return out;
  }

  async function buildUltraHdrJpeg(sourceEl, w, h, quality) {
    const q = typeof quality === "number" ? quality : 0.92;
    const { baseCanvas, gainCanvas, maxStops } = buildBaseAndGainCanvases(sourceEl, w, h);

    const [baseBlob, gainBlob] = await Promise.all([
      canvasToJpegBlob(baseCanvas, q),
      canvasToJpegBlob(gainCanvas, 0.85),
    ]);

    const xmp = buildXmpPacket(maxStops, gainBlob.size);
    const baseWithXmp = await insertXmpSegment(baseBlob, xmp);

    const out = new Uint8Array(baseWithXmp.length + gainBlob.size);
    out.set(baseWithXmp, 0);
    out.set(new Uint8Array(await gainBlob.arrayBuffer()), baseWithXmp.length);
    return new Blob([out], { type: "image/jpeg" });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function hdrFilenameFor(originalName) {
    const base = (originalName || "image").replace(/\.[^./\\]+$/, "");
    return `${base}-hdr.jpg`;
  }

  window.RtxHdrExport = { buildUltraHdrJpeg, downloadBlob, hdrFilenameFor };
})();
