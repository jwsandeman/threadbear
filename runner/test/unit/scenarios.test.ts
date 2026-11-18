// Each scenario plays one thread and reads it three ways (helpers/routes.ts):
// on this runner, on another runner's thread from the Mac through Convex, and
// on the iPhone and the website. What a person sees (the card, its notes and
// pick, the follow-ups, the messages and their pictures) has to be the same
// on all three, or the difference has to be in KNOWN below with why. A
// decision card's notes (8 Nov) went missing on the way to another Mac with
// every test passing, as nothing compared the routes.
//
// A new feature that changes what a thread shows gets a scenario here. The
// agent building it writes it; it runs in the quick check in a second or two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threeWays, type View } from '../helpers/routes.ts';
import { SCENARIOS } from '../helpers/scenario-list.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import fs from 'node:fs';
import path from 'node:path';

type Route = 'relay' | 'phone';
type Field = 'needs' | 'asks' | 'next' | 'looseEnds' | 'review' | 'plans' | 'messages' | 'notes' | 'pictures' | 'failed' | 'origins';

// Differences that are meant, each with why. A test below fails once one
// of these stops being a difference, so the list can't outlive its reason.
const KNOWN: { route: Route; field: Field; why: string }[] = [
  { route: 'phone', field: 'pictures', why: "phone:thread carries words only; the phone gets a message's pictures from phone:images." },
  { route: 'phone', field: 'plans', why: "phone:thread carries words only; the phone gets a message's plan flag from phone:messages (API 72) and draws its own plan card." },
];


function pick(v: View, field: Field): unknown {
  switch (field) {
    case 'messages':
      return v.messages.map(({ role, text }) => ({ role, text }));
    case 'pictures':
      return v.messages.map((m) => m.pictures);
    case 'origins':
      return v.messages.map((m) => m.origin ?? null);
    default:
      return field === 'needs' || field === 'review' ? (v[field] ?? null) : v[field];
  }
}
const FIELDS: Field[] = ['needs', 'asks', 'next', 'looseEnds', 'review', 'plans', 'messages', 'notes', 'pictures', 'failed', 'origins'];
const known = (route: Route, field: Field) => KNOWN.find((k) => k.route === route && k.field === field);

for (const s of SCENARIOS) {
  test(`the same on every route: ${s.name}`, async () => {
    const { views, refused } = await threeWays(s.play);
    assert.deepEqual(refused, [], 'the backend took everything the runner sent');
    for (const route of ['relay', 'phone'] as const) {
      for (const field of FIELDS) {
        if (known(route, field)) continue;
        assert.deepEqual(pick(views[route], field), pick(views.here, field), `${field} differs on ${route === 'relay' ? 'another Mac (through Convex)' : 'the phone and website'}`);
      }
    }
  });
}

test('each known difference is still a difference, and says why', async () => {
  const all = await Promise.all(SCENARIOS.map((s) => threeWays(s.play)));
  for (const k of KNOWN) {
    assert.ok(k.why.trim().endsWith('.'), 'says why, as a sentence');
    const differs = all.some(({ views }) => JSON.stringify(pick(views[k.route], k.field)) !== JSON.stringify(pick(views.here, k.field)));
    assert.ok(differs, `${k.field} on ${k.route} is the same as here now: take it out of KNOWN`);
  }
});

// The same real backend as the route scenarios: a second pane already has
// every row except an older reply. Reopening it must restore that reply
// without replaying all the synthetic markers it already showed.
test('another Mac reopens a thread with only the reply its pane missed', async () => {
  const { relay, relayEvents, threadId, refused } = await threeWays((p) => {
    p.say('The earlier reply.');
    p.endTurn({ needs: 'nothing' });
    p.send('Carry on.');
    p.say('The latest reply.');
    p.endTurn({ needs: 'nothing' });
  });
  assert.deepEqual(refused, []);
  const missing = relayEvents.find((e) => e.type === 'assistant.text' && e.text === 'The earlier reply.');
  assert.ok(missing);
  const seen: [number, number][] = [];
  for (const seq of relayEvents.map((e) => Number(e.seq)).filter((seq) => seq !== missing.seq).sort((a, b) => a - b)) {
    const last = seen.at(-1);
    if (last && seq <= last[1] + 1) last[1] = Math.max(seq, last[1]);
    else seen.push([seq, seq]);
  }
  const reply = await relay.call(threadId, 'threads.subscribe', { afterSeq: Math.max(...relayEvents.map((e) => Number(e.seq))), relaySeen: seen }) as { events: Record<string, unknown>[] };
  assert.deepEqual(reply.events.map((e) => e.seq), [missing.seq]);
  assert.equal(reply.events[0]?.text, 'The earlier reply.');
});

