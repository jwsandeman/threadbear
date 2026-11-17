// Pictures in another runner's messages, for the owner's other Mac
// (convex/relay.ts picturesAtSeqs; docs/protocol.md, "Other runners' threads
// through the backend"). A picture pasted on one Mac into a thread on the
// other arrived there and showed as a message with no picture on the Mac it
// was pasted on (17 Nov 2026). The owning runner already uploads pasted
// pictures for the phone and the website (replyImages); this is the read a
// runner with the owner key makes of them, played through the backend's own
// functions in the in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: MINI, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'B', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const picture = (seq: number, n: number, more: Record<string, unknown> = {}) =>
    b.ctx.db.insert('replyImages', { threadId: 'B', seq, path: `/Users/b/inbox/p${seq}-${n}.png`, src: `picture:${n}`, storageId: b.file(`file-${seq}-${n}`), mediaType: 'image/png', width: 40, height: 30, ...more });
  return { b, picture };
}

test('the owner key reads the pictures of the messages it names, each with where to fetch it', async () => {
  const { b, picture } = await setup();
  await picture(7, 1);
  await picture(7, 2);
  await picture(9, 1);
  // A reply's picture on a row that wasn't asked for.
  await b.ctx.db.insert('replyImages', { threadId: 'B', seq: 8, path: '/Users/b/x/chart.png', src: 'chart.png', storageId: b.file('chart'), mediaType: 'image/png' });
  const got = await call(b.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: [7, 9, 11] });
  assert.deepEqual(got, [
    { seq: 7, path: '/Users/b/inbox/p7-1.png', src: 'picture:1', url: 'https://files.example/file-7-1', mediaType: 'image/png', width: 40, height: 30 },
    { seq: 7, path: '/Users/b/inbox/p7-2.png', src: 'picture:2', url: 'https://files.example/file-7-2', mediaType: 'image/png', width: 40, height: 30 },
    { seq: 9, path: '/Users/b/inbox/p9-1.png', src: 'picture:1', url: 'https://files.example/file-9-1', mediaType: 'image/png', width: 40, height: 30 },
  ]);
  // Another thread's rows never come with it.
  assert.deepEqual(await call(b.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'other', seqs: [7] }), []);
});

test('a picture whose file has gone is left out, and seqs that are not seqs are passed over', async () => {
  const { b, picture } = await setup();
  await picture(7, 1);
  await b.ctx.db.insert('replyImages', { threadId: 'B', seq: 7, path: '/Users/b/inbox/gone.png', src: 'picture:2', storageId: 'file-never-stored', mediaType: 'image/png' });
  const got = (await call(b.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: [7, -1, 1.5, Number.MAX_VALUE] })) as { path: string }[];
  assert.deepEqual(got.map((p) => p.path), ['/Users/b/inbox/p7-1.png']);
});

test("a runner key can't read them, even of its own thread", async () => {
  const { b, picture } = await setup();
  await picture(7, 1);
  assert.equal(await outcome(call(b.ctx, relay.picturesAtSeqs, { key: MINI_KEY, threadId: 'B', seqs: [7] })), 'forbidden');
  assert.equal(await outcome(call(b.ctx, relay.picturesAtSeqs, { key: 'wrong', threadId: 'B', seqs: [7] })), 'auth');
});

test('at most fifty messages are read in one call', async () => {
  const { b, picture } = await setup();
  for (let seq = 1; seq <= 60; seq++) await picture(seq, 1);
  const got = (await call(b.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: Array.from({ length: 60 }, (_, i) => i + 1) })) as { seq: number }[];
  assert.deepEqual(got.map((p) => p.seq), Array.from({ length: 50 }, (_, i) => i + 1));
});
