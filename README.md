# RTX HDR Image Booster

Two modes, depending on the tab — plus a popup toggle to collapse them into one:

- **Regular page** (embeds `<img>` tags among other content): images are only *detected* and listed in the popup — nothing is converted by default. Click a row to open that image directly in a new tab.
- **Direct image tab** (you navigated straight to an image URL, or opened one via right-click → "Open image in new tab" — Chrome renders its built-in single-image viewer, `document.contentType` starts with `image/`): the image gets swapped for a `<video>` element backed by a live `canvas.captureStream()` of it. Since it's a real `<video>`, RTX Video HDR (which only watches for video elements) picks it up and tone-maps it.
- **"Auto-convert on every page" toggle** in the popup: **on by default** — converts on sight everywhere, same as direct image tabs. Flip it off if you want the click-to-open-then-convert flow instead. Persisted via `chrome.storage.local` and applies live to already-open tabs without a reload.

## Install (unpacked, since it's not on the Chrome Web Store)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. If you already had v1 loaded, click the refresh icon on the extension card to pick up the update
4. Otherwise: **Load unpacked** → select this folder (`rtx-hdr-extension`)
5. Pin it from the puzzle-piece menu if you want the badge count visible

Chrome will show a "Read and change all your data on all websites you visit" permission warning — that's expected, since it now needs to run on every site rather than only on click.

## Local pictures & folders

The popup's **Open…** button opens a dedicated tab (`viewer.html`) for converting files straight from your PC:

- **Open Picture** — pick a single image file; it's HDR-converted immediately, full-size, and automatically requests real browser fullscreen (relevant if you're chasing RTX Video Super Resolution, which reportedly only engages in fullscreen).
- **Open Folder** — pick a folder; every image inside is listed as a thumbnail grid. Click a thumbnail to open and fullscreen it individually, or **Convert All** to HDR-convert every thumbnail in place, small, for browsing the grid itself.

If the browser blocks the automatic fullscreen request (it requires a fresh user gesture, and decoding the image takes a tick that can occasionally eat that gesture), double-click the video to fullscreen it manually — there's an on-page hint for this.

Local files never need the CORS-bypass path — a `blob:` URL from a file you picked yourself never taints a canvas — so conversion here always succeeds.

**Using this in Incognito:** Chrome disables extensions in Incognito windows by default. Go to `chrome://extensions` → this extension's **Details** → toggle **Allow in Incognito** on. Without that, clicking the popup's buttons from an Incognito window still runs the extension in your regular profile, so new tabs it opens land outside the Incognito window.

## Use

Click the toolbar icon any time to open the popup — it lists every sufficiently large image, video, *and stream* detected on the current tab: thumbnail, dimensions, an `IMG`/`VID`/`STREAM` kind tag, and (for images) a status badge — `found` on a regular page / `HDR` converted / `blocked` / `pending` on a direct image tab (hover a `blocked` badge for the reason). Videos and streams only get the kind tag — they're already real video, so there's nothing to convert, they're just listed so you can see/open them. Click any row to open that item directly in a new tab, except dimmed stream rows with no stable URL (see below). The popup's **Rescan** button forces a fresh detection pass.

### What counts as a "stream"

Plenty of sites (Instagram, Twitter/X, TikTok, YouTube, most livestream players) don't give their `<video>` element a normal file URL — they feed it through [MSE](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API), so `video.currentSrc` is just a `blob:` URL that's scoped to that page and useless to open in a new tab. Two things happen instead:

