// The content script runs automatically on every page and keeps a registry
// of detected images; the popup (popup.js) reads that registry directly via
// messaging and drives its own "Rescan" button, so this worker's job is just
// badge bookkeeping plus privileged cross-origin image fetches on behalf of
// the content script: extensions with host_permissions can fetch
// cross-origin resources without CORS restrictions (unlike page JS), so we
// use that to pull down images whose CDN doesn't send CORS headers, and hand
// them back as data: URLs — which never taint a canvas.

function blobToDataURL(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    return `data:${blob.type || "image/jpeg"};base64,${base64}`;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "rtx-hdr-count" && sender.tab && sender.tab.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: String(msg.count) });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#76b900" }); // nvidia green
    return;
  }

  if (msg.type === "rtx-hdr-fetch-image") {
    (async () => {
      try {
        const res = await fetch(msg.url, { credentials: "omit" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        const dataUrl = await blobToDataURL(blob);
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // keep the message channel open for the async sendResponse
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
