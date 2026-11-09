// Moving a thread to another runner: this runner's side of each step
// (src/moves.ts decides when; docs/protocol.md, "Moving a thread to
// another runner"). Part of the Runner (runner.ts); each method's `this` is
// the Runner.
//
// The runner it leaves (S): describe, freeze, release the CLI and gather
// its files, transcript and git work, then put its copy away once the
// other runner has it. The runner it goes to (T): plan the folder and
// login, place everything in a staging folder (and its worktree and
// transcript where they belong), then after the switch move the staging
// folder in among the live threads and adopt it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { paths } from '../config.ts';
import { isDirectory } from '../fsutil.ts';
import { readTree, writeTree, type PackEntry } from '../move-pack.ts';
import { changedFiles, originUrl, packGit, repoKey, repoTop, unpackGit, type GitMeta } from '../move-git.ts';
import type { MoveInfo, MovePlan, MovePreview, MoveRow, ThreadMoving } from '../moves.ts';
import { projectDirName, sessionTranscriptPath } from '../transcripts.ts';
import { findWorktreePatch } from '../patches.ts';
import { cleanUpWorktree, makeWorktree, mainCheckoutOf, realpath, type WorktreeRecord } from '../worktrees.ts';

// What T placed for a move, so adopting after a restart and throwing it
// away after a failure both know (<home>/moves/<moveId>/placed.json).
type Placed = { cwd: string; worktree?: WorktreeRecord; patchFile?: string; patchName?: string; transcript: string[]; leftBehind: string[]; fromName: string; schedules?: unknown[] };

// A moved thread's old folder is kept this long on S, in case.
const KEPT_MS = 7 * 24 * 60 * 60_000;

function stageOf(home: string, moveId: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(moveId)) throw new Error('bad move id');
  return path.join(home, 'moves', moveId);
}

// A path on S under its home, as the same path under this machine's.
function swapHome(p: string, fromHome: string): string {
  const home = os.homedir();
  if (p === fromHome) return home;
  if (fromHome && p.startsWith(fromHome.endsWith('/') ? fromHome : `${fromHome}/`)) return path.join(home, p.slice(fromHome.length));
  return p;
}

function clone(url: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['clone', '--quiet', url, to], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, stderr) => (err ? reject(new Error(`Couldn't clone ${url} to ${to}: ${String(stderr).trim().split('\n').pop() || err.message}`)) : resolve()));
  });
}

