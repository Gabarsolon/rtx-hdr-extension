// Lets you open a local picture or a whole local folder of pictures and
// HDR-convert them the same way as a directly-opened image tab. Files
// loaded through <input type="file"> come in as blob: URLs backed by data
// the user explicitly picked — they never taint a canvas, so unlike
// content.js there's no CORS fallback needed here.

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

let lastFolderFiles = []; // powers "back to folder" after viewing a single picture

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
  ctx.drawImage(sourceImg, 0, 0, w, h);
  const stream = canvas.captureStream(30);

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.play().catch(() => {});
  return video;
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

  const url = URL.createObjectURL(file);
  const probe = new Image();
  probe.onload = () => {
    const video = convertToVideo(probe);
    URL.revokeObjectURL(url);
    singleMediaEl.appendChild(video);
  };
  probe.onerror = () => {
    URL.revokeObjectURL(url);
    singleEl.style.display = "none";
    hintEl.textContent = "Couldn't load that file as an image.";
    hintEl.style.display = "block";
  };
  probe.src = url;
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
    cell.addEventListener("click", () => convertCell(cell, img));

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
  const video = convertToVideo(img);
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
});
