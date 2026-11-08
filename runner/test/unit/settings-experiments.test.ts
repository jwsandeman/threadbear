// Settings > Experiments (docs/protocol.md, "Settings and models"): the
// runner lists every experiment with its switch, and settings.update flips
// one in runner.json, so nobody has to edit the file by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXPERIMENTS } from '../../src/experiments.ts';
import { SettingsService, settingsMethods } from '../../src/settings.ts';
import type { Notification } from '../../src/runner.ts';
import { ensureHome } from '../../src/config.ts';
import { testConfig, tmpDir } from '../helpers/fakes.ts';

function setup() {
  const home = tmpDir();
  ensureHome(home);
  const cfg = testConfig(home);
  const published: Notification[] = [];
  const svc = new SettingsService({ config: cfg, publish: (n) => published.push(n) });
  return { home, svc, published, methods: settingsMethods(svc) };
}

const runnerJson = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8')) as { experiments?: Record<string, boolean> };

test('settings: get lists every experiment, off unless runner.json or its file says on', () => {
  const s = setup();
  const listed = s.svc.get().experiments;
  assert.deepEqual(listed.map((x) => x.id).sort(), EXPERIMENTS.map((x) => x.id).sort());
  for (const x of listed) {
    const file = EXPERIMENTS.find((e) => e.id === x.id)!;
    assert.equal(x.name, file.name);
    assert.equal(x.title, file.title);
    assert.equal(x.added, file.added);
    assert.equal(x.standard, file.on, `${x.id}: standard is the file's default`);
    assert.equal(x.on, file.on, `${x.id}: nothing in runner.json, so the default`);
  }
  fs.writeFileSync(path.join(s.home, 'runner.json'), JSON.stringify({ experiments: { labReview: true } }));
  assert.equal(s.svc.get().experiments.find((x) => x.id === 'labReview')!.on, true);
});

test('settings: update flips an experiment in runner.json, null puts it back to the default, and an unknown id changes nothing', () => {
  const s = setup();
  const result = s.methods['settings.update']({ experiments: { labReview: true, keepAwake: true } }) as { settings: { experiments: { id: string; on: boolean }[] } };
  const on = (id: string) => result.settings.experiments.find((x) => x.id === id)!.on;
  assert.equal(on('labReview'), true);
  assert.equal(on('keepAwake'), true);
  assert.deepEqual(runnerJson(s.home).experiments, { labReview: true, keepAwake: true });
  assert.equal(s.published.at(-1)?.method, 'settings.updated');

  s.methods['settings.update']({ experiments: { labReview: null } });
  assert.deepEqual(runnerJson(s.home).experiments, { keepAwake: true }, 'null removes the key');
  s.methods['settings.update']({ experiments: { keepAwake: false } });
  assert.deepEqual(runnerJson(s.home).experiments, { keepAwake: false });

  assert.throws(() => s.methods['settings.update']({ experiments: { notOne: true } }), /No experiment called notOne/);
  assert.throws(() => s.methods['settings.update']({ experiments: { labReview: 'yes' } }), /experiments\.labReview must be true, false or null/);
  assert.throws(() => s.methods['settings.update']({ experiments: ['labReview'] }), /experiments must be an object/);
  assert.deepEqual(runnerJson(s.home).experiments, { keepAwake: false }, 'a bad update saved nothing');
});
