// Waiting out a dropped connection to the API: probing until it is back, then carrying the turn on (waitingForNetwork).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { reachable } from '../net-probe.ts';
import type { Provider } from '../protocol.ts';
import type { ThreadState } from '../runner.ts';
import { CARRY_ON_NETWORK, NET_CARRY_ON_MAX, NET_PROBE_FIRST_MS, NET_PROBE_MAX_MS, NET_WAIT_MAX_MS } from '../runner.ts';

export const networkPart = {
  // A turn failed because the API couldn't be reached (errorKind network,
  // after the CLI's own retries): the thread waits, with a note, and
  // carries on by itself once a probe reaches the API again (3 Nov 2026:
  // Mike's internet went for five minutes and six threads stopped dead
  // until he told each one to continue). A carry-on that can't get
  // through either waits again, up to NET_CARRY_ON_MAX times or
  // NET_WAIT_MAX_MS from the first failure; then it's left to him. Only
  // the network: limits, the login and real errors never retry by
  // themselves. A message already queued goes next instead.
  onNetworkLost(this: Runner, st: ThreadState, turnId: string): void {
    const { rec } = st;
    // The same outage if this was the runner's carry-on, or a turn the CLI
    // opened by itself during the wait (a background job ended).
    const chain = rec.netCarryOn?.turnId === turnId ? rec.netCarryOn : rec.waitingForNetwork;
    delete rec.netCarryOn;
    delete rec.waitingForNetwork;
    this.markDirty(st);
    if (this.bucket(rec) !== 'inbox' || rec.queue.length) return;
    // OMP may use any model endpoint; an Anthropic/OpenAI probe cannot verify it.
    if (rec.provider === 'omp') {
      this.emit(st, { type: 'system.note', text: "Oh My Pi could not reach its model provider. Send a message to try again." });
      return;
    }
    const since = chain?.since ?? this.isoNow();
    const tries = chain?.tries ?? 0;
    if (tries >= NET_CARRY_ON_MAX || this.clock.now() - Date.parse(since) > NET_WAIT_MAX_MS) {
      this.emit(st, { type: 'system.note', text: "Still can't reach the API, so this thread has stopped trying by itself. Send a message to carry on." });
      return;
    }
    rec.waitingForNetwork = { since, tries };
    if (!chain) this.emit(st, { type: 'system.note', text: "Lost the connection to the API partway through that turn. This thread carries on by itself once it's back." });
    this.markDirty(st);
    this.armNetTimer(true);
  },

  // One timer for every thread waiting for the network. `restart` starts
  // the backoff again (a new wait, a restart); otherwise a pending probe
  // is left be. A draining runner's waits are the next runner's.
  armNetTimer(this: Runner, restart = false): void {
    if (this.stopping || this.draining) return;
    const waiting = [...this.threads.values()].some((st) => st.rec.waitingForNetwork);
    if (!waiting) {
      this.netTimer?.cancel();
      this.netTimer = undefined;
      this.netProbes = 0;
      return;
    }
    if (restart) this.netProbes = 0;
    else if (this.netTimer) return;
    this.netTimer?.cancel();
    const delay = Math.min(NET_PROBE_MAX_MS, NET_PROBE_FIRST_MS * 2 ** this.netProbes);
    this.netTimer = this.clock.setTimeout(() => {
      this.netTimer = undefined;
      void this.probeNetwork();
    }, delay);
  },

  // Tries each waiting provider's API once; the threads whose API answers
  // carry on, the rest wait for the next probe.
  async probeNetwork(this: Runner): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const waiting = [...this.threads.values()].filter((st) => st.rec.waitingForNetwork);
      const up = new Map<Provider, boolean>();
      for (const provider of new Set(waiting.map((st) => st.rec.provider))) {
        up.set(provider, await this.reachable(provider).catch(() => false));
      }
      if (this.stopping || this.draining) return;
      for (const st of waiting) if (st.rec.waitingForNetwork && up.get(st.rec.provider)) this.endNetWait(st);
      this.netProbes++;
    } catch (e) {
      this.log.error('could not check the network', { error: String(e) });
    } finally {
      this.probing = false;
    }
    this.armNetTimer();
  },

  // The API answers again: carry on, unless the thread's moved on by
  // itself meanwhile (a turn, a message waiting, archived or snoozed).
  endNetWait(this: Runner, st: ThreadState): void {
    const { rec, rt } = st;
    const w = rec.waitingForNetwork;
    if (!w) return;
    if (this.refusing) return; // a restart is coming; the next runner carries on
    delete rec.waitingForNetwork;
    this.markDirty(st);
    if (rt.deleted || rt.turn || rec.queue.length || this.bucket(rec) !== 'inbox') return;
    try {
      const turnId = this.sendTo(st, CARRY_ON_NETWORK, [], { origin: 'runner', queue: true });
      rec.netCarryOn = { turnId, since: w.since, tries: w.tries + 1 };
      this.markDirty(st);
      this.log.info('carried on after the network came back', { threadId: rec.id, tries: w.tries + 1 });
    } catch (e) {
      this.log.error('could not carry on after the network came back', { threadId: rec.id, error: String(e) });
    }
  },
};

export type NetworkPart = RunnerPart<typeof networkPart>;
