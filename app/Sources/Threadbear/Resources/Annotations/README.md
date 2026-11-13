# Browser annotations

`annotation.js` is a standalone function expression. The Mac client calls it
with an opaque session ID in an isolated JavaScript world in the selected
browser tab. It opens Select, Region, Draw and Erase tools and a comment box.
Attach prepares a snapshot; it never sends a message to an agent itself.

The implementation adapts T3 Code, copyright 2026 T3 Tools Inc., under the
included MIT licence. Upstream revision:
`59e64eef881632a23f89c4138bcf37f23d92bf93`.

Sources:

- https://github.com/pingdotgg/t3code/blob/59e64eef881632a23f89c4138bcf37f23d92bf93/apps/desktop/src/preview/PickPreload.ts
- https://github.com/pingdotgg/t3code/blob/59e64eef881632a23f89c4138bcf37f23d92bf93/apps/desktop/src/preview/AnnotationStroke.ts

Reused algorithms include normalized region geometry, clipping selected
element outlines to scrolling ancestors, marquee selection of leaf and
interactive elements, and quadratic freehand curves split after 100
segments. Threadbear supplies the controls' styles, session transport,
bounded DOM context, document-anchored marks and modal/popover handling.
Electron IPC, React component inspection, recording, voice and live CSS
editing are not included.

## Client contract

Evaluate `(<file contents>)(sessionID)`. The result is
`{sessionId, status: "active"}`. The isolated world's
`window.__threadbearAnnotation` has `sessionId`, `read()` and `finish()`.

`read()` returns a fresh JSON copy of `{sessionId, status, annotation?}`.
Status is `active`, `ready` after Attach, or `cancelled` after Escape/Cancel.
When ready, the toolbar and comment editor are hidden and visual marks stay
on the page for the client's screenshot. `finish()` removes the overlay,
listeners and cursor override, restoring the previous focus. Starting a new
session cleans up the previous one.

The annotation contains `url`, `title`, `comment`, `elements`, `regions`,
`strokes` and `viewport`. An element contains `selector`, `tagName`,
`outerHTML`, `text`, `styles` and `rect`. Rectangles and stroke points use
viewport CSS pixels at submission; `viewport` records width, height,
scrollX and scrollY. Regions and strokes stay anchored to document
coordinates while the page scrolls. Each list is limited to 20; strokes
together contain at most 2,048 points. HTML and text are bounded and form
value attributes, textarea contents and executable inline code are omitted
from the cloned DOM context. The original page is not edited.

Selection descends into open shadow roots. Closed shadow roots and embedded
cross-origin frames remain their outer element; Region/Draw can identify a
visual issue there. A manual popover in the active modal keeps the toolbar
and editor usable over native dialogs.

Browser regression checks: `node app/Tools/browser-annotation-test.mjs`.
They launch a separate headless Chrome profile and remove it on completion.
