# RTX HDR Image Booster

Activates only when a tab **is** an image — i.e. you navigated directly to an image URL (or opened one via right-click → "Open image in new tab") and Chrome rendered its built-in single-image viewer. It swaps that image for a `<video>` element backed by a live `canvas.captureStream()` of it. Since it's a real `<video>`, RTX Video HDR (which only watches for video elements) picks it up and tone-maps it.

It does **not** activate on regular web pages that merely embed `<img>` tags among other content — only on the direct single-image view.

## Install (unpacked, since it's not on the Chrome Web Store)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. If you already had v1 loaded, click the refresh icon on the extension card to pick up the update
4. Otherwise: **Load unpacked** → select this folder (`rtx-hdr-extension`)
5. Pin it from the puzzle-piece menu if you want the badge count visible

Chrome will show a "Read and change all your data on all websites you visit" permission warning — that's expected, since it now needs to run on every site rather than only on click.

## Use

Open an image directly in a tab (paste its URL, or right-click any image on a page → "Open image in new tab"). It converts on its own; the badge shows the conversion count. Click the toolbar icon to open a popup showing the detected image — thumbnail, dimensions, and status (`HDR` converted / `blocked` / `pending`, hover a `blocked` badge for the reason). Click the row to open the original URL in a new tab. The popup's **Rescan** button forces a fresh pass.

On a regular page (not a direct image view), the popup will say so — that's expected, the extension is intentionally inert there.

## Open question: does RTX Video HDR actually engage on these?

Worth being upfront about: RTX Video HDR most likely hooks into the GPU's real video-decode/overlay surface — the special swapchain Chrome hands actual codec video (H.264/VP9/AV1) to the hardware decoder for. A `canvas.captureStream()`-backed `<video>`, even though it's a genuine, playing `<video>` element, gets composited through the ordinary canvas/texture path rather than that decode surface. It may satisfy the DOM definition of "a video" without ever touching the driver-level surface NVIDIA's filter watches for. If that's the case, this technique can convert images into "video" all day without RTX HDR ever engaging — it isn't a bug fixable with more JS. Not confirmed either way; the popup at least lets you verify the mundane stuff (detection, conversion, blocked reasons) so if HDR still doesn't kick in with everything converting cleanly, this architecture mismatch is the leading suspect.

## How it handles CORS-locked images

Most CDNs don't send `Access-Control-Allow-Origin`, which normally makes a canvas "tainted" the moment you draw a cross-origin image into it — page JS just isn't allowed to read those pixels. The extension routes around this: when the fast in-page path fails, the content script asks the background service worker to fetch the image instead. Because the worker holds `host_permissions: ["<all_urls>"]`, that fetch isn't subject to CORS the way a normal page request is — the worker converts the response to a `data:` URL and hands it back, and a `data:` URL never taints a canvas. This covers the vast majority of sites now.

What still won't convert:
- Images behind hotlink/referer-check protection that reject requests without the original page's `Referer` header (the background fetch doesn't send one)
- Images gated behind auth cookies scoped to the site (the background fetch intentionally omits credentials, for privacy)
- Sites that block the image request outright at the network level

## Notes / limits

- Only activates on `document.contentType` starting with `image/` — Chrome's marker for "this tab is literally an image file," not an HTML page that happens to contain images.
- Won't double-convert the same image.
- `ERR_BLOCKED_BY_CLIENT` errors in the console are your ad blocker blocking ad-network scripts — unrelated to this extension.
