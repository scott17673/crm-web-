# Paste images into manufacturer/vendor NOTES

**Date:** 2026-06-04
**Author:** Scott + Claude (brainstorming)
**Status:** Design — pending implementation plan

## Goal

Let the user paste a screenshot (Win+Shift+S → Ctrl+V) directly into the NOTES box on the manufacturer/vendor detail panel and have it persist, display inline, and survive page reloads. Zero infrastructure setup: no Supabase Storage bucket, no schema change.

## Scope

In scope:
- The `EditableLinkField` NOTES box for `selected.type === "manufacturer"` and `selected.type === "vendor"` ([index.html:4021](index.html:4021)).
- Paste-from-clipboard as the only input method.
- Base64 data URLs inline in the existing notes HTML (stored in `manufacturers.signals` and `vendors.notes` columns — both already text).
- Auto-downscale on paste to keep row size bounded.
- Click an image to open the full-size version in a new browser tab.

Out of scope:
- Drag-and-drop, file upload button.
- Image resize handles inside the editor.
- Activity-log notes (`activities.note`), Lead Finder notes (`leadFinderSelected.notes`), contact/lost record notes.
- Supabase Storage bucket / file uploads — explicitly rejected in favor of inline base64.
- A lightbox modal viewer — using a new tab instead.

## Constraints and known limits

- **Per-image cap: 1.5MB raw bytes.** Anything above is downscaled via offscreen `<canvas>` to fit ≤1600px on the long side at JPEG quality 0.85. If still over the cap, paste aborts with a small inline alert ("Image too large to paste — please attach a smaller copy"). Prevents one user mistake from blowing up a row.
- **Per-record practical limit: a few inline images.** Supabase row size accommodates several MB of text, but the app pulls every manufacturer + vendor row on startup ([index.html:2059–2063](index.html:2059) via `fetchAllSupabaseRows`). With ~50 records × 1MB images = ~50MB cold-load. If image-per-record usage grows past a handful, plan migration to Supabase Storage. **Documented limit, not blocked.**
- **No new dependencies.** Vanilla `FileReader`, `<canvas>`, `clipboardData.items`.

## Architecture

The notes box is a single React component, `EditableLinkField` ([index.html:1477](index.html:1477)), used in two render modes via a `richText` prop:
- `richText={true}` (manufacturer today): paste/serialize/render runs through `richNotesFromHtml` / `richNotesFromElement` / `renderRichNotesHtml`.
- `richText={false}` (vendor today): paste is plain text, serialize via `editableTextFromElement`.

To share one image-paste path, **flip vendor to `richText={true}`** at the two call sites ([index.html:4023](index.html:4023) and [index.html:4028, 4030, 4042, 4044](index.html:4028)). Side effect: vendor notes also gain bold-text support. Existing plain-text vendor notes render correctly through `renderRichNotesHtml` (it accepts any string and walks the parsed DOM gracefully).

After the flip, all image-paste logic lives in five spots inside `index.html`:

1. **`cleanupRichNotesHtml`** ([index.html:1367](index.html:1367)) — no change.
2. **`richNotesPlainText`** ([index.html:1378](index.html:1378)) — replace `<img>` with `[image]`. Prevents base64 in CSV exports, table-row "Notes" preview, and search text.
3. **`serializeRichNotesNode`** ([index.html:1392](index.html:1392)) — allow `<img>` when `src` starts with `data:image/` AND the `data-note-image` attribute is present. Emit `<img src="..." data-note-image>` with no other attributes.
4. **`renderRichNotesHtml`** ([index.html:1416](index.html:1416)) — when walking an `<img data-note-image>`, emit a styled `<img>` with inline `max-width:100%; max-height:280px; display:block; margin:6px 0; border-radius:4px; border:1px solid #d7dfeb; cursor:zoom-in` and a `data-note-image-src` attribute mirroring `src` (parallel to `data-external-url` on links).
5. **`clickedExternalUrl`** ([index.html:1458](index.html:1458)) — extend to also return the value of `data-note-image-src` when an image is clicked. Existing `onPointerDown`/`onClick` handlers in `EditableLinkField` ([index.html:1557–1568](index.html:1557)) already open the returned URL in a new tab. Rename or add a sibling helper if naming bugs you; either way, one click → one new tab.

## The paste handler

The current `onPaste` handler ([index.html:1530–1546](index.html:1530)) handles text/html and text/plain. Replace with a richText-aware branch:

```
onPaste = event:
  if richText:
    images = clipboardData.items where kind === "file" AND type startsWith "image/"
    if images is non-empty:
      event.preventDefault()
      handle images (async — see below)
      return
  // existing text/html and text/plain path unchanged
```