// 17 Nov 2026: a picture pasted on one Mac into the other's thread reached
// it and showed as a message with no picture on the Mac it was pasted on.
// The runner that owns the thread uploads it for the phone; the other Mac's
// relay gives the app the message with its pictures, and the file itself
// when the app asks its runner for it (files.read with that runner's id).
test("another Mac gets a message's pictures, and each file from the backend", async () => {
  const dir = tmpDir('tb-scenario-');
  const png = makePng(6, 4);
  const files = ['a.png', 'b.png'].map((name) => path.join(dir, name));
  for (const f of files) fs.writeFileSync(f, png);
  const { relay, relayEvents, runnerId, refused, views } = await threeWays((p) => {
    p.say('Ready.');
    p.endTurn({ needs: 'nothing' });
    // One placed in the words, one not.
    p.send('like [Picture 2] please', files.map((f) => ({ path: f, mediaType: 'image/png' })));
    p.say('Done.');
    p.endTurn({ needs: 'nothing' });
  });
  assert.deepEqual(refused, []);
  const said = relayEvents.find((e) => e.type === 'user.message' && String(e.text).includes('please'))!;
  // The words as on the Mac that has the thread: no line counting the pictures.
  assert.equal(said.text, 'like [Picture 2] please');
  assert.deepEqual(views.relay.messages, views.here.messages);
  assert.deepEqual(said.images.map((i: { mediaType: string; width?: number; height?: number }) => [i.mediaType, i.width, i.height]), [['image/png', 6, 4], ['image/png', 6, 4]]);
  for (const image of said.images as { path: string }[]) {
    const read = (await relay.readFile(runnerId, image.path)) as { data: string; mediaType: string; truncated: boolean };
    assert.deepEqual(Buffer.from(read.data, 'base64'), Buffer.from(png));
    assert.equal(read.mediaType, 'image/png');
    assert.equal(read.truncated, false);
  }
  // Nothing else on that Mac is read this way.
  await assert.rejects(relay.readFile(runnerId, path.join(dir, 'other.png')), /kept there for now/);
});

// 19 Nov 2026: a screenshot a tool took in a thread on one Mac, and a
// picture in the agent's reply there, showed on the other Mac as a line
// counting pictures and as a link. The tool's result now has a place for
// each picture, fetched from that runner when the app asks (as the phone
// asks: a `picture` command, held for a day), and the reply's picture
// comes from what that runner uploads for the phone, by the address the
// reply names.
test("another Mac gets a tool's pictures when it asks, and a reply's from the backend", async () => {
  const dir = tmpDir('tb-scenario-');
  const png = makePng(8, 5);
  const chart = path.join(dir, 'chart.png');
  fs.writeFileSync(chart, png);
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, png);
  const said = `Here it is: ![the chart](${chart})`;
  const { relay, relayEvents, runnerId, refused, threadId, post, upload } = await threeWays(
    (p) => {
      p.tool('screencapture shot.png', 'saved', [{ path: shot, mediaType: 'image/png' }]);
      p.say(said);
      p.endTurn({ needs: 'nothing' });
    },
    { full: true },
  );
  assert.deepEqual(refused, []);

  // The reply is as on the Mac that has the thread, and its picture answers by the address in it.
  assert.equal(relayEvents.find((e) => e.type === 'assistant.text' && String(e.text).includes('chart'))!.text, said);
  const drawn = (await relay.readFile(runnerId, chart)) as { data: string; mediaType: string; truncated: boolean };
  assert.deepEqual([Buffer.from(drawn.data, 'base64'), drawn.mediaType, drawn.truncated], [Buffer.from(png), 'image/png', false]);

  // The tool, opened: its result has a place for its picture.
  const call = relayEvents.find((e) => e.type === 'tool.call' && String(e.title).includes('screencapture shot.png'))!;
  const result = relayEvents.find((e) => e.type === 'tool.result' && e.itemId === call.itemId)!;
  const seq = result.heldBack.seq as number;
  assert.deepEqual(await relay.call(threadId, 'threads.heldBody', { threadId, seq }), { state: 'text' });
  const { events } = (await relay.call(threadId, 'threads.events', { threadId })) as { events: Record<string, any>[] };
  const filled = events.filter((e) => e.type === 'tool.result' && e.itemId === call.itemId).at(-1)!;
  assert.equal(filled.text, 'saved');
  assert.deepEqual(filled.images, [{ path: `threadbear-relay:${threadId}/${seq}/Tool picture 1`, mediaType: 'image/png' }]);
  const place = filled.images[0].path as string;

  // Asked for, it's queued for that runner as the phone's is. Nothing listens
  // for the command's end here, so this first read says it hasn't come.
  await assert.rejects(relay.readFile(runnerId, place), /didn't send that picture/);
  const pending = (await post('query', 'sync:pendingCommands', { key: 'owner-key', runnerId })) as { commandId: string; kind: string; threadId: string; args: Record<string, unknown> }[];
  assert.deepEqual(pending.map((c) => [c.kind, c.threadId, c.args.seq, c.args.index]), [['picture', threadId, seq, 0]]);
  // That runner's part (sync.ts sendHeldPicture, full-sync.test.ts): take it, upload the picture, finish.
  assert.equal(await post('mutation', 'sync:takeCommand', { key: 'owner-key', commandId: pending[0]!.commandId }), true);
  const storageId = await upload('', new Uint8Array(png));
  await post('mutation', 'sync:addHeldPicture', { key: 'owner-key', threadId, seq, index: 0, storageId, mediaType: 'image/png', width: 8, height: 5 });
  const read = (await relay.readFile(runnerId, place)) as { data: string; mediaType: string; truncated: boolean };
  assert.deepEqual([Buffer.from(read.data, 'base64'), read.mediaType, read.truncated], [Buffer.from(png), 'image/png', false]);
  assert.deepEqual(refused, []);
});
