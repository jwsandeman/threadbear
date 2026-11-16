import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { ThreadbearWorld } from '../support/world.ts';

// `colours`: the look's named colours as #rrggbb (desktop/gpui/src/automation.rs).
type Colours = { panel: string; rail: string; accent: string; link: string; onAccent: string; needsYou: string; running: string; diagram: string };

async function colours(world: ThreadbearWorld): Promise<Colours> {
  const result = await world.app.do({ cmd: 'colours' });
  return (typeof result === 'string' ? JSON.parse(result.replace(/^ok /, '')) : result) as Colours;
}

When('I switch the app to the {word} look', async function (this: ThreadbearWorld, mode: string) {
  await this.app.do({ cmd: 'appearance', mode });
});

Then('the panels are {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).panel, hex);
});

Then('the icon rails are {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).rail, hex);
});

Then('the icon rails match the panels', async function (this: ThreadbearWorld) {
  const c = await colours(this);
  assert.equal(c.rail, c.panel);
});

Then('diagrams are drawn on {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).diagram, hex);
});

Then('the accent is {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).accent, hex);
});

Then('the accent is not {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.notEqual((await colours(this)).accent, hex);
});

Then('links are {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).link, hex);
});

Then('words on the accent are {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).onAccent, hex);
});

Then('Needs you is {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).needsYou, hex);
});

Then('Needs you is not {string}', async function (this: ThreadbearWorld, hex: string) {
  assert.notEqual((await colours(this)).needsYou, hex);
});

Then("a running thread's spinner is {string}", async function (this: ThreadbearWorld, hex: string) {
  assert.equal((await colours(this)).running, hex);
});
