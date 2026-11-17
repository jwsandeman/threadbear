// Annotate over a page shown inside the app (browser-annotations.feature),
// on the GPUI app: `annotate` presses its button and runs scripts in the
// tools' world, and `webPanel`'s `devtools` reaches the tools' own controls,
// which are in a closed shadow root no script in the page can open.
import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { okValue, sleep, type Dump } from '../support/driver.ts';
import { pane } from '../support/pane.ts';
import { sites } from '../support/web-runtime.ts';
import type { ThreadbearWorld } from '../support/world.ts';

type Annotate = { button?: string; active: boolean; status?: string; key?: string; context?: number | null };
type AnnotateWorld = ThreadbearWorld & { rowsBefore?: number; pages?: Map<string, number> };
type AxNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number };
type WebPage = { key: string; title: string; hidden: boolean; loading: boolean };

const annotate = (d: Dump) => (pane(d) as { annotate?: Annotate } | undefined)?.annotate;
const webPages = (d: Dump) => (d as { webPanels?: { pages?: WebPage[] } }).webPanels?.pages ?? [];

async function state(world: ThreadbearWorld): Promise<Annotate> {
  return JSON.parse(okValue(await world.app.do({ cmd: 'annotate', do: 'state' }))) as Annotate;
}

/** A script in the tools' world, where the page's own scripts can't reach. */
async function tools(world: ThreadbearWorld, js: string): Promise<unknown> {
  return (JSON.parse(okValue(await world.app.do({ cmd: 'annotate', do: 'tools', js }))) as { value?: unknown }).value;
}

async function devtools(world: ThreadbearWorld, key: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return (JSON.parse(okValue(await world.app.do({ cmd: 'webPanel', do: 'devtools', key, method, params }))) as { result: Record<string, any> }).result;
}

/** One of the tools' own controls, by what a screen reader calls it. */
async function control(world: ThreadbearWorld, role: string, name: string): Promise<{ key: string; objectId: string } | undefined> {
  const { key, context } = await state(world);
  if (!key || context == null) return undefined;
  const { nodes } = (await devtools(world, key, 'Accessibility.getFullAXTree')) as { nodes: AxNode[] };
  const node = nodes.find((n) => !n.ignored && n.role?.value === role && n.name?.value === name);
  if (!node?.backendDOMNodeId) return undefined;
  const { object } = await devtools(world, key, 'DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, executionContextId: context });
  return { key, objectId: object.objectId as string };
}

async function withControl(world: ThreadbearWorld, role: string, name: string, body: string, args: unknown[] = []): Promise<void> {
  let found: Awaited<ReturnType<typeof control>>;
  for (let i = 0; i < 50 && !found; i += 1) {
    found = await control(world, role, name);
    if (!found) await sleep(100);
  }
  assert.ok(found, `the annotation tools have no ${role} called "${name}"`);
  await devtools(world, found.key, 'Runtime.callFunctionOn', { objectId: found.objectId, functionDeclaration: body, arguments: args.map((value) => ({ value })) });
}

When('I press Annotate over the page in the pane', { timeout: 120_000 }, async function (this: AnnotateWorld) {
  // Its page is in and has finished loading, or Annotate asks to wait.
  await this.until('a page on show with Annotate over it', (d) => annotate(d)?.button === 'Annotate' && webPages(d).some((p) => p.key === annotate(d)?.key && !p.hidden && !p.loading), 90_000);
  this.rowsBefore = (await this.app.dump()).transcript.rows.length;
  await this.app.do({ cmd: 'click', tipPrefix: 'Select elements or draw on this page' });
  await this.until('the annotation tools to open', (d) => annotate(d)?.status === 'Select, mark or draw here, then choose Attach.', 30_000);
});

When("I select the page's {string} with the annotation tools", async function (this: ThreadbearWorld, selector: string) {
  // A press on the element, as the pointer gives one: the tools listen on
  // the window and pick what's under the point.
  const pressed = await tools(
    this,
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); const at = { bubbles: true, cancelable: true, composed: true, clientX: r.x + Math.min(r.width / 2, 20), clientY: r.y + r.height / 2, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      e.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 })); e.dispatchEvent(new PointerEvent('pointerup', at)); return true; })()`,
  );
  assert.equal(pressed, true, `nothing in the page matches ${selector}`);
});

When('I attach the annotation with the comment {string}', async function (this: ThreadbearWorld, comment: string) {
  await withControl(this, 'textbox', 'Describe the change', 'function (text) { this.value = text; }', [comment]);
  await withControl(this, 'button', 'Attach', 'function () { this.click(); }');
});

When('I press Cancel annotation over the page in the pane', async function (this: ThreadbearWorld) {
  await this.until('Cancel annotation over the page', (d) => annotate(d)?.button === 'Cancel annotation');
  await this.app.do({ cmd: 'click', tipPrefix: 'Close the annotation tools' });
});

Then("the pane's annotation line says {string}", { timeout: 60_000 }, async function (this: ThreadbearWorld, words: string) {
  await this.until(`the line under the page to say "${words}"`, (d) => annotate(d)?.status === words, 45_000);
});

Then('the composer keeps {string} and gains the comment {string}', async function (this: ThreadbearWorld, before: string, comment: string) {
  const start = `${before}\n\nBrowser annotation\n\n${comment}\n\nPage context (captured from the page):\n\`\`\`json\n`;
  await this.until(`the composer to start ${JSON.stringify(start)}`, (d) => d.composer.text.startsWith(start));
});

