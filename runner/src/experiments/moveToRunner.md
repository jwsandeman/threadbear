---
id: moveToRunner
name: Move to another machine
title: Move to another machine: a thread moves to another runner whole, and carries on there
added: 2026-11-08
on: false
reminder: be94a128
---

## What it does

A thread moves to another of your machines whole: the same thread, with its whole conversation, its pictures and Highlights, and the git work in its own worktree (commits and uncommitted changes alike). It waits for the turn it's on to end, and messages sent meanwhile go with it. Its next message carries on in the same Claude session on the other machine. If anything goes wrong before it lands, it stays where it was and says why.

Right-click a thread (or use its **...** menu) and pick **Move to**, then the machine. Offline ones are greyed. A small window shows the folder and login it will use there, filled in with that machine's own guess, and what won't come (files git ignores, changes in a checkout other threads share). Change either and it checks again; press **Move**. The row says "Moving to" with a spinner until it's gone, then the thread is listed under the other machine, in the same place and still open. If it can't move, the row says so for a minute, with why in its tooltip. Agents can do the same with `move_thread` and a `runner`, and `tb move <thread> --to <machine>` (`--preview` to see where it would go). Moves are started from your first Mac. It needs Threadbear's backend, and the experiment on in both machines' runners; the app shows the menu from the next time it connects after the switch is turned on.

## Lives in

`runner/src/moves.ts` (the steps on each runner), `move-pack.ts` and `move-git.ts` (the bundle and the git work), `sealBytes` in `secrets.ts`; `convex/moves.ts` and the `threadMoves` table in the backend; the Move to menu (`ThreadMoveMenu` in `SidebarView.swift`), `MoveSheet.swift` and `AppModel+Moves.swift` in the Mac app; `move` in `RemoteControl` (`threadbear-mcp.ts`) and `moveToRunner` in `cli.ts`.

## Taking it out

Delete `runner/src/moves.ts`, `move-pack.ts` and `move-git.ts` and their lines in `main.ts` and `sync.ts`, the Move to menu, `MoveSheet.swift` and `AppModel+Moves.swift` in the app, and the `runner` argument of `move_thread`. The backend's `convex/moves.ts` can stay: nothing starts a move without the runner.
