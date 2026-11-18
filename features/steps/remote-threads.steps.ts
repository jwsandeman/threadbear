import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The mock's threads on "mac-mini" (@remote-threads turns them on, world.ts).

When('its runner lets the thread go to mac-mini', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(d.selection?.id);
  await this.app.do({ cmd: 'mock', method: 'moveAway', params: { threadId: d.selection.id } });
});

When('its runner lets the thread go to mac-mini while the old Mac still lists it', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(d.selection?.id);
  await this.app.do({ cmd: 'mock', method: 'moveAway', params: { threadId: d.selection.id, staleIndex: true } });
});

Then('the row {string} is on the runner {string}', async function (this: ThreadbearWorld, title: string, runner: string) {
  await this.until(`"${title}" on ${runner}`, (d) => this.thread(d, title)?.runner === runner);
});

Then('the row {string} has the machine tile', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" with the machine tile`, (d) => this.thread(d, title)?.tile === 'runner');
});

Then('the row {string} isn\'t on another runner', async function (this: ThreadbearWorld, title: string) {
  const d = await this.app.dump();
  const t = this.thread(d, title);
  assert.ok(t, `no row ${title}`);
  assert.ok(!t.runner, `"${title}" says it's on ${t.runner}`);
});

Then('the composer is on the runner {string}', async function (this: ThreadbearWorld, runner: string) {
  await this.until(`the composer on ${runner}`, (d) => d.composer.runner === runner);
});

When('I make {string} the default runner', async function (this: ThreadbearWorld, runner: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'runner', setDefault: runner });
});

Given('a move would leave nothing behind', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'moveLeftBehind', params: { lines: [] } });
});

// `move` asks like Move to ▸ that runner does, once the runner list has come.
When('I ask to move the thread {string} to {string}', async function (this: ThreadbearWorld, title: string, runner: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  let lastError: unknown;
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      await this.app.do({ cmd: 'move', id: t.id, runner });
      return;
    } catch (e) {
      lastError = e;
      await sleep(150);
    }
  }
  throw lastError;
});

Then('the move sheet says {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the sheet "${title}"`, (d) => d.moveSheet?.title === title);
});

Then('the move sheet warns {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`the warning "${line}"`, (d) => d.moveSheet?.leftBehind?.includes(line));
});

Then('the move sheet offers the folder {string}', async function (this: ThreadbearWorld, folder: string) {
  await this.until(`the folder ${folder}`, (d) => d.moveSheet?.folder === folder);
});

Then('the move sheet\'s login is {string}', async function (this: ThreadbearWorld, login: string) {
  await this.until(`the login ${login}`, (d) => d.moveSheet?.login === login);
});

When('I press Move in the move sheet for {string}', async function (this: ThreadbearWorld, runner: string) {
  await this.until('the sheet ready to move', (d) => d.moveSheet?.canMove === true);
  // Past the sheet's entrance animation, so the click lands on the button
  // where it's about to settle (GPUI's dialog slides in).
  await sleep(1200);
  await this.app.do({ cmd: 'click', tip: `Move it to ${runner} once this turn ends` });
});

Then('the move sheet is closed', async function (this: ThreadbearWorld) {
  await this.until('the sheet gone', (d) => !d.moveSheet);
});

Then('the move sheet stayed closed', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(!d.moveSheet, 'the sheet came up');
});

// A reply on mac-mini with three pictures: one the mock's runner hands over
// for mac-mini (server.mjs BRUCE_REPLY_PICTURE), a real picture file on this
// Mac, and a web address.
const SENT_UP = '/Users/alex/Pictures/backup-sizes.png';
const WEB = 'https://example.com/backup.png';
const mine = new WeakMap<ThreadbearWorld, string>();

Given("mac-mini's reply names a picture it sent up, a picture file of this Mac's and a web picture", async function (this: ThreadbearWorld) {
  const file = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reply-picture-'))), 'mine.png');
  // A 1 by 1 PNG.
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  mine.set(this, file);
  const text = `The backup finished. Sizes by day: ![sizes](${SENT_UP})\n\nNot these: ![mine](${file}) ![web](${WEB})`;
  await this.app.do({ cmd: 'mock', method: 'replaceReply', params: { threadId: 'mini_backup', text } });
});