- **Live/WebRTC video** (`video.srcObject` set directly — camera/call feeds): detected, but shown dimmed and unclickable, since there's genuinely no URL for it anywhere.
- **MSE-backed players**: the `<video>` element's own `blob:` src is ignored, and instead a `PerformanceObserver` watches the page's real network requests for video-shaped URLs (`.mp4`/`.m3u8`/`.mpd`/`.webm`/`.ts`, or byte-range query params like Instagram's `bytestart=`/`byteend=`) and lists the **actual CDN URL** — openable, since it's a real request the browser already made. These URLs are often signed with an expiry (e.g. Instagram's `oe=` param), so a captured one can go stale after a while.

This is heuristic (pattern-matching request URLs, since the Performance API doesn't expose content-type), so it can occasionally miss an unusual CDN or pick up an unrelated resource that happens to match the pattern.

## GIFs

Animated GIFs get converted too, and actually keep playing — not just a single frame frozen and passed through HDR. A plain `canvas.captureStream()` only ever samples the canvas once, so without extra work a converted GIF would look "HDR'd" but static. Instead, the source image is kept alive (hidden, not removed) in the page and redrawn into the canvas every frame for as long as the converted video is on the page, so the capture stream actually shows the animation.

## Fullscreen hotkey for any video (Alt+Shift+F)

Press **Alt+Shift+F** to `requestFullscreen()` a video directly, in place. No popup, no new tab, nothing else on the page touched. (Not plain Alt+F — that's Chrome's own shortcut for its 3-dot menu, and the browser eats it before a page ever sees the keydown.)

It uses whichever video you're hovering if that resolves cleanly, but falls back to "whichever playing video is most visible in the viewport" when it doesn't — plenty of sites (Instagram very much included) layer their own UI controls (likes, captions, mute button) directly on top of the `<video>` at a higher z-index, so the mouse ends up hovering that overlay, not the video underneath, and hover-tracking alone would silently do nothing.

**After updating this extension, remember to also refresh any tab that was already open** — reloading the extension at `chrome://extensions` does not retroactively re-inject the content script into tabs that loaded before the reload.

This exists because RTX Video HDR and RTX Video Super Resolution are driver/GPU-level features with **no web API** — there's no JS or DOM hook an extension (or the page itself) can call to turn them on for a specific video. Whether they engage is entirely up to NVIDIA's own heuristics, but there are real reports that on-screen video size matters, with fullscreen being the reliable case. Alt+F just makes that cheap to test; it doesn't guarantee anything actually engages. Other known requirements worth checking independently of this extension: Windows must be in HDR mode, hardware-accelerated video decode must be on in Chrome (`chrome://settings/system`), and the effect must be enabled for Chrome in the NVIDIA app.

## Open question: does RTX Video HDR actually engage on these?

Worth being upfront about: RTX Video HDR most likely hooks into the GPU's real video-decode/overlay surface — the special swapchain Chrome hands actual codec video (H.264/VP9/AV1) to the hardware decoder for. A `canvas.captureStream()`-backed `<video>`, even though it's a genuine, playing `<video>` element, gets composited through the ordinary canvas/texture path rather than that decode surface. It may satisfy the DOM definition of "a video" without ever touching the driver-level surface NVIDIA's filter watches for. If that's the case, this technique can convert images into "video" all day without RTX HDR ever engaging — it isn't a bug fixable with more JS. Not confirmed either way; the popup at least lets you verify the mundane stuff (detection, conversion, blocked reasons) so if HDR still doesn't kick in with everything converting cleanly, this architecture mismatch is the leading suspect.

## How it handles CORS-locked images

Most CDNs don't send `Access-Control-Allow-Origin`, which normally makes a canvas "tainted" the moment you draw a cross-origin image into it — page JS just isn't allowed to read those pixels. The extension routes around this: when the fast in-page path fails, the content script asks the background service worker to fetch the image instead. Because the worker holds `host_permissions: ["<all_urls>"]`, that fetch isn't subject to CORS the way a normal page request is — the worker converts the response to a `data:` URL and hands it back, and a `data:` URL never taints a canvas. This covers the vast majority of sites now.

What still won't convert:
- Images behind hotlink/referer-check protection that reject requests without the original page's `Referer` header (the background fetch doesn't send one)
- Images gated behind auth cookies scoped to the site (the background fetch intentionally omits credentials, for privacy)
- Sites that block the image request outright at the network level

## Notes / limits

- Conversion only ever runs on `document.contentType` starting with `image/` — Chrome's marker for "this tab is literally an image file," not an HTML page that happens to contain images. Detection/listing runs everywhere.
- Won't double-convert the same image.
- `ERR_BLOCKED_BY_CLIENT` errors in the console are your ad blocker blocking ad-network scripts — unrelated to this extension.
