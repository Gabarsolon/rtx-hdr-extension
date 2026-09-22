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

Animated GIFs get converted too, and actually keep playing — not just a single frame frozen and passed through HDR. A plain `canvas.captureStream()` only ever samples the canvas once, so without extra work a converted GIF would look "HDR'd" but static.

The fix decodes the GIF's actual frames itself, using the browser's [`ImageDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder) API (WebCodecs), and paints each one on a timer matched to its real duration — it doesn't rely on Chrome's own built-in GIF player continuing to run once the source `<img>` is out of sight, which turned out not to be a safe assumption (an earlier version tried keeping the `<img>` alive-but-hidden and redrawing it, and that alone wasn't reliable). If `ImageDecoder` isn't available for some reason, it falls back to that hidden-`<img>`-redraw approach as a second try.

**Playing ≠ HDR, it turns out.** Once the animation itself worked, RTX Video HDR stopped engaging on the converted GIF — even though a frozen single-frame conversion (the pre-fix, non-animated behavior) reportedly did get HDR applied. So it's not simply "canvas-stream video never gets RTX HDR"; something about content actually changing frame-to-frame specifically breaks it.

One theory (RTX needs a settle window after playback starts before it'll engage, and a GIF changing content from frame 1 interrupts that) was tested with a deliberate 1.5s hold-on-first-frame delay before animation starts — it didn't help, HDR still never engaged once motion started, so that delay was removed again. At this point this looks like the same kind of driver-level black box as the [Instagram case above](#open-question-does-rtx-video-hdr-actually-engage-on-these): there's no API surface, log, or signal available to a browser extension for what RTX Video HDR's engagement heuristic is actually keying off, so further fixes here would just be more blind guessing. GIFs do now convert and actually play (the original ask), just apparently without HDR — same open question as everything else in this doc about whether `canvas.captureStream()` video was ever going through the real hardware decode surface RTX watches, versus the ordinary compositor path.

## Converting back to a plain image

Every converted image can be switched back — nothing is one-way:

- **In the popup**: converted rows get a **↺ Revert** button; rows that are just detected (not converted) get a **▶ Convert** button to convert that one image on demand, regardless of the auto-convert toggle. A **Revert All** button in the header reverts every converted image on the current page at once.
- **In the local viewer**: the single-picture view has a **Show Original Image** / **Convert to HDR Video** toggle button.

Reverting doesn't just discard the conversion — the original `<img>` is put right back where the video was, and stays that way even if "Auto-convert on every page" is on (a manual revert is remembered per-image until you explicitly convert it again; it won't silently get re-converted on the next scan).

## Downloading an actual HDR file

The live canvas-stream video this extension creates only exists on screen — its pixels are never touched by RTX Video HDR (see the "Open question" section below for why), so there's nothing meaningful to "save" straight off it. What you *can* save is a real, standalone HDR still image: a **gain-map JPEG** (also called Ultra HDR — the format Google/Adobe defined, and the one Chrome, Android, and Windows Photos actually recognize and render as HDR). It's a normal baseline JPEG — opens fine anywhere — with a second, embedded grayscale JPEG describing how much brighter to push each pixel on an HDR display, plus XMP metadata describing that mapping.

This is **not** a recovery of real HDR data — an 8-bit SDR photo never had any extra dynamic range captured in the first place, and there's no way to get RTX Video HDR's own runtime output out of the browser at all. What it does instead is synthesize a plausible boost (bright highlights pushed brighter, midtones/shadows left alone) and package it as a file real HDR viewers will render as HDR — the same basic idea as any "AI HDR enhance" filter, just as a downloadable file instead of a one-off effect.

- **Local pictures** (`viewer.html`): open a picture, and a **Download HDR (.jpg)** button appears once it's converted.
- **Images on a page**: in the popup, any row that's shown as converted (`HDR` badge) gets a small **HDR ⇩** button next to it.

The gain-map/container format is an intricate spec (`hdr-export.js` builds the XMP `Container`/`hdrgm` metadata and an MPF binary index by hand, then stitches the two embedded JPEGs together) and this implementation couldn't be tested against a real HDR-capable viewer from here.

**v4.9 → v4.10:** the first version only embedded XMP metadata *describing* a gain map; it opened fine everywhere but never actually rendered as HDR (confirmed via Windows Photos on an HDR display — the correct way to test this). The likely gap: real Ultra HDR files (Pixel/Google's own encoder included) also carry a binary **MPF (Multi-Picture Format) APP2 segment** — a proper TIFF-style byte offset/length index — and viewers apparently rely on that to actually locate the embedded gain map, not just the XMP description of it. v4.10 adds that index. Some of its bit-level details (specifically which bit marks the "representative image" in the MPF attribute field) couldn't be pinned down with full confidence from memory and may not matter for gain-map discovery specifically — if this version still doesn't render as HDR, that's the next thing worth reporting back on.

## Fullscreen hotkey for any video (Alt+Shift+F)

Press **Alt+Shift+F** to `requestFullscreen()` a video directly, in place. No popup, no new tab, nothing else on the page touched. (Not plain Alt+F — that's Chrome's own shortcut for its 3-dot menu, and the browser eats it before a page ever sees the keydown.)

It uses whichever video you're hovering if that resolves cleanly, but falls back to "whichever playing video is most visible in the viewport" when it doesn't — plenty of sites (Instagram very much included) layer their own UI controls (likes, captions, mute button) directly on top of the `<video>` at a higher z-index, so the mouse ends up hovering that overlay, not the video underneath, and hover-tracking alone would silently do nothing.

**After updating this extension, remember to also refresh any tab that was already open** — reloading the extension at `chrome://extensions` does not retroactively re-inject the content script into tabs that loaded before the reload.

If it doesn't fire at all on some site (no console warning, nothing): the listener is registered on `window` in the capture phase specifically so it runs before any page-level handler could see or swallow the keydown first — sites with their own custom player (Mega.nz among them) often have a global shortcut handler for space/arrows/"f" that can eat a broad range of keydowns, sometimes checking only the key and not the modifiers.

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
