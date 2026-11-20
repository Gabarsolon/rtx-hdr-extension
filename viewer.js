// Lets you open a local picture or a whole local folder of pictures and
// HDR-convert them the same way as a directly-opened image tab. Files
// loaded through <input type="file"> come in as blob: URLs backed by data
// the user explicitly picked — they never taint a canvas, so unlike
// content.js there's no CORS fallback needed here.
//
// The single-picture view also offers "Download HDR (.jpg)" — builds a
// real Ultra HDR gain-map JPEG file via hdr-export.js (loaded before this
// script). See that file's top comment for what that actually is/isn't.

const hintEl = document.getElementById("hint");
const singleEl = document.getElementById("single");
const singleMediaEl = document.getElementById("singleMedia");
const backToGrid = document.getElementById("backToGrid");
const gridEl = document.getElementById("grid");
const pictureInput = document.getElementById("pictureInput");
const folderInput = document.getElementById("folderInput");
const openPictureBtn = document.getElementById("openPicture");
const openFolderBtn = document.getElementById("openFolder");
const convertAllBtn = document.getElementById("convertAll");
const downloadHdrBtn = document.getElementById("downloadHdr");
const toggleOriginalBtn = document.getElementById("toggleOriginal");
const hlProtectToggle = document.getElementById("hlProtectToggle");
const hlStrengthSlider = document.getElementById("hlStrengthSlider");
const hlStrengthVal = document.getElementById("hlStrengthVal");
const hlSliderContainer = document.getElementById("hlSliderContainer");

let lastFolderFiles = []; // powers "back to folder" after viewing a single picture
let currentSingle = null; // { img, name, video, canvas, ctx, w, h, showingVideo } for the picture showSingle() currently has open

if (window.chrome && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get({ highlightProtection: true, highlightStrength: 50 }, (res) => {
    if (hlProtectToggle) hlProtectToggle.checked = res.highlightProtection !== false;
    if (hlStrengthSlider) hlStrengthSlider.value = res.highlightStrength || 50;
    if (hlStrengthVal) hlStrengthVal.textContent = `${hlStrengthSlider.value}%`;
    if (hlSliderContainer) {
      hlSliderContainer.style.opacity = (hlProtectToggle && hlProtectToggle.checked) ? "1" : "0.4";
    }
    if (hlStrengthSlider && hlProtectToggle) {
      hlStrengthSlider.disabled = !hlProtectToggle.checked;
    }
  });
}

function applyHighlightRolloff(ctx, sourceImg, w, h, enabled, strength) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(sourceImg, 0, 0, w, h);
  if (!enabled || strength <= 0) return;

  const knee = Math.round(195 - (strength / 100) * 35);
  const maxVal = Math.round(255 - (strength / 100) * 60);
  const delta = 255 - knee;
  const diff = maxVal - knee;
  if (diff <= 0 || delta <= diff) return;

  const c = (delta - diff) / (delta * diff);
  const lut = new Uint8Array(256);
  for (let x = 0; x < 256; x++) {
    if (x <= knee) {
      lut[x] = x;
    } else {
      const u = x - knee;
      lut[x] = Math.round(knee + u / (1.0 + c * u));
    }
  }

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const len = d.length;
  for (let i = 0; i < len; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(imgData, 0, 0);
}

let updateRaf = null;
function updateSingleToneCurve() {
  if (!currentSingle || !currentSingle.showingVideo || !currentSingle.canvas) return;
  if (updateRaf) cancelAnimationFrame(updateRaf);
  updateRaf = requestAnimationFrame(() => {
    const enabled = hlProtectToggle ? hlProtectToggle.checked : true;
    const strength = hlStrengthSlider ? parseInt(hlStrengthSlider.value, 10) : 50;
    applyHighlightRolloff(currentSingle.ctx, currentSingle.img, currentSingle.w, currentSingle.h, enabled, strength);
  });
}

