#!/usr/bin/env node
// Real Chromium input against the bundled overlay, with an isolated temporary profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../Sources/Threadbear/Resources/Annotations/annotation.js', import.meta.url));
const source = await fs.readFile(sourcePath, 'utf8');
const chromePath = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await fs.access(chromePath);
const shots = process.env.ANNOTATION_SHOTS;
const serve = process.argv.includes('--serve');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'threadbear-annotation-test-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Annotation test page</title>
<style>body{margin:0;min-height:1800px;font:18px system-ui;background:#fff;color:#171717}
main{padding:100px 90px}h1{font-size:46px;max-width:700px;margin:20px 0 30px}
button{font:inherit;padding:16px 24px;border-radius:12px;border:0;background:#151515;color:white;cursor:pointer}
#secondary{margin-left:24px;background:#eee;color:#171717}p{max-width:650px;line-height:1.5;color:#555}
dialog{padding:40px;border:0;border-radius:12px}dialog::backdrop{background:#0006}</style></head>
<body><main><h1>Make this page easier to use</h1><p>Select an element, mark a region or draw where a change belongs. Your notes return to the same thread.</p>
<button id="target">Request a call</button><button id="secondary">Read more</button>
<dialog id="modal"><p>A native modal dialog</p><button id="modalTarget">Save changes</button></dialog></main>
<script>window.clicks=0;target.addEventListener('click',()=>window.clicks++);</script></body></html>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${temp}`, '--window-size=1100,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', data => { chromeLog = (chromeLog + data).slice(-8000); });
let ws;
let contextId;
let seq = 0;
const pending = new Map();
async function cdp(method, params = {}) {
  const id = ++seq;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, isolated = false) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(isolated ? { contextId } : {}) });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const read = () => evaluate('window.__threadbearAnnotation.read()', true);
const finish = () => evaluate('window.__threadbearAnnotation.finish()', true);
async function start(sessionId = 'annotation-test') {
  const result = await evaluate(`(${source})(${JSON.stringify(sessionId)})`, true);
  assert.equal(result.status, 'active');
  await delay(40);
}
async function point(selector) {
  return await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
async function click(x, y, modifiers = 0) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
}
async function clickTarget(selector, modifiers = 0) { const p = await point(selector); await click(p.x, p.y, modifiers); }
async function press(key) {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === 'Escape' ? 'Escape' : key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key });
}
async function accessiblePoint(role, name) {
  const { nodes } = await cdp('Accessibility.getFullAXTree');
  const node = nodes.find(n => !n.ignored && n.role?.value === role && n.name?.value === name);
  assert.ok(node?.backendDOMNodeId, `No accessible ${role}: ${name}`);
  const { model } = await cdp('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
  const quad = model.border;
  return { x: (quad[0]+quad[2]+quad[4]+quad[6])/4, y: (quad[1]+quad[3]+quad[5]+quad[7])/4 };
}
async function control(text) {
  const p = await accessiblePoint('button', text);
  await click(p.x, p.y);
}
async function comment(text) {
  const p = await accessiblePoint('textbox', 'Describe the change');
  await click(p.x, p.y);
  await cdp('Input.insertText', { text });
}
async function drag(from, to, count = 20) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= count; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x-from.x)*i/count, y: from.y+(to.y-from.y)*i/count, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
}
async function shot(name) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}
try {
  let port;
  for (let i = 0; i < 150; i++) {
    try { port = Number((await fs.readFile(path.join(temp, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); }
  }
  assert.ok(port, `Chrome did not start. ${chromeLog}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: origin });
  for (let i = 0; i < 100 && !await evaluate('typeof window.clicks === "number"'); i++) await delay(20);
  if (serve) {
    const browserBearHome = path.join(temp, 'browserbear');
    const socket = path.join(browserBearHome, 'browserbear.sock');
    await fs.mkdir(path.join(browserBearHome, 'agent'), { recursive: true });
    await fs.writeFile(path.join(browserBearHome, 'agent/tabs.json'), JSON.stringify({
      port, socket, browser: 'Chrome',
      tabs: [{ tabId: 1001, targetId: target.id, url: origin, title: 'Annotation test page', thread: 'demo_upload', openedAt: Date.now() }],
    }));
    console.log(JSON.stringify({ pid: process.pid, port, targetId: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl, browserBearHome, socket, url: origin }));
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
  const { frameTree } = await cdp('Page.getFrameTree');
  ({ executionContextId: contextId } = await cdp('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'threadbear-annotation-test' }));
  await shot('before');

  await start();
  assert.equal(await evaluate('document.querySelector("[data-threadbear-annotation-ui]").shadowRoot'), null, 'Overlay uses a closed shadow root');
  assert.equal(await evaluate('typeof window.__threadbearAnnotation'), 'undefined', 'Page scripts cannot read the native annotation API');
  await clickTarget('#target');
  assert.equal(await evaluate('window.clicks'), 0, 'Selecting must not click the underlying button');
  await clickTarget('#secondary', 8);
  await control('Draw');
  await drag({ x: 120, y: 460 }, { x: 320, y: 500 });
  await control('Erase');
  await click(200, 476);
  await control('Draw');
  await drag({ x: 120, y: 460 }, { x: 320, y: 500 });
  await control('Region');
  await drag({ x: 720, y: 250 }, { x: 920, y: 330 });
  await comment('Make the selected action clearer and increase the marked spacing.');
  await shot('annotating');
  await control('Attach');
  await delay(80);
  const ready = await read();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.sessionId, 'annotation-test');
  assert.equal(ready.annotation.comment, 'Make the selected action clearer and increase the marked spacing.');
  assert.equal(ready.annotation.url, origin + '/');
  assert.equal(ready.annotation.elements.length, 2, 'Shift selection keeps both elements');
  assert.equal(ready.annotation.strokes.length, 1, 'Erase removed the first stroke');
  assert.ok(ready.annotation.strokes[0].points.length > 1, 'Draw captures points');
  assert.equal(ready.annotation.regions.length, 1, 'Region captures blank space');
  assert.ok(ready.annotation.elements.some(e => e.selector.includes('target') && e.outerHTML.includes('Request a call')));
  assert.deepEqual(ready.annotation.viewport, { width: 1100, height: 800, scrollX: 0, scrollY: 0 });
  assert.equal((await cdp('Accessibility.getFullAXTree')).nodes.some(n => !n.ignored && n.role?.value === 'button' && n.name?.value === 'Attach'), false, 'Capture hides controls');
  await shot('capture');
  await finish();
  await clickTarget('#target');
  assert.equal(await evaluate('window.clicks'), 1, 'Finish restores normal clicking');
  console.log('PASS selection, multiple targets, drawing, erasing, region, comment capture and cleanup');

  await start('scroll-test');
  await clickTarget('#target');
  await evaluate('window.scrollTo(0,100)');
  await delay(60);
  const targetRect = await evaluate('(()=>{const r=target.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  await comment('Keep this element aligned after scrolling.');
  await press('Enter');
  await delay(40);
  const scrolled = await read();
  assert.equal(scrolled.status, 'ready');
  assert.equal(scrolled.annotation.viewport.scrollY, 100);
  assert.deepEqual(scrolled.annotation.elements[0].rect, targetRect);
  await finish();
  await evaluate('window.scrollTo(0,0)');
  console.log('PASS scrolling keeps selected element coordinates current; Enter attaches');

  await start('cancel-test');
  await clickTarget('#target');
  await press('Escape');
  assert.equal((await read()).status, 'cancelled');
  await clickTarget('#target');
  assert.equal(await evaluate('window.clicks'), 2, 'Escape restores normal clicking');
  await start('replacement-1');
  await start('replacement-2');
  assert.equal((await read()).sessionId, 'replacement-2');
  assert.equal(await evaluate('document.querySelectorAll("[data-threadbear-annotation-ui]").length'), 1, 'Replacement removes the earlier overlay');
  await finish();
  console.log('PASS Escape cancellation and replacement cleanup');

  await evaluate('modal.showModal()');
  await start('modal-test');
  await clickTarget('#modalTarget');
  await comment('Clarify this dialog action.');
  await control('Attach');
  await delay(50);
  const modalResult = await read();
  assert.equal(modalResult.status, 'ready');
  assert.ok(modalResult.annotation.elements.some(e => e.selector.includes('modalTarget')));
  assert.equal(modalResult.annotation.comment, 'Clarify this dialog action.');
  await finish();
  await evaluate('modal.close()');
  console.log('PASS annotation inside a native modal dialog');

  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="secretGroup" style="position:absolute;top:570px;left:90px;padding:10px;width:500px;height:100px;background:#eee"><input id="secretInput" type="password" value="fixture-password" aria-label="Test password"><textarea id="secretTextarea" aria-label="Test private field">fixture-private-text</textarea></div>')`);
  await start('redaction-test');
  await clickTarget('#secretInput');
  await clickTarget('#secretTextarea', 8);
  await control('Attach');
  const redacted = await read();
  assert.equal(redacted.status, 'ready');
  assert.equal(redacted.annotation.elements.length, 2);
  assert.ok(!JSON.stringify(redacted.annotation.elements).includes('fixture-password'), 'Password defaults are redacted');
  assert.ok(!JSON.stringify(redacted.annotation.elements).includes('fixture-private-text'), 'Textarea defaults are redacted');
  assert.equal(await evaluate('secretInput.value'), 'fixture-password', 'Redaction does not alter the page');
  assert.equal(await evaluate('secretTextarea.value'), 'fixture-private-text');
  await finish();
  console.log('PASS form values are redacted without changing page fields');
  await start('parent-redaction-test');
  await clickTarget('#secretGroup');
  await control('Attach');
  const parentRedacted = await read();
  assert.equal(parentRedacted.status, 'ready');
  assert.ok(parentRedacted.annotation.elements[0].selector.includes('secretGroup'));
  assert.ok(!JSON.stringify(parentRedacted.annotation.elements).includes('fixture-password'));
  assert.ok(!JSON.stringify(parentRedacted.annotation.elements).includes('fixture-private-text'), 'Selecting a container also redacts private field content');
  await finish();
  console.log('PASS selected parent containers also redact descendant form values');
  await evaluate(`(()=>{const h=document.createElement('div');h.id='shadowHost';h.style.cssText='position:absolute;left:650px;top:430px';h.attachShadow({mode:'open'}).innerHTML='<button id="shadowButton" style="padding:18px">Shadow action</button>';document.body.appendChild(h)})()`);
  await start('shadow-test');
  const shadowPoint = await evaluate(`(()=>{const r=shadowHost.shadowRoot.querySelector('button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await click(shadowPoint.x, shadowPoint.y);
  await control('Attach');
  const shadowResult = await read();
  assert.equal(shadowResult.status, 'ready');
  assert.equal(shadowResult.annotation.elements[0].selector, '#shadowHost >>> #shadowButton');
  await finish();
  console.log('PASS open-shadow selection includes the host in its selector');
  }
} finally {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Test ended')); }
  pending.clear();
  ws?.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else { chrome.once('exit', resolve); setTimeout(resolve, 2000).unref(); } });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
