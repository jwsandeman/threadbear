// A tool's pictures on another runner's thread, for the owner's other Mac
// (convex/relay.ts toolPictureAt and the `picture` kind of queueCommand;
// docs/protocol.md, "Other runners' threads through the backend"). The phone
// already asks that runner for one picture at a time (phone:requestPicture)
// and reads it from heldPictures; these are the same two steps for a runner
// with the owner key, played through the backend's own functions in the
// in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const relay = load('relay');
const commandArgs = relay.commandArgs as unknown as (kind: string, a: unknown) => Record<string, unknown>;

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: MINI, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'B', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  return b;
}

test('the owner key reads one held tool picture, with where to fetch it', async () => {
  const b = await setup();
  await b.ctx.db.insert('heldPictures', { threadId: 'B', seq: 14, index: 1, storageId: b.file('shot-2'), mediaType: 'image/png', width: 800, height: 600, at: Date.now() });
  assert.deepEqual(await call(b.ctx, relay.toolPictureAt, { key: OWNER, threadId: 'B', seq: 14, index: 1 }), { url: 'https://files.example/shot-2', mediaType: 'image/png', width: 800, height: 600 });
  // Not that tool's other picture, another tool's or another thread's.
  assert.equal(await call(b.ctx, relay.toolPictureAt, { key: OWNER, threadId: 'B', seq: 14, index: 0 }), null);
  assert.equal(await call(b.ctx, relay.toolPictureAt, { key: OWNER, threadId: 'B', seq: 15, index: 1 }), null);
  assert.equal(await call(b.ctx, relay.toolPictureAt, { key: OWNER, threadId: 'other', seq: 14, index: 1 }), null);
});

test('one whose file has gone reads as not held', async () => {
  const b = await setup();
  await b.ctx.db.insert('heldPictures', { threadId: 'B', seq: 14, index: 0, storageId: 'file-never-stored', mediaType: 'image/png', at: Date.now() });
  assert.equal(await call(b.ctx, relay.toolPictureAt, { key: OWNER, threadId: 'B', seq: 14, index: 0 }), null);
});

test("a runner key can't read one, even of its own thread", async () => {
  const b = await setup();
  await b.ctx.db.insert('heldPictures', { threadId: 'B', seq: 14, index: 0, storageId: b.file('shot'), mediaType: 'image/png', at: Date.now() });
  assert.equal(await outcome(call(b.ctx, relay.toolPictureAt, { key: MINI_KEY, threadId: 'B', seq: 14, index: 0 })), 'forbidden');
  assert.equal(await outcome(call(b.ctx, relay.toolPictureAt, { key: 'wrong', threadId: 'B', seq: 14, index: 0 })), 'auth');
});

test("a picture command carries only the tool's seq and which picture", () => {
  assert.deepEqual(commandArgs('picture', { seq: 14, index: 2, path: '/etc/passwd', text: 'x' }), { seq: 14, index: 2 });
  for (const bad of [{ seq: 14 }, { index: 0 }, { seq: 0, index: 0 }, { seq: 1.5, index: 0 }, { seq: 14, index: -1 }, { seq: 14, index: 101 }, { seq: '14', index: 0 }, { seq: Number.MAX_VALUE, index: 0 }]) {
    assert.throws(() => commandArgs('picture', bad), /no such picture/, JSON.stringify(bad));
  }
});

test("the owner key queues a picture command for the thread's runner, which may then hold that picture", async () => {
  const b = await setup();
  const commandId = await call(b.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'picture', args: { seq: 14, index: 0, more: 'dropped' } });
  const queued = (await b.ctx.db.get(commandId as never)) as unknown as { kind: string; runnerId: string; threadId: string; state: string; args: unknown };
  assert.deepEqual([queued.kind, queued.runnerId, queued.threadId, queued.state, queued.args], ['picture', MINI, 'B', 'pending', { seq: 14, index: 0, from: 'mac' }]);
  // That runner takes it and uploads the picture, as for the phone's.
  assert.equal(await call(b.ctx, sync.takeCommand, { key: MINI_KEY, commandId }), true);
  const ticket = new URL(await call(b.ctx, sync.iconUploadUrl, { key: MINI_KEY })).searchParams.get('ticket')!;
  assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: b.file('shot'), bytes: 1 }), true);
  assert.equal(await call(b.ctx, sync.addHeldPicture, { key: MINI_KEY, threadId: 'B', seq: 14, index: 0, storageId: 'shot', mediaType: 'image/png', width: 10, height: 8 }), null);
  assert.deepEqual(await call(b.ctx, relay.toolPictureAt, { key: OWNER, threadId: 'B', seq: 14, index: 0 }), { url: 'https://files.example/shot', mediaType: 'image/png', width: 10, height: 8 });
  // A picture command needs a thread, and a runner key can't queue one.
  assert.equal(await outcome(call(b.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, kind: 'picture', args: { seq: 14, index: 0 } })), 'badArgs');
  assert.equal(await outcome(call(b.ctx, relay.queueCommand, { key: MINI_KEY, runnerId: MINI, threadId: 'B', kind: 'picture', args: { seq: 14, index: 0 } })), 'forbidden');
});
