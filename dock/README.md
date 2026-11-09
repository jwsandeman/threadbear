# BearDock

Dockable, rearrangeable panels for Threadbear, in a package of their own with
a demo app, so dragging and docking can feel right before it goes into the
real window.

`./run.sh` opens the demo. `swift test` runs the layout tests (and
`check.sh --app` runs them too).

The app's window is a dock since 28 Oct 2026: `WindowDock.swift` in the app
says which panels there are (the sidebar, the thread, Highlights, each
project panel, Patches), the default layout, and how the rail and Show or
Hide Panels open and close them. The window has no title bar, so the
panels' bars are the top of it: the traffic lights sit in the top-left
panel's bar, and a plain drag on the empty part of any bar, or on a custom
header like the thread's, moves the window, and a double-click zooms it, as
a title bar would. A panel's title, or a tab, picks the panel up as soon
as you drag it. Anywhere else (the empty part of its bar, a custom header,
its background, the grab strip of a hidden title) takes a press held for a
moment first (`HoldDrag.hold`, 350 ms). On a bar the panel lifts while
you hold; elsewhere it lifts as you start to move. A drag that starts
moving sooner moves the window from a bar, and does nothing on a panel's
background (Mike, 28 Oct: panels kept coming loose when he meant
something else).

## How it works

- **The layout is a tree** (`DockLayout`): splits, horizontal or vertical,
  down to groups of panels shown as tabs. Any depth. After every change it's
  tidied: no empty groups, no one-child splits, and a split directly inside
  another along the same axis is flattened into it. It's `Codable`, so the
  demo saves it between launches.
- **Dragging** a panel's title or a tab, or its bar or background after
  holding the press for a moment, lifts it: the panel shrinks to about 240 points wide under the pointer, with the
  spot you grabbed kept under it, and leaves a dashed hole behind. A tab
  that isn't showing can be pulled out directly. Escape puts it back.
- **A panel's own drags win.** The dock's drag is the lowest priority
  gesture on the panel, so content that handles a drag itself (reordering
  rows, a slider, a web view) keeps it, and only a held press on the
  background moves the panel. The demo's Worktrees rows reorder to show it. For a region with no
  drag of its own that still shouldn't move the panel, use
  `.dockDragDisabled()`.
- **Over another panel's bar**, a tab with the dragged panel's name shows
  in it, after its titles: dropping there adds the panel as a tab. Along
  the top row the window's own top edge keeps only its outer 6 points.
- **Over another panel**, the side you're nearest (within 28% of it) lights
  up: dropping there splits that panel's space in half.
- **In the middle** of a panel a compass appears: dock above, below, left
  or right of it, add as a tab, or swap places. Its caption says which.
- **Along the window's own edge** (the outer 22 points) the panel docks
  across the whole side.
- On drop the ghost flies into its new spot; dropped anywhere else it flies home.
- **Windows of their own.** Drag a panel out past the edge of the window, or
  onto the compass's Window button, and an outline shows the window it would
  open as; let go and it's there. Right-click a panel for Open in New Window
  too. The window has the panel's own bar: drag it back over the main
  window and the drop targets show as for any other panel (the window goes
  see-through so you can see them). Its menu's Put Back in Main Window
  docks it where it came from, at the size it was. Its red button closes the
  panel, or puts back one the app always keeps. The layout keeps them in
  `floating`, with each window's frame, so they open again next launch.
  `DockOptions.windowContent` gives a window what the app's main window gives
  its views (Threadbear's model in the environment).
- **Titles can be hidden** per panel: right-click a title or tab, Hide
  Title. The panel then has no bar while it's on its own (the demo's Threads
  starts that way); a thin strip along its top shows a grab handle on hover,
  to drag it by. Right-click there, or anywhere on the panel's empty
  background, for Show Title (content with a menu of its own keeps it). With tabs the bar always
  shows, as it's how you switch between them. It follows the panel when it
  moves and is saved with the layout.
- Dividers between panels drag to resize; × on a tab closes it, and the
  toolbar's menu opens it again.

The feel lives in a few constants at the top of `DockController`
(`edgeBand`, `windowBand`, `ghostWidth`, the springs).

`DockOptions.panelBackground` sets the base fill. Set `headerBackground`
to give title and tab bars a different fill; nil follows the panel fill.
It applies to docked bars, floating panels and the dragged panel's header.

For screenshots without touching the mouse, `BEARDOCK_FREEZE` holds a drag
of Highlights mid-air: `edge`, `compass`, `compass-left`, `window`, or any of
those with `+drop` to let go.

To test the real gestures, `BEARDOCK_EVENTS` sends real mouse and key events
through the app, in a test window that takes the first click so the app
needn't be active (see `ScriptedEvents.swift`). Add `BEARDOCK_FRESH=1` to
start from the default layout without saving, `BEARDOCK_QUIT=1` to quit at
the end, and `BEARDOCK_LOG=1` to print what each drag picked up:

`others <prefix>` captures each of the app's other windows (a panel's own,
or the outline while a drag would make one).

```sh
BEARDOCK_FRESH=1 BEARDOCK_QUIT=1 BEARDOCK_LOG=1 \
  BEARDOCK_EVENTS="down 1037 515;drag 641 471;esc;up;shot /tmp/after-escape.png" \
  .build/debug/DockDemo
```