Then('the pictures of its reply are drawn as {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until('its reply', (d) => d.transcript.rows.some((r) => r.kind === 'assistant'));
  let said = '';
  for (let tries = 0; tries < 60; tries += 1) {
    said = await this.app.do({ cmd: 'reply-pictures' }).catch((e) => String(e));
    if (said.replace(/^reply-pictures /, '') === `ok ${words}`) return;
    await sleep(150);
  }
  assert.fail(`the reply's pictures are drawn as "${said}", not "${words}"`);
});

Then("the runner was asked for the reply's pictures on mac-mini, but never for the web picture", async function (this: ThreadbearWorld) {
  const answer = await this.app.do({ cmd: 'mock', method: 'remoteFileAsks' });
  const asks = (JSON.parse(answer.replace(/^(\w+ )?ok /, '')).asks as { path: string; reply: boolean }[]).filter((a) => a.reply);
  assert.deepEqual(asks.map((a) => a.path).sort(), [SENT_UP, mine.get(this)!].sort());
  assert.ok(!asks.some((a) => a.path === WEB));
});

// Both apps' `tiles`: what each picture of the message says when it isn't
// drawn ("Couldn't get it from mac-mini"), "picture" when it is.
Then('pressing the picture chip in my message opens nothing', async function (this: ThreadbearWorld) {
  const row = await this.until('my message', (d) => d.transcript.rows.find((r) => r.kind === 'user'));
  const said = await this.app.do({ cmd: 'peek', row: row.id, words: 'Picture 1', press: true }).then((r) => `ok ${r}`, (e) => String(e));
  assert.ok(!said.includes('quicklook'), `the chip opened something: ${said}`);
});

Then('the pictures of my message say {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until('a message with pictures', (d) => d.transcript.rows.some((r) => r.kind === 'user'));
  let said = '';
  for (let tries = 0; tries < 60; tries += 1) {
    said = await this.app.do({ cmd: 'tiles', count: 1 }).catch((e) => String(e));
    // The Swift app's answer starts with the command's name.
    if (said.replace(/^tiles /, '') === `ok ${words}`) return;
    await sleep(150);
  }
  assert.fail(`the pictures say "${said}", not "${words}"`);
});

// The row's Cancel Move (`move` with `cancel`).
When('I cancel the move of {string}', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.app.do({ cmd: 'move', id: t.id, cancel: true });
});

// What the box says in place of its words while its thread moves, and so
// it and its card take nothing (the dump's composer.moving).
type WithMoving = { moving?: string | null };
Then('the box is locked, saying {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`the box locked with "${line}"`, (d) => (d.composer as WithMoving).moving === line);
});

Then("the box isn't locked", async function (this: ThreadbearWorld) {
  await this.until('the box unlocked', (d) => !(d.composer as WithMoving).moving);
});

When('its runner lets the thread go to {string}', async function (this: ThreadbearWorld, to: string) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveAway', params: { threadId: d.selection?.id, to } });
});

When('the destination lists the moved thread', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveArrive', params: { threadId: d.selection?.id } });
  // Allow the destination read/subscription to finish before it emits events.
  await this.app.do({ cmd: 'waitFor', loaded: true });
  await sleep(500);
});

When('a reply arrives on the destination', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'stream', params: { threadId: d.selection?.id, text: 'The destination is serving this thread', hz: 60 } });
});

When('its old runner lists the thread again', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveSourceBack', params: { threadId: d.selection?.id } });
  await sleep(500);
});

When('the index restarts while its move to this Mac is waiting', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveIndexRestart', params: { threadId: d.selection?.id } });
});

When('that waiting move is cancelled', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveCancelAfterRestart', params: { threadId: d.selection?.id } });
});

When('its move to this Mac is claimed before the local thread arrives', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveIndexRestart', params: { threadId: d.selection?.id } });
  // Keep the source row until claimed, unlike the moveAway example.
  await this.app.do({ cmd: 'mock', method: 'moveArrive', params: { threadId: d.selection?.id, claimedFirst: true } });
  await sleep(500);
});

// Runs on › Folder › Other…, the path typed in its dialog and Return pressed.
When('I type {string} as the folder on that machine', async function (this: ThreadbearWorld, folder: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'runner', click: 'Other…', folder });
});
