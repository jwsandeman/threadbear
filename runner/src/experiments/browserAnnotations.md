---
id: browserAnnotations
name: Annotate browser pages
title: Annotate browser pages: select elements or draw a change and attach it to a thread
added: 2026-11-13
on: false
reminder: f3364485
---

## What it does

The Mac app's Browser panel adds Annotate to pages in the agents' own browser. Select an element, mark a region, draw or erase, and add a comment. Attach puts the captured page context and a screenshot in the thread's message box without sending it. Existing draft text and pictures stay in place, even if you switch to another thread while annotating. Press Send in the original thread when ready.

This first version works with local threads and the agents' own browser, not tabs in your personal Chrome profiles or threads running on another machine. BrowserBear must be running. The page's top-level document is selectable; an embedded page from another origin can be marked as a region. It does not install a browser or change your profiles.

## Lives in

`app/Sources/Threadbear/BrowserAnnotations.swift`, `Views/AgentBrowserPanel.swift` and the bundled `Resources/Annotations` JavaScript adapted from T3 Code, with its MIT licence and source revision. The switch is read from the runner's existing `hello.experiments` field.

## Taking it out

Remove the Annotate action, `BrowserAnnotations.swift`, the Annotations resource bundle entry and files, its tests, and this experiment. No stored thread format or backend changes need undoing. The check-in is paused until this patch is approved and shipped; resume it for four days after rollout.
