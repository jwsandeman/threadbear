// runner.json's defaults.permissionMode: the mode a thread that names none
// starts on (the phone, the website, tb new, schedules without one), and
// what hello tells the app's composer to start on. Unset is Full access, so
// an install from before it changes nothing; setup writes "auto" into a new
// install's runner.json (scripts/setup.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeHarness, testConfig, tmpDir } from '../helpers/fakes.ts';
import { loadConfig, writeRunnerJson } from '../../src/config.ts';

test('config: defaults.permissionMode is read from runner.json; unset, plan or nonsense is no default', () => {
  const home = tmpDir();
  assert.equal(loadConfig({ THREADBEAR_HOME: home }).defaults.permissionMode, undefined);
  for (const mode of ['full', 'ask', 'auto'] as const) {
    writeRunnerJson(home, { defaults: { permissionMode: mode } });
    assert.equal(loadConfig({ THREADBEAR_HOME: home }).defaults.permissionMode, mode);
  }
  // Plan first waits for Mike to approve a plan, so a thread nobody's
  // watching (a schedule, one from the phone) would just sit there.
  for (const bad of ['plan', 'yolo', 3]) {
    writeRunnerJson(home, { defaults: { permissionMode: bad as never } });
    assert.equal(loadConfig({ THREADBEAR_HOME: home }).defaults.permissionMode, undefined, String(bad));
  }
});

test('a thread that names no mode starts on the default; a named one wins', () => {
  const h = makeHarness(undefined, { defaults: { cwd: '', permissionMode: 'auto' } });
  h.cfg.defaults.cwd = path.join(h.home, 'work');
  assert.equal(h.runner.create({ text: 'hi' }).thread.permissionMode, 'auto');
  assert.equal(h.runner.create({ text: 'hi', origin: 'schedule', scheduleId: 'sc1' }).thread.permissionMode, 'auto', 'a schedule with no mode too');
  assert.equal(h.runner.create({ text: 'hi', permissionMode: 'full' }).thread.permissionMode, 'full');
  assert.equal(h.runner.create({ text: 'hi', permissionMode: 'ask' }).thread.permissionMode, 'ask');
  assert.equal(h.runner.hello().defaults.permissionMode, 'auto');
});

test('with no default, a thread that names no mode gets Full access, and hello says nothing', () => {
  const h = makeHarness();
  assert.equal(h.runner.create({ text: 'hi' }).thread.permissionMode, 'full');
  assert.equal(h.runner.hello().defaults.permissionMode, undefined);
  assert.ok(!('permissionMode' in h.runner.hello().defaults));
});

test("the runner's own threads keep Full access whatever the default", () => {
  const home = tmpDir();
  const h = makeHarness(home, { ...testConfig(home), defaults: { cwd: path.join(home, 'work'), permissionMode: 'ask' } });
  const notice = h.runner.noticeOnMac(undefined, 'A dialog', 'A dialog is waiting');
  assert.equal(h.runner.get(notice).permissionMode, 'full');
});