**Constants:**
- `RAW_CAP = 1.5 * 1024 * 1024` (1.5MB raw bytes — the hard limit).
- `DATA_URL_CAP = Math.ceil(RAW_CAP * 4 / 3)` (≈2.1MB string length — base64 expansion of the cap).
- `MAX_DIM = 1600` (px on long side after downscale).
- `JPEG_QUALITY = 0.85`.

**Image handling, per image:**

1. `const file = item.getAsFile()`.
2. If `file.size <= RAW_CAP`: read with `FileReader.readAsDataURL(file)` and skip to step 5.
3. Otherwise: run the downscale step (below). If it returns `null` (still too big), `alert("Image too large to paste — please attach a smaller copy.")` and skip this image.
4. Use the downscale result as the data URL.
5. Build `<img src="${dataUrl}" data-note-image>` and pass through `insertHtmlAtSelection` ([index.html:1440](index.html:1440)) at the saved selection.
6. After insert, trigger the same `onChange` + `scheduleAutoSave` + `onMeasure` chain as the existing paste path (inside `requestAnimationFrame`).

**Downscale step (returns data URL or `null`):**

1. Decode the file into an `Image` via `URL.createObjectURL` + `img.onload`.
2. Compute scale so `max(naturalWidth, naturalHeight) <= MAX_DIM`.
3. Draw to an offscreen `<canvas>` at the scaled size.
4. `canvas.toDataURL("image/jpeg", JPEG_QUALITY)` → data URL.
5. Revoke the object URL.
6. If `dataUrl.length > DATA_URL_CAP`, return `null`. Otherwise return the data URL.

**Selection handling:** Because `FileReader` is async, the selection range can be lost by the time we insert. Capture `window.getSelection().getRangeAt(0).cloneRange()` synchronously at the start of `onPaste` and restore it before `insertHtmlAtSelection`. (Selection is also lost by `event.preventDefault()` on some browsers — capture before any work.)

## Data flow end-to-end

```
User pastes screenshot
  → onPaste detects image item
  → captures selection range
  → FileReader → data URL
  → (optional) canvas downscale
  → insert <img src="data:..." data-note-image> at saved range
  → onChange → richNotesFromElement → serializeRichNotesNode (allows img)
  → autosave to Supabase manufacturers.signals or vendors.notes
  → on blur or remount → renderRichNotesHtml emits styled <img data-note-image-src>
  → click → clickedExternalUrl returns data URL → window.open(...) new tab
```

## Effects on downstream consumers

All of these already go through `richNotesPlainText` and will get `[image]` instead of raw base64:
- Table-row "Notes" cell preview ([index.html:3507](index.html:3507)).
- CSV export columns ([index.html:1165, 1183, 1200](index.html:1165)).
- Search text concatenation ([index.html:2216, 2236, 2257, 2290](index.html:2216)).
- Lead-import note merging ([index.html:1078, 1129](index.html:1078)) — these consume row-level note text, not HTML, so unaffected.

The contact/lost detail panel renders `selected.notes` via `LinkifiedText` ([index.html:4054](index.html:4054)) — that branch is for non-manufacturer/non-vendor and doesn't apply here, but if a manufacturer is ever converted via `convertSelectedType`, an `<img>` tag in the raw value would render as raw text. Acceptable: conversion is rare and the user can clean it up. **Documented edge case, not blocked.**

## Testing plan (manual)

1. Open `index.html` in browser, open Supabase, select a manufacturer.
2. Win+Shift+S a small screenshot → click NOTES → Ctrl+V. Confirm image renders inline, scaled to ≤280px tall.
3. Reload the page, reopen the same manufacturer, confirm image still present.
4. Click the image (outside edit focus) — confirm it opens in a new tab at full resolution.
5. Paste a 5MB image (e.g. a large photo) — confirm it downscales, gets inserted, and the saved size is reasonable.
6. Paste an even larger image (mock by setting cap lower temporarily) — confirm the alert fires and nothing is inserted.
7. Check the manufacturer list table "Notes" column — confirm it shows `[image]` not base64.
8. Export CSV — confirm `[image]` in the notes column.
9. Repeat steps 2–4 for a vendor record (after the richText flip).
10. Existing rich-text behavior: paste plain text and styled HTML still works as before.

## Files touched

- `index.html` only.

## Implementation order

1. Extend `cleanupRichNotesHtml`/`serializeRichNotesNode`/`renderRichNotesHtml`/`richNotesPlainText`/`clickedExternalUrl` to know about `<img data-note-image>`.
2. Add image-paste branch to `EditableLinkField.onPaste`.
3. Add the downscale helper.
4. Flip vendor NOTES to `richText={true}`.
5. Manual test pass.
