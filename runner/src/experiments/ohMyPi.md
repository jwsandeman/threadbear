---
id: ohMyPi
name: Oh My Pi
title: Run threads through Oh My Pi with model selection, approval cards and saved sessions
added: 2026-11-08
on: false
reminder: def93241
---

## What it does

Adds Oh My Pi alongside Claude Code and Codex in the account and model picker.
Threadbear uses your installed `omp` and its own sign-ins. Messages, thinking,
tool activity and approvals appear in the normal Threadbear conversation;
this does not embed OMP's terminal interface. Stopping, hibernating and
reopening a thread keeps its saved OMP session.

Install Oh My Pi and sign in with `omp login` first. Enable
`"experiments": { "ohMyPi": true }` in runner.json. `ompPath` selects the
executable when it isn't on the runner's path; `ompMainDir` selects its
agent directory (default `~/.omp/agent`). Model choices come from OMP and
include the underlying provider. Threadbear never reads or copies its tokens.

Full access lets OMP run its tools; Ask before edits and Auto use approval
cards. Plan first is unavailable for OMP. Oh My Pi updates remain managed
outside Threadbear. Existing Claude Code and Codex sign-ins are separate.
Historical usage charts and automatic retry when the network returns are
not supported yet; send another message to retry a connection failure.
Discovered OMP extensions and project MCP configuration are disabled so
they cannot bypass Threadbear's approval checks; LSP servers start only
when their tools are used. In Ask and Auto, delegated tasks are blocked; the parent
can do the work through its approval cards. Editing an earlier message
and opening a subagent's transcript are not supported in this first version.

## Lives in

`runner/src/adapters/omp/`; provider, account, config, pool and startup wiring
in `runner/src/`; provider names and picker support in the Mac and phone
clients. The contract is in `docs/protocol.md`, "Oh My Pi harness".

## Taking it out

Turn off `ohMyPi` to stop offering OMP accounts. To remove it, delete the
adapter and its startup wiring, config and discovery fields, and provider
picker entries. Keep decoding existing `omp` thread records and leave
their saved sessions on disk.