Then('the composer names the page {string} and its {string}', async function (this: ThreadbearWorld, relative: string, tag: string) {
  const text = (await this.app.dump()).composer.text;
  assert.match(text, new RegExp(`"url": "file://[^"]*/${relative.replaceAll('.', '\\.')}"`), text);
  assert.ok(text.includes(`"tagName": "${tag}"`), text);
});

Then('the composer has {int} picture(s)', async function (this: ThreadbearWorld, count: number) {
  await this.until(`${count} picture(s) in the composer`, (d) => (d.composer.images ?? 0) === count);
});

Then('the annotation sent no message', async function (this: AnnotateWorld) {
  await sleep(500);
  const d = await this.app.dump();
  assert.equal(d.transcript.rows.length, this.rowsBefore, 'the transcript grew');
  assert.ok(d.composer.text.includes('Browser annotation'), 'the draft is still in the composer');
});

Then('nothing was opened outside the app', async function (this: ThreadbearWorld) {
  await sleep(300);
  assert.deepEqual(JSON.parse(okValue(await this.app.do({ cmd: 'opened' }))), []);
});

Then('the annotation tools are closed', async function (this: ThreadbearWorld) {
  const d = await this.until('Annotate over the page again', (x) => annotate(x)?.button === 'Annotate' && annotate(x)?.active === false && x);
  assert.equal(annotate(d)?.status, '');
  const key = annotate(d)?.key;
  assert.ok(key);
  const { nodes } = (await devtools(this, key, 'Accessibility.getFullAXTree')) as { nodes: AxNode[] };
  assert.ok(!nodes.some((n) => !n.ignored && n.role?.value === 'button' && n.name?.value === 'Attach'), 'the tools are still in the page');
});

Then("the pane's page loses its Annotate button", async function (this: ThreadbearWorld) {
  await this.until('the page with no Annotate button', (d) => annotate(d) === undefined && webPages(d).some((p) => !p.hidden));
});

Then('the page in the pane has no annotation tools', async function (this: ThreadbearWorld) {
  const key = webPages(await this.app.dump()).find((p) => !p.hidden)?.key;
  assert.ok(key, 'no page is in the pane');
  for (let i = 0; i < 30; i += 1) {
    const { nodes } = (await devtools(this, key, 'Accessibility.getFullAXTree')) as { nodes: AxNode[] };
    if (!nodes.some((n) => !n.ignored && n.role?.value === 'button' && n.name?.value === 'Attach')) return;
    await sleep(100);
  }
  assert.fail('the tools are still in the page');
});

