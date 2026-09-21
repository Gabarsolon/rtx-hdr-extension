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

  // Finds the byte offset to insert our new segments at: right after SOI,
  // but after any existing APP0/JFIF segment(s) so JFIF's "APP0 must be
  // first" convention is preserved for maximum compatibility.
  function findInsertionPoint(buf) {
    let pos = 2; // past SOI (FF D8)
    while (pos + 4 <= buf.length && buf[pos] === 0xff && buf[pos + 1] === 0xe0) {
      const len = (buf[pos + 2] << 8) | buf[pos + 3];
      pos += 2 + len;
    }
    return pos;
  }

  // CIPA MPF (Multi-Picture Format, DC-007) APP2 segment: a binary
  // TIFF-style index giving the byte offset/length of each embedded image.
  // The XMP Container metadata above *describes* the gain map, but it's
  // this segment real HDR viewers (Windows Photos included) actually use
  // to locate it in the file — Google's own Ultra HDR files carry both,
  // and a first version of this exporter that only had the XMP half
  // produced files that opened fine but never rendered as HDR anywhere.
  //
  // Structure (all multi-byte fields big-endian, "MM" TIFF byte order):
  //   APP2 marker(2) + length(2) + "MPF\0"(4)
  //   -- TIFF header (offset 0 from here) --
  //   byte-order "MM"(2) + magic 0x002A(2) + IFD0 offset=8(4)
  //   -- IFD0 --
  //   entry count=3(2)
  //     0xB000 MPFVersion,    UNDEFINED, count 4,  "0100"
  //     0xB001 NumberOfImages,LONG,      count 1,  2
  //     0xB002 MPEntry,       UNDEFINED, count 32, offset to entry array
  //   next-IFD offset=0(4)
  //   -- MP Entry array (2 entries x 16 bytes) --
  //     image 0 (primary):  attribute=0x80030000 (representative + JPEG
  //                          Baseline MP Primary Image), size, offset=0
  //     image 1 (gain map): attribute=0x00000000 (JPEG, undefined type),
  //                          size, offset (from TIFF header start)
  const MPF_TIFF_HEADER_LEN = 8;
  const MPF_IFD0_LEN = 2 + 3 * 12 + 4; // count + 3 entries + next-IFD offset
  const MPF_ENTRIES_LEN = 2 * 16;
  const MPF_SEGMENT_TOTAL_LEN = 2 + 2 + 4 + MPF_TIFF_HEADER_LEN + MPF_IFD0_LEN + MPF_ENTRIES_LEN; // marker+len+id+...

  function buildMpfSegment(primarySize, secondarySize, secondaryOffsetFromTiffHeader) {
    const buf = new ArrayBuffer(MPF_SEGMENT_TOTAL_LEN);
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    let p = 0;

    bytes[p++] = 0xff;
    bytes[p++] = 0xe2; // APP2
    view.setUint16(p, MPF_SEGMENT_TOTAL_LEN - 2, false); // length excludes the marker itself
    p += 2;
    bytes.set([0x4d, 0x50, 0x46, 0x00], p); // "MPF\0"
    p += 4;

    // TIFF header
    bytes.set([0x4d, 0x4d, 0x00, 0x2a], p); // "MM" + magic 42
    p += 4;
    view.setUint32(p, MPF_TIFF_HEADER_LEN, false); // offset to IFD0
    p += 4;

    // IFD0
    view.setUint16(p, 3, false);
    p += 2;

    view.setUint16(p, 0xb000, false); p += 2; // MPFVersion
    view.setUint16(p, 7, false); p += 2; // UNDEFINED
    view.setUint32(p, 4, false); p += 4;
    bytes.set([0x30, 0x31, 0x30, 0x30], p); p += 4; // "0100"

    view.setUint16(p, 0xb001, false); p += 2; // NumberOfImages
    view.setUint16(p, 4, false); p += 2; // LONG
    view.setUint32(p, 1, false); p += 4;
    view.setUint32(p, 2, false); p += 4;

    view.setUint16(p, 0xb002, false); p += 2; // MPEntry
    view.setUint16(p, 7, false); p += 2; // UNDEFINED
    view.setUint32(p, MPF_ENTRIES_LEN, false); p += 4;
    view.setUint32(p, MPF_TIFF_HEADER_LEN + MPF_IFD0_LEN, false); p += 4; // offset to entry array

    view.setUint32(p, 0, false); // next IFD offset
    p += 4;

    // MP Entry array
    view.setUint32(p, 0x80030000, false); p += 4; // image 0: representative + Baseline MP Primary Image
    view.setUint32(p, primarySize, false); p += 4;
    view.setUint32(p, 0, false); p += 4; // offset 0 == this file
    view.setUint16(p, 0, false); p += 2;
    view.setUint16(p, 0, false); p += 2;

    view.setUint32(p, 0x00000000, false); p += 4; // image 1: gain map, JPEG, undefined type
    view.setUint32(p, secondarySize, false); p += 4;
    view.setUint32(p, secondaryOffsetFromTiffHeader, false); p += 4;
    view.setUint16(p, 0, false); p += 2;
    view.setUint16(p, 0, false); p += 2;

    return bytes;
  }

  // Assembles the final primary-image bytes: original base JPEG with an
  // MPF APP2 segment and an XMP APP1 segment inserted after SOI/APP0, sized
  // and offset so the MP Entry for image 1 correctly points at the gain
  // map JPEG that gets appended immediately after this in the final file.
  async function assemblePrimaryWithMetadata(baseBlob, xmpString, gainMapByteLength) {
    const buf = new Uint8Array(await baseBlob.arrayBuffer());
    const insertAt = findInsertionPoint(buf);
    const restLen = buf.length - insertAt;
    const xmpSeg = buildXmpApp1Segment(xmpString);

    const primarySize = insertAt + MPF_SEGMENT_TOTAL_LEN + xmpSeg.length + restLen;
    // Bytes remaining after the MPF segment's own TIFF-header start (i.e.
    // after its marker+length+"MPF\0") that come before the gain map's SOI:
    // the rest of the MPF segment itself, then the XMP segment, then the
    // rest of the original base JPEG.
    const secondaryOffsetFromTiffHeader = (MPF_SEGMENT_TOTAL_LEN - 8) + xmpSeg.length + restLen;

    const mpfSeg = buildMpfSegment(primarySize, gainMapByteLength, secondaryOffsetFromTiffHeader);

    const out = new Uint8Array(primarySize);
    let p = 0;
    out.set(buf.subarray(0, insertAt), p); p += insertAt;
    out.set(mpfSeg, p); p += mpfSeg.length;
    out.set(xmpSeg, p); p += xmpSeg.length;
    out.set(buf.subarray(insertAt), p);
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
    const primaryFinal = await assemblePrimaryWithMetadata(baseBlob, xmp, gainBlob.size);

    const out = new Uint8Array(primaryFinal.length + gainBlob.size);
    out.set(primaryFinal, 0);
    out.set(new Uint8Array(await gainBlob.arrayBuffer()), primaryFinal.length);
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