export const movesPart = {
  // ThreadSummary.moving, and while it's set no turn starts: messages wait
  // in the queue, which moves with the thread. Cleared, the queue goes on.
  setMoving(this: Runner, threadId: string, moving: ThreadMoving | undefined): void {
    const st = this.threads.get(threadId);
    if (!st) return;
    const was = st.rt.moving;
    st.rt.moving = moving;
    if (JSON.stringify(was) !== JSON.stringify(moving)) this.markDirty(st);
    if (!moving && was) this.kickQueue(st);
  },

  // Nothing would be cut short by packing it now. Background shells are
  // stopped (and said); sub-agents finish first.
  moveIdle(this: Runner, threadId: string): boolean {
    const st = this.threads.get(threadId);
    if (!st) return false;
    const { rt } = st;
    if (rt.turn || rt.approvals.size || rt.wakeTimer || rt.hooksRunning || rt.runningActions?.size || rt.editing || rt.cleaning) return false;
    return !rt.tasks.some((t) => t.kind === 'agent') && !st.rec.subagents?.some((a) => a.status === 'running');
  },

  async describeForMove(this: Runner, threadId: string, schedules: number): Promise<MoveInfo | undefined> {
    const st = this.threads.get(threadId);
    if (!st) return undefined;
    const { rec } = st;
    const account = this.accounts.list().find((a) => a.id === rec.accountId);
    const own = Boolean(rec.worktree && !rec.worktree.removedAt);
    const top = await repoTop(rec.cwd);
    const origin = top ? await originUrl(top) : undefined;
    const rel = top ? path.relative(top, rec.cwd) : '';
    return {
      title: rec.title,
      cwd: rec.cwd,
      home: os.homedir(),
      provider: rec.provider,
      accountId: rec.accountId,
      ...(account?.email ? { email: account.email } : {}),
      ...(rec.model ? { model: rec.model } : {}),
      ...(rec.effort ? { effort: rec.effort } : {}),
      permissionMode: rec.permissionMode,
      ...(origin ? { origin } : {}),
      ...(top ? { repoTop: own ? rec.worktree!.mainCheckout : ((await mainCheckoutOf(top)) ?? top), subdir: rel.split(path.sep).join('/') } : {}),
      worktree: own,
      ...(rec.sessionUsed && rec.nativeSessionId ? { sessionId: rec.nativeSessionId } : {}),
      schedules,
    };
  },

  // Releases the CLI and gathers what goes: the thread's folder, its
  // Claude transcript, and its worktree's git work.
  async packForMove(this: Runner, threadId: string, row: MoveRow): Promise<{ entries: PackEntry[]; leftBehind: string[] }> {
    const st = this.threads.get(threadId);
    if (!st) throw new Error("The thread isn't here any more.");
    const { rec, rt } = st;
    const leftBehind: string[] = [];
    const shells = rt.tasks.filter((t) => t.kind !== 'agent').length;
    if (shells) leftBehind.push(`${shells} background ${shells === 1 ? 'job was' : 'jobs were'} stopped, as they can't move.`);
    this.flushDeltas(st);
    if (rt.session && !rt.closing) {
      this.rememberStoppedWork(st);
      this.releaseSession(st);
    }
    if (rt.closing) await rt.closing;
    this.store.save(rec);
    const entries = readTree(paths.thread(this.cfg.home, rec.id), 'thread', ['panels']);
    const account = this.accounts.list().find((a) => a.id === rec.accountId);
    if (rec.provider === 'claude' && rec.sessionUsed && rec.nativeSessionId && account) {
      const file = sessionTranscriptPath(account.configDir, rec.cwd, rec.nativeSessionId);
      if (file) {
        entries.push({ path: `transcript/${rec.nativeSessionId}.jsonl`, data: fs.readFileSync(file) });
        entries.push(...readTree(path.join(path.dirname(file), rec.nativeSessionId), `transcript/${rec.nativeSessionId}`));
      }
    }
    if (rec.worktree && !rec.worktree.removedAt) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-move-'));
      try {
        const git = await packGit(rec.worktree.path, rec.cwd, path.join(scratch, 'move.bundle'));
        if (!git.ok) throw new Error(git.reason);
        entries.push({ path: 'git/meta.json', data: Buffer.from(JSON.stringify(git.meta)) });
        if (git.bundle) entries.push({ path: 'git/move.bundle', data: fs.readFileSync(git.bundle) });
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } else {
      const top = await repoTop(rec.cwd);
      const files = top ? await changedFiles(top) : [];
      if (files.length) leftBehind.push(`Uncommitted changes in ${top} stayed on ${this.moveRunnerName(row.from)}, as other threads share that checkout: ${files.join(', ')}.`);
    }
    return { entries, leftBehind };
  },

  // After the move: the thread is the other runner's. Its folder goes to
  // <home>/moved/ for a week, and clients see it go (their list of other
  // runners' threads brings it back as that runner's).
  async putAwayMoved(this: Runner, threadId: string): Promise<void> {
    const st = this.threads.get(threadId);
    if (st) await this.letGo(st);
    const dir = paths.thread(this.cfg.home, threadId);
    const moved = path.join(this.cfg.home, 'moved');
    fs.mkdirSync(moved, { recursive: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, path.join(moved, `${threadId}-${Date.now()}`));
    for (const name of fs.readdirSync(moved)) {
      const at = Number(/-(\d+)$/.exec(name)?.[1]);
      if (at && at < Date.now() - KEPT_MS) fs.rmSync(path.join(moved, name), { recursive: true, force: true });
    }
    this.notify({ method: 'thread.deleted', params: { threadId } });
    this.log.info('moved a thread away', { threadId });
  },

  // T: where the thread will run here, and on which login, or why it can't.
  async planMove(this: Runner, row: MoveRow): Promise<MovePlan | { problem: string }> {
    const info = row.info!;
    const here = this.moveRunnerName(row.to);
    const accounts = this.accounts.list();
    let account = row.accountId ? accounts.find((a) => a.id === row.accountId) : undefined;
    if (row.accountId && !account) return { problem: `${here} has no login ${row.accountId}.` };
    account ??=
      accounts.find((a) => a.provider === info.provider && a.email && info.email && a.email.toLowerCase() === info.email.toLowerCase()) ??
      accounts.find((a) => a.id === this.defaultAccountId() && a.provider === info.provider) ??
      accounts.find((a) => a.provider === info.provider);
    if (!account) return { problem: `${here} has no ${info.provider === 'omp' ? 'Oh My Pi' : info.provider === 'codex' ? 'Codex' : 'Claude'} login.` };
    const leftBehind: string[] = [];
    const subdir = info.subdir ?? '';
    const into = (top: string) => (subdir ? path.join(top, ...subdir.split('/')) : top);

    // A repo: the same one here, by its origin.
    const findRepo = async (): Promise<string | undefined> => {
      if (!info.origin) return undefined;
      const want = repoKey(info.origin);
      const tops = new Set<string>();
      if (info.repoTop) tops.add(swapHome(info.repoTop, info.home));
      for (const t of this.threads.values()) tops.add(t.rec.worktree?.mainCheckout ?? t.rec.cwd);
      for (const c of tops) {
        if (!isDirectory(c)) continue;
        const top = await repoTop(c);
        const origin = top ? await originUrl(top) : undefined;
        if (top && origin && repoKey(origin) === want) return (await mainCheckoutOf(top)) ?? top;
      }
      return undefined;
    };

    if (row.cwd) {
      if (!isDirectory(row.cwd)) return { problem: `There's no folder ${row.cwd} on ${here}.` };
      const top = await repoTop(row.cwd);
      const origin = top ? await originUrl(top) : undefined;
      if (info.worktree && top && origin && info.origin && repoKey(origin) === repoKey(info.origin)) {
        const repo = (await mainCheckoutOf(top)) ?? top;
        return { cwd: repo, accountId: account.id, worktree: { repo, subdir }, leftBehind };
      }
      if (info.worktree) leftBehind.push(`Its worktree's git work stays behind, as ${row.cwd} isn't a copy of ${info.origin ?? 'its repo'}.`);
      return { cwd: row.cwd, accountId: account.id, leftBehind };
    }
    if (info.origin) {
      let repo = await findRepo();
      let cloneTo: { url: string; to: string } | undefined;
      if (!repo && info.repoTop) {
        const to = swapHome(info.repoTop, info.home);
        if (!fs.existsSync(to) && isDirectory(path.dirname(to))) {
          cloneTo = { url: info.origin, to };
          repo = to;
        }
      }
      if (!repo) return { problem: `${here} has no copy of ${info.origin}.` };
      const plan: MovePlan = info.worktree ? { cwd: repo, accountId: account.id, worktree: { repo, subdir }, leftBehind } : { cwd: into(repo), accountId: account.id, leftBehind };
      if (cloneTo) plan.clone = cloneTo;
      if (!cloneTo && !info.worktree && !isDirectory(plan.cwd)) return { problem: `There's no folder ${plan.cwd} on ${here}.` };
      return plan;
    }
    const cwd = swapHome(info.cwd, info.home);
    if (!isDirectory(cwd)) return { problem: `There's no folder ${cwd} on ${here}. Pick one to move it into.` };
    return { cwd, accountId: account.id, leftBehind };
  },

  // T: everything in place but the thread itself, which waits in staging
  // until the switch. Throws (after undoing what it made) to fail the move.
  async placeMove(this: Runner, row: MoveRow, entries: PackEntry[]): Promise<void> {
    const plan = row.plan!;
    const stage = stageOf(this.cfg.home, row.moveId);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const placed: Placed = { cwd: plan.cwd, transcript: [], leftBehind: [...plan.leftBehind], fromName: this.moveRunnerName(row.from) };
    const save = () => fs.writeFileSync(path.join(stage, 'placed.json'), JSON.stringify(placed));
    try {
      writeTree(entries, 'thread', path.join(stage, 'thread'));
      const recFile = path.join(stage, 'thread', 'thread.json');
      const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      if (rec.id !== row.threadId) throw new Error("The moved thread's record is for another thread.");
      if (rec.confined) throw new Error("A thread in a sandbox can't move yet.");
      const manifest = entries.find((e) => e.path === 'move.json');
      if (manifest) {
        const m = JSON.parse(manifest.data.toString('utf8')) as { leftBehind?: string[]; fromName?: unknown };
        placed.leftBehind.push(...(m.leftBehind ?? []));
        // A runner on its own key doesn't hear the other runners' names, so
        // the old one says its own (the note read "Moved from 7928812d92c1").
        if (placed.fromName === row.from && typeof m.fromName === 'string' && m.fromName.trim()) placed.fromName = m.fromName.trim().slice(0, 80);
      }
      const schedules = entries.find((e) => e.path === 'schedules.json');
      if (schedules) placed.schedules = JSON.parse(schedules.data.toString('utf8')) as unknown[];
      if (plan.clone) await clone(plan.clone.url, plan.clone.to);

      if (plan.worktree) {
        const patch = await findWorktreePatch(plan.worktree.repo, this.panelsRoot, this.patchCache, undefined, this.patchTrust);
        if (!patch) throw new Error(`${plan.worktree.repo} on ${this.moveRunnerName(row.to)} has no worktree patch, so the thread's worktree has nowhere to go.`);
        const made = await makeWorktree({ cwd: plan.worktree.repo, threadId: row.threadId, patch });
        if (!made.ok) throw new Error(`Couldn't make the thread's worktree: ${made.reason}`);
        placed.worktree = made.worktree;
        placed.patchFile = made.patchFile;
        placed.patchName = patch.patch;
        placed.cwd = plan.worktree.subdir ? path.join(made.worktree.path, ...plan.worktree.subdir.split('/')) : made.worktree.path;
        save();
        const metaEntry = entries.find((e) => e.path === 'git/meta.json');
        if (metaEntry) {
          const meta = JSON.parse(metaEntry.data.toString('utf8')) as GitMeta;
          const bundle = entries.find((e) => e.path === 'git/move.bundle');
          const bundleFile = path.join(stage, 'move.bundle');
          if (bundle) fs.writeFileSync(bundleFile, bundle.data);
          const r = await unpackGit(made.worktree.path, meta, bundle ? bundleFile : undefined);
          fs.rmSync(bundleFile, { force: true });
          if (!r.ok) throw new Error(r.reason);
        }
      }

      const account = this.accounts.list().find((a) => a.id === plan.accountId);
      if (!account) throw new Error(`No login ${plan.accountId} here.`);
      const sid: string | undefined = rec.nativeSessionId;
      const hasTranscript = sid && entries.some((e) => e.path === `transcript/${sid}.jsonl`);
      const oldCwd = rec.cwd as string;
      const oldAccount = rec.accountId as string;
      if (account.provider === 'claude' && rec.provider === 'claude' && hasTranscript) {
        const dir = path.join(account.configDir, 'projects', projectDirName(realpath(placed.cwd)));
        const mine = entries.filter((e) => e.path.startsWith('transcript/'));
        placed.transcript = mine.map((e) => path.join(dir, ...e.path.slice('transcript/'.length).split('/')));
        save();
        writeTree(mine, 'transcript', dir);
      } else if (rec.sessionUsed) {
        // No transcript to carry on from: a fresh session with the handoff
        // note, as a move to another provider is (runner.ts carryTranscript
        // can't find S's folder or login here, so it falls back).
        rec.handoff = { fromCwd: oldCwd, fromAccountId: oldAccount };
      }
      if (account.provider !== rec.provider) {
        rec.provider = account.provider;
        delete rec.model;
        delete rec.effort;
        delete rec.allowRules;
      }
      rec.cwd = placed.cwd;
      rec.accountId = account.id;
      delete rec.poolId;
      delete rec.worktreePending;
      delete rec.turnId;
      delete rec.stoppedMidTurn;
      rec.pendingApprovals = [];
      if (placed.worktree) rec.worktree = placed.worktree;
      else delete rec.worktree;
      fs.writeFileSync(recFile, JSON.stringify(rec, null, 2));
      save();
    } catch (e) {
      await this.discardMove(row);
      throw e;
    }
  },

  // T, after the switch: the staging folder joins the live threads. Safe to
  // call again (after a restart, say): once it's here there's nothing left.
  async adoptMoved(this: Runner, row: MoveRow): Promise<{ adopted: boolean; schedules?: unknown[] }> {
    const stage = stageOf(this.cfg.home, row.moveId);
    const placedFile = path.join(stage, 'placed.json');
    if (!fs.existsSync(placedFile)) return { adopted: false };
    const placed = JSON.parse(fs.readFileSync(placedFile, 'utf8')) as Placed;
    const dest = paths.thread(this.cfg.home, row.threadId);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(stage, 'thread'), dest);
    }
    this.adopt(row.threadId);
    const st = this.threads.get(row.threadId);
    if (!st) throw new Error("The moved thread didn't load.");
    const lines = [`Moved from ${placed.fromName} to ${this.moveRunnerName(row.to)}, in ${placed.cwd}.`, ...placed.leftBehind];
    this.emit(st, { type: 'system.note', text: lines.join(' ') });
    this.markDirty(st);
    fs.rmSync(stage, { recursive: true, force: true });
    if (placed.worktree && placed.patchFile && placed.patchName) {
      const patch = await findWorktreePatch(placed.worktree.mainCheckout, this.panelsRoot, this.patchCache, undefined, this.patchTrust).catch(() => undefined);
      if (patch) await this.setUpWorktree(st, { worktree: placed.worktree, patchFile: placed.patchFile }, patch);
    }
    this.log.info('took a moved thread in', { threadId: row.threadId, from: row.from });
    return { adopted: true, ...(placed.schedules?.length ? { schedules: placed.schedules } : {}) };
  },

  // T: the move failed or was cancelled before the switch.
  async discardMove(this: Runner, row: MoveRow): Promise<void> {
    let stage: string;
    try {
      stage = stageOf(this.cfg.home, row.moveId);
    } catch {
      return;
    }
    const placedFile = path.join(stage, 'placed.json');
    if (fs.existsSync(placedFile) && !this.threads.has(row.threadId)) {
      const placed = JSON.parse(fs.readFileSync(placedFile, 'utf8')) as Placed;
      for (const f of placed.transcript) fs.rmSync(f, { force: true });
      if (placed.worktree) await cleanUpWorktree(placed.worktree).catch(() => undefined);
    }
    fs.rmSync(stage, { recursive: true, force: true });
  },

  // T, for the Mac's Move sheet (threads.movePreview, a `moves.preview`
  // call): planMove's guess for a thread S described, with nothing made or
  // cloned, and this runner's logins of the thread's provider to pick from.
  // What would stop the move goes in `problems` rather than throwing, so the
  // sheet can say it and still offer the pickers.
  async previewMove(this: Runner, p: { info: MoveInfo; self: string; cwd?: string; accountId?: string }): Promise<MovePreview> {
    const accounts = this.accounts
      .list()
      .filter((a) => a.provider === p.info.provider)
      .map((a) => ({ id: a.id, provider: a.provider, title: a.title, ...(a.email ? { email: a.email } : {}) }));
    const now = Date.now();
    const row: MoveRow = { moveId: 'preview', threadId: '', from: '', to: p.self, state: 'asking', info: p.info, ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.accountId ? { accountId: p.accountId } : {}), createdAt: now, updatedAt: now };
    const plan = await this.planMove(row);
    if ('problem' in plan) return { accounts, leftBehind: [], problems: [plan.problem] };
    const problems: string[] = [];
    // placeMove's own check, seen before Mike presses Move rather than
    // after the thread has frozen and packed. A repo still to be cloned
    // can't be looked at yet.
    if (plan.worktree && !plan.clone) {
      const patch = await findWorktreePatch(plan.worktree.repo, this.panelsRoot, this.patchCache, undefined, this.patchTrust).catch(() => undefined);
      if (!patch) problems.push(`${plan.worktree.repo} on ${this.moveRunnerName(p.self)} has no worktree patch, so the thread's worktree has nowhere to go.`);
    }
    return {
      cwd: plan.cwd,
      accountId: plan.accountId,
      accounts,
      leftBehind: plan.leftBehind,
      problems,
      ...(plan.worktree ? { worktree: true } : {}),
      ...(plan.clone ? { clone: plan.clone.to } : {}),
    };
  },

  moveRunnerName(this: Runner, runnerId: string): string {
    return this.runnerNames?.(runnerId) ?? runnerId;
  },
};

export type MovesPart = RunnerPart<typeof movesPart>;