Then("the pane's page has an Annotate button and an empty annotation line", async function (this: ThreadbearWorld) {
  const d = await this.until('Annotate over the page again', (x) => annotate(x)?.button === 'Annotate' && annotate(x)?.active === false && x);
  assert.equal(annotate(d)?.status, '');
});

Then('the annotation tools are still open', async function (this: ThreadbearWorld) {
  // Longer than three of the session's looks at the experiment.
  await sleep(700);
  const now = await state(this);
  assert.equal(now.active, true, 'the annotation ended');
  assert.equal(now.status, 'Select, mark or draw here, then choose Attach.');
});

// The mock keeps each media.import unanswered until it's told to keep them.
When("the runner holds the pictures it's given", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'holdMedia', params: { hold: true } });
});

Then("the runner is holding the annotation's screenshot", { timeout: 60_000 }, async function (this: ThreadbearWorld) {
  for (let i = 0; i < 450; i += 1) {
    const held = JSON.parse(okValue(await this.app.do({ cmd: 'mock', method: 'holdMedia', params: {} }))) as { waiting?: number };
    if ((held.waiting ?? 0) > 0) return;
    await sleep(100);
  }
  assert.fail('no screenshot reached the runner');
});

When('the runner keeps the pictures it held', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'holdMedia', params: { hold: false } });
});

Then('the composer still says only {string}', async function (this: ThreadbearWorld, text: string) {
  await sleep(1500);
  const d = await this.app.dump();
  assert.equal(d.composer.text, text);
  assert.equal(d.composer.images ?? 0, 0);
});

Then('no annotation is under way', async function (this: ThreadbearWorld) {
  for (let i = 0; i < 50; i += 1) {
    if (!(await state(this)).active) return;
    await sleep(100);
  }
  assert.fail('the annotation is still under way');
});

Then('the composer says only {string}', async function (this: ThreadbearWorld, text: string) {
  const d = await this.until(`the composer to say ${JSON.stringify(text)}`, (x) => x.composer.text === text && x);
  assert.equal(d.composer.images ?? 0, 0);
});

Given("BrowserBear has the panel's site open as {string} for {string}", async function (this: AnnotateWorld, title: string, threadTitle: string) {
  assert.ok(this.bear, 'the scenario has no stand-in BrowserBear (tag it @browserbear)');
  const thread = await this.until(`a thread called "${threadTitle}"`, (d) => this.thread(d, threadTitle));
  this.pages ??= new Map();
  const tabId = 1000 + this.pages.size;
  this.pages.set(title, tabId);
  this.bear.open({ tabId, url: sites().home, title, thread: thread.id, state: 'working', action: 'reading the page', openedAt: Date.now() });
});

Then('the Browser pane says {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`the Browser pane to say "${words}"`, (d) => (d as { panels?: { browser?: { empty?: string } } }).panels?.browser?.empty === words);
});

When("I open the panel's site from the Browser pane's address field", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'annotate', do: 'open', address: sites().home });
});

Then("the pane shows the panel's site with an Annotate button", { timeout: 120_000 }, async function (this: ThreadbearWorld) {
  const home = sites().home;
  await this.until(
    'the site on show in the pane with Annotate over it',
    (d) => annotate(d)?.button === 'Annotate' && annotate(d)?.key?.startsWith(`view:${home}`) && webPages(d).some((p) => p.key === annotate(d)?.key && !p.hidden && !p.loading && p.title === 'Panel home'),
    90_000,
  );
});

Then("the pane's page has no Annotate button", async function (this: ThreadbearWorld) {
  await sleep(300);
  assert.equal(annotate(await this.app.dump()), undefined);
});
