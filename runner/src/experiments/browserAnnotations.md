---
id: browserAnnotations
name: Annotate browser pages
title: Annotate browser pages: select elements or draw a change and attach it to a thread
added: 2026-11-13
on: false
reminder: f3364485
---

## What it does

Pages shown inside the Mac app have an Annotate button: web previews, local HTML previews and web panels. Select an element, mark a region, draw or erase, and add a comment. Attach puts the captured page context and a screenshot in the original thread's message box without sending it. Existing draft text and pictures stay in place. Press Send when ready.

This works with local threads, inside Threadbear, without BrowserBear or Chrome. The Browser panel's Open a page here address field loads a page inside the app, even when BrowserBear is stopped. A listed agent page offers Open here to annotate; Show window remains the explicit way to open its external browser window. Navigating away, closing the page or switching threads cancels an unfinished annotation. Captured results stay bound to the original thread. The page's script permissions and network restrictions stay in place; annotation does not enable its scripts. An embedded page from another origin can be marked as a region.

## Lives in

`app/Sources/Threadbear/EmbeddedBrowserAnnotations.swift`, `Views/AnnotatedWebPanel.swift`, the shared payload/draft helpers in `BrowserAnnotations.swift`, `Views/AgentBrowserPanel.swift` and the bundled `Resources/Annotations` JavaScript adapted from T3 Code, with its MIT licence and source revision. The tools run in an isolated `WKContentWorld` and screenshots use `WKWebView.takeSnapshot`. The switch is read from the runner's existing `hello.experiments` field.

## Taking it out

Remove the Annotate actions and `AnnotatedWebPanel` wrapper, the annotation controller, the Annotations resource bundle entry and files, its tests, and this experiment. Restore the plain web views at the wrapper's call sites. No stored thread format or backend changes need undoing.
