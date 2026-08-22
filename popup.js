const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const rescanBtn = document.getElementById("rescan");
const hintEl = document.getElementById("hint");

let activeTabId = null;

function statusLabel(item) {
  if (item.status === "converted") return { text: "HDR", cls: "converted" };
  if (item.status === "blocked") return { text: "blocked", cls: "blocked" };
  if (item.status === "detected") return { text: "found", cls: "detected" };
  return { text: "pending", cls: "pending" };
}

function filenameOf(src) {
  try {
    const u = new URL(src);
    const parts = u.pathname.split("/");
    return parts[parts.length - 1] || src;
  } catch (e) {
    return src;
  }
}

function render(images, isImagePage) {
  listEl.innerHTML = "";
  emptyEl.textContent = "No images detected on this tab yet.";

  hintEl.style.display = isImagePage ? "none" : "block";

  if (!images || images.length === 0) {
    emptyEl.style.display = "block";
    countEl.textContent = "";
    return;
  }
  emptyEl.style.display = "none";

  const converted = images.filter((i) => i.status === "converted").length;
  const blocked = images.filter((i) => i.status === "blocked").length;
  countEl.textContent = isImagePage
    ? `${images.length} detected · ${converted} converted · ${blocked} blocked`
    : `${images.length} detected · click one to open it directly`;

  for (const item of images) {
    const li = document.createElement("li");

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = item.src;
    thumb.loading = "lazy";

    const meta = document.createElement("div");
    meta.className = "meta";
    const srcEl = document.createElement("div");
    srcEl.className = "src";
    srcEl.textContent = filenameOf(item.src);
    srcEl.title = item.src;
    const dimsEl = document.createElement("div");
    dimsEl.className = "dims";
    dimsEl.textContent = item.width && item.height ? `${item.width}×${item.height}` : "";
    meta.appendChild(srcEl);
    meta.appendChild(dimsEl);

    const { text, cls } = statusLabel(item);
    const badge = document.createElement("span");
    badge.className = `badge ${cls}`;
    badge.textContent = text;
    if (item.reason) badge.title = item.reason;

    li.appendChild(thumb);
    li.appendChild(meta);
    li.appendChild(badge);

    li.addEventListener("click", () => {
      chrome.tabs.create({ url: item.src });
    });

    listEl.appendChild(li);
  }
}

function loadImages() {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: "rtx-hdr-get-images" }, (resp) => {
    if (chrome.runtime.lastError) {
      countEl.textContent = "";
      hintEl.style.display = "none";
      emptyEl.textContent = "Can't reach this page (extension pages, chrome:// tabs, or a page loaded before install).";
      emptyEl.style.display = "block";
      listEl.innerHTML = "";
      return;
    }
    render(resp && resp.images, resp && resp.isImagePage);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  activeTabId = tab.id;
  loadImages();
});

rescanBtn.addEventListener("click", () => {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: "rtx-hdr-rescan" }, () => {
    void chrome.runtime.lastError; // ignore if content script isn't present
    setTimeout(loadImages, 600);
  });
});
