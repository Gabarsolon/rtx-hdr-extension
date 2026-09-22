const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const rescanBtn = document.getElementById("rescan");
const revertAllBtn = document.getElementById("revertAll");
const hintEl = document.getElementById("hint");
const autoToggle = document.getElementById("autoToggle");
const openLocalBtn = document.getElementById("openLocal");

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

// Builds a small per-row action button that sends `msgType` (with the
// item's src) to the content script and reloads the list once it responds
// — used for the HDR-download, revert, and convert-now row actions.
function makeRowActionBtn(label, title, msgType, src, extraClass) {
  const btn = document.createElement("button");
  btn.className = extraClass ? `rowActionBtn ${extraClass}` : "rowActionBtn";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (activeTabId == null) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "...";
    chrome.tabs.sendMessage(activeTabId, { type: msgType, src }, (resp) => {
      void chrome.runtime.lastError;
      if (!resp || !resp.ok) {
        console.warn(`RTX HDR Booster: ${msgType} failed`, resp && resp.error);
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      // Revert/convert change the item's status — refresh the list so the
      // row reflects it. The download action doesn't change anything, so
      // just restore this button in place.
      if (msgType === "rtx-hdr-download-image") {
        btn.disabled = false;
        btn.textContent = original;
      } else {
        loadImages();
      }
    });
  });
  return btn;
}

function render(items, isImagePage, autoConvertAll) {
  listEl.innerHTML = "";
  emptyEl.textContent = "No images, videos, or streams detected on this tab yet.";

  const activeConversion = isImagePage || autoConvertAll;
  hintEl.style.display = activeConversion ? "none" : "block";

  if (!items || items.length === 0) {
    emptyEl.style.display = "block";
    countEl.textContent = "";
    return;
  }
  emptyEl.style.display = "none";

  const streamCount = items.filter((i) => i.kind === "stream").length;
  const videoCount = items.filter((i) => i.kind === "video").length;
  const imageCount = items.length - videoCount - streamCount;
  const converted = items.filter((i) => i.status === "converted").length;
  const blocked = items.filter((i) => i.status === "blocked").length;
  countEl.textContent = activeConversion
    ? `${imageCount} images (${converted} converted, ${blocked} blocked) · ${videoCount} videos · ${streamCount} streams`
    : `${imageCount} images · ${videoCount} videos · ${streamCount} streams · click an openable row to open it`;

  for (const item of items) {
    const li = document.createElement("li");

    let thumb;
    if (item.kind === "video" || item.kind === "stream") {
      thumb = document.createElement("div");
      thumb.className = "thumb video-thumb";
      thumb.textContent = item.kind === "stream" ? "📡" : "🎬";
    } else {
      thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.src = item.src;
      thumb.loading = "lazy";
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const srcEl = document.createElement("div");
    srcEl.className = "src";
    srcEl.textContent = item.label || filenameOf(item.src);
    srcEl.title = item.label ? `${item.label} — no stable URL to open` : item.src;
    const dimsEl = document.createElement("div");
    dimsEl.className = "dims";
    dimsEl.textContent = item.width && item.height ? `${item.width}×${item.height}` : "";
    meta.appendChild(srcEl);
    meta.appendChild(dimsEl);

    const kindTag = document.createElement("span");
    kindTag.className = `tag ${item.kind}`;
    kindTag.textContent = item.kind === "video" ? "VID" : item.kind === "stream" ? "STREAM" : "IMG";

    li.appendChild(thumb);
    li.appendChild(meta);
    li.appendChild(kindTag);

    if (item.kind === "image") {
      const { text, cls } = statusLabel(item);
      const badge = document.createElement("span");
      badge.className = `badge ${cls}`;
      badge.textContent = text;
      if (item.reason) badge.title = item.reason;
      li.appendChild(badge);

      if (item.status === "converted") {
        li.appendChild(makeRowActionBtn("HDR ⇩", "Download as a real Ultra HDR (.jpg) file", "rtx-hdr-download-image", item.src));
        li.appendChild(makeRowActionBtn("↺ Revert", "Switch this back to a plain image", "rtx-hdr-revert-image", item.src));
      } else if (item.status === "detected") {
        li.appendChild(makeRowActionBtn("▶ Convert", "Convert this image now", "rtx-hdr-reconvert-image", item.src, "convert"));
      }
    }

    if (item.openable === false) {
      li.classList.add("not-openable");
      li.title = "No stable URL to open (live/WebRTC stream) — this is a detection-only listing.";
    } else {
      li.addEventListener("click", () => {
        chrome.tabs.create({ url: item.src });
      });
    }

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
    render(resp && resp.items, resp && resp.isImagePage, resp && resp.autoConvertAll);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  activeTabId = tab.id;
  loadImages();
});

chrome.storage.local.get({ autoConvertAll: true }, (result) => {
  autoToggle.checked = !!result.autoConvertAll;
});

autoToggle.addEventListener("change", () => {
  chrome.storage.local.set({ autoConvertAll: autoToggle.checked }, () => {
    if (chrome.runtime.lastError) {
      console.warn("RTX HDR Booster: failed to save toggle", chrome.runtime.lastError);
    }
    setTimeout(loadImages, 400); // give the content script's storage listener a moment to react
  });
});

openLocalBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

rescanBtn.addEventListener("click", () => {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: "rtx-hdr-rescan" }, () => {
    void chrome.runtime.lastError; // ignore if content script isn't present
    setTimeout(loadImages, 600);
  });
});

revertAllBtn.addEventListener("click", () => {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: "rtx-hdr-revert-all" }, (resp) => {
    void chrome.runtime.lastError;
    loadImages();
  });
});