if (hlProtectToggle) {
  hlProtectToggle.addEventListener("change", () => {
    if (hlSliderContainer) hlSliderContainer.style.opacity = hlProtectToggle.checked ? "1" : "0.4";
    if (hlStrengthSlider) hlStrengthSlider.disabled = !hlProtectToggle.checked;
    if (window.chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ highlightProtection: hlProtectToggle.checked });
    }
    updateSingleToneCurve();
  });
}

if (hlStrengthSlider) {
  hlStrengthSlider.addEventListener("input", () => {
    if (hlStrengthVal) hlStrengthVal.textContent = `${hlStrengthSlider.value}%`;
    updateSingleToneCurve();
  });
  hlStrengthSlider.addEventListener("change", () => {
    if (window.chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ highlightStrength: parseInt(hlStrengthSlider.value, 10) });
    }
  });
}

function isImageFile(file) {
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name);
}

openPictureBtn.addEventListener("click", () => pictureInput.click());
openFolderBtn.addEventListener("click", () => folderInput.click());

pictureInput.addEventListener("change", () => {
  const file = pictureInput.files[0];
  pictureInput.value = "";
  if (file) showSingle(file);
});

folderInput.addEventListener("change", () => {
  const files = Array.from(folderInput.files).filter(isImageFile);
  folderInput.value = "";
  if (files.length === 0) {
    hintEl.textContent = "No images found in that folder.";
    hintEl.style.display = "block";
    gridEl.style.display = "none";
    singleEl.style.display = "none";
    convertAllBtn.style.display = "none";
    return;
  }
  showGrid(files);
});

// Draws sourceImg into a canvas and returns a captureStream()-backed
// <video> — same technique as content.js, just without needing the
// CORS-bypass fallback since local files are always canvas-clean.
function convertToVideo(sourceImg) {
  const w = sourceImg.naturalWidth;
  const h = sourceImg.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const enabled = hlProtectToggle ? hlProtectToggle.checked : true;
  const strength = hlStrengthSlider ? parseInt(hlStrengthSlider.value, 10) : 50;
  applyHighlightRolloff(ctx, sourceImg, w, h, enabled, strength);
  const stream = canvas.captureStream(30);

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.play().catch(() => {});
  return { video, canvas, ctx, w, h };
}

function showSingle(file) {
  hintEl.style.display = "none";
  gridEl.style.display = "none";
  singleEl.style.display = "block";
  backToGrid.style.display = lastFolderFiles.length ? "block" : "none";

  // Stop any previous stream's tracks before dropping the old <video>.
  singleMediaEl.querySelectorAll("video").forEach((v) => {
    if (v.srcObject) v.srcObject.getTracks().forEach((t) => t.stop());
  });
  singleMediaEl.innerHTML = "";

  downloadHdrBtn.style.display = "none";
  toggleOriginalBtn.style.display = "none";
  currentSingle = null;

  const url = URL.createObjectURL(file);
  const probe = new Image();
  probe.onload = () => {
    const { video, canvas, ctx, w, h } = convertToVideo(probe);
    URL.revokeObjectURL(url);
    singleMediaEl.appendChild(video);
    requestVideoFullscreen(video);
    // probe stays fully usable after revoking its blob URL — once an <img>
    // has decoded, the bitmap lives with the element, not the URL.
    currentSingle = { img: probe, name: file.name, video, canvas, ctx, w, h, showingVideo: true };
    downloadHdrBtn.style.display = "inline-block";
    toggleOriginalBtn.style.display = "inline-block";
    toggleOriginalBtn.textContent = "Show Original Image";
  };
  probe.onerror = () => {
    URL.revokeObjectURL(url);
    singleEl.style.display = "none";
    hintEl.textContent = "Couldn't load that file as an image.";
    hintEl.style.display = "block";
  };
  probe.src = url;
}

