// Runs in the page's own JS world at document_start, before any player
// script. It only *records* which MIME/codec strings the page hands to
// MediaSource.addSourceBuffer (e.g. video/mp4; codecs="avc1.640028"), in a
// data attribute on <html> that diag.js reads for its report. The original
// method is called unchanged, so the page behaves exactly as before.
(() => {
  try {
    const proto = window.MediaSource && window.MediaSource.prototype;
    if (!proto || proto.__rtxHdrSpy) return;
    const orig = proto.addSourceBuffer;
    proto.addSourceBuffer = function (type) {
      try {
        const root = document.documentElement;
        const list = JSON.parse(root.getAttribute("data-rtx-hdr-mse") || "[]");
        list.push(String(type));
        root.setAttribute("data-rtx-hdr-mse", JSON.stringify(list.slice(-6)));
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    Object.defineProperty(proto, "__rtxHdrSpy", { value: true });
  } catch (e) {}
})();