toggleOriginalBtn.addEventListener("click", () => {
  if (!currentSingle) return;
  if (currentSingle.showingVideo) {
    // Switch to the plain image: stop the stream and swap it back in.
    if (currentSingle.video.srcObject) {
      currentSingle.video.srcObject.getTracks().forEach((t) => t.stop());
    }
    currentSingle.video.replaceWith(currentSingle.img);
    currentSingle.showingVideo = false;
    toggleOriginalBtn.textContent = "Convert to HDR Video";
  } else {
    // Re-convert: build a fresh video from the same already-loaded image.
    const { video, canvas, ctx, w, h } = convertToVideo(currentSingle.img);
    currentSingle.img.replaceWith(video);
    currentSingle.video = video;
    currentSingle.canvas = canvas;
    currentSingle.ctx = ctx;
    currentSingle.w = w;
    currentSingle.h = h;
    currentSingle.showingVideo = true;
    toggleOriginalBtn.textContent = "Show Original Image";
  }
});

downloadHdrBtn.addEventListener("click", async () => {
  if (!currentSingle || !window.RtxHdrExport) return;
  downloadHdrBtn.disabled = true;
  downloadHdrBtn.textContent = "Building HDR file...";
  try {
    const { img, name } = currentSingle;
    const blob = await window.RtxHdrExport.buildUltraHdrJpeg(img, img.naturalWidth, img.naturalHeight);
    window.RtxHdrExport.downloadBlob(blob, window.RtxHdrExport.hdrFilenameFor(name));
  } catch (e) {
    console.warn("RTX HDR Viewer: HDR export failed", e);
  } finally {
    downloadHdrBtn.disabled = false;
    downloadHdrBtn.textContent = "Download HDR (.jpg)";
  }
});

// Browsers only grant fullscreen off a user gesture, and the gesture from
// the original click can, in principle, have expired by the time the image
// finishes decoding a tick later — so this is attempted immediately, but a
// double-click on the video is wired up as a manual fallback/toggle in case
// the automatic request gets rejected.
function requestVideoFullscreen(video) {
  video.requestFullscreen().catch((err) => {
    console.warn("RTX HDR Viewer: auto-fullscreen was blocked, double-click the video to fullscreen it.", err);
  });
  video.addEventListener("dblclick", () => {
    if (document.fullscreenElement === video) {
      document.exitFullscreen();
    } else {
      video.requestFullscreen().catch(() => {});
    }
  });
}

function showGrid(files) {
  lastFolderFiles = files;
  hintEl.style.display = "none";
  singleEl.style.display = "none";
  gridEl.style.display = "grid";
  gridEl.innerHTML = "";
  convertAllBtn.style.display = "inline-block";

  for (const file of files) {
    const cell = document.createElement("div");
    cell.className = "cell";

    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.loading = "lazy";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = file.name;
    name.title = file.webkitRelativePath || file.name;

    cell.appendChild(img);
    cell.appendChild(name);
    // Clicking a thumbnail opens the full, fullscreen-requesting single
    // view for that file — "Convert All" below is what does the small
    // in-place conversion, for browsing the grid itself as HDR previews.
    cell.addEventListener("click", () => showSingle(file));

    gridEl.appendChild(cell);
  }
}

function convertCell(cell, img) {
  if (cell.dataset.converted) return;
  if (!img.complete || img.naturalWidth === 0) {
    img.addEventListener("load", () => convertCell(cell, img), { once: true });
    return;
  }
  cell.dataset.converted = "1";
  const url = img.src;
  const { video } = convertToVideo(img);
  img.replaceWith(video);
  URL.revokeObjectURL(url);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "HDR";
  cell.appendChild(badge);
}

convertAllBtn.addEventListener("click", () => {
  gridEl.querySelectorAll(".cell").forEach((cell) => {
    const img = cell.querySelector("img");
    if (img) convertCell(cell, img);
  });
});

backToGrid.addEventListener("click", () => {
  singleMediaEl.querySelectorAll("video").forEach((v) => {
    if (v.srcObject) v.srcObject.getTracks().forEach((t) => t.stop());
  });
  singleEl.style.display = "none";
  gridEl.style.display = "grid";
  currentSingle = null;
  downloadHdrBtn.style.display = "none";
  toggleOriginalBtn.style.display = "none";
});
