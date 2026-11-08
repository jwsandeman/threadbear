import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AccountRegistry, discoverAccounts } from '../../src/accounts.ts';
import { loadConfig } from '../../src/config.ts';
import { isProvider, type Account } from '../../src/protocol.ts';
import { defaultPools } from '../../src/pools.ts';
import { FakeAccounts, FakeAdapter, makeHarness, testConfig, tmpDir, tick } from '../helpers/fakes.ts';

const omp: Account = { id: 'omp-main', provider: 'omp', title: 'Oh My Pi', configDir: '/unused/omp', models: [{ id: 'openai/gpt-example', model: 'openai/gpt-example', title: 'GPT Example' }] };

test('OMP discovery is opt-in and never reads the credential database', () => {
  const home = tmpDir();
  const dir = path.join(home, 'omp');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'agent.db'), 'not a credential database');
  const cfg = testConfig(home, { ompMainDir: dir, ompPath: '/unused/omp' });
  assert.equal(discoverAccounts(cfg).some(a => a.provider === 'omp'), false);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { ohMyPi: true } }));
  assert.deepEqual(discoverAccounts(cfg).filter(a => a.provider === 'omp'), [{ id: 'omp-main', provider: 'omp', title: 'Oh My Pi', configDir: dir }]);
  const registry = new AccountRegistry(cfg);
  registry.learn('omp-main', { models: omp.models, defaultModel: 'openai/gpt-example' });
  assert.equal(registry.get('omp-main')?.defaultModel, 'openai/gpt-example');
});

test('OMP paths and model defaults come from runner configuration', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ ompPath: '~/bin/omp', ompMainDir: '~/custom-omp', defaults: { models: { omp: 'openai/gpt-example' } } }));
  const cfg = loadConfig({ THREADBEAR_HOME: home, THREADBEAR_CONNECTORS_URL: 'off', THREADBEAR_CLAUDE_MAIN_JSON: '/missing' });
  assert.ok(cfg.ompPath?.endsWith('/bin/omp'));
  assert.ok(cfg.ompMainDir?.endsWith('/custom-omp'));
  assert.equal(cfg.defaults.models?.omp, 'openai/gpt-example');
  assert.equal(isProvider('omp'), true);
  assert.equal(defaultPools([omp], {}, {}).find(p => p.id === 'omp')?.title, 'Oh My Pi');
});

test('OMP model ids remain namespaced and Plan first is rejected before creating or changing a thread', () => {
  const adapter = new FakeAdapter('omp');
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts([omp]), adapters: { omp: adapter } });
  try {
    assert.equal(h.runner.modelProvider('openai/gpt-example'), 'omp');
    assert.equal(h.runner.modelFits(omp, 'openai/gpt-example'), true);
    assert.equal(h.runner.modelFits(omp, 'gpt-example'), false);
    assert.throws(() => h.runner.create({ text: 'hi', accountId: omp.id, permissionMode: 'plan' }), /Plan first.*Oh My Pi/);
    const made = h.runner.create({ text: 'hi', accountId: omp.id, model: 'openai/gpt-example' });
    assert.equal(made.thread.model, 'openai/gpt-example');
    assert.throws(() => h.runner.update({ threadId: made.thread.id, permissionMode: 'plan', title: 'must not change' }), /Plan first.*Oh My Pi/);
    assert.equal(h.runner.get(made.thread.id).permissionMode, 'full');
    assert.equal(h.runner.get(made.thread.id).title, made.thread.title);
  } finally { void h.runner.shutdown(); }
});


test('OMP uses only reported effort levels and preserves known custom Claude models', () => {
  const claude: Account = { id: 'claude-main', provider: 'claude', title: 'Claude', configDir: '/unused/claude', models: [{ id: 'custom/claude', model: 'custom/claude', title: 'Custom Claude' }] };
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts([omp, claude]) });
  try {
    assert.equal(h.runner.modelProvider('custom/claude'), 'claude');
    assert.equal(h.runner.modelFits(claude, 'custom/claude'), true);
    assert.equal(h.runner.checkSettings(omp, 'openai/gpt-example', 'high').effort, undefined);
    const reasoning = { ...omp, models: [{ ...omp.models![0], effortLevels: ['low', 'high'] as const }] };
    assert.equal(h.runner.checkSettings({ ...reasoning, models: reasoning.models.map(m => ({ ...m, effortLevels: [...m.effortLevels] })) }, 'openai/gpt-example', 'high').effort, 'high');
  } finally { void h.runner.shutdown(); }
});

test('OMP persists the native session across a runner restart and stays on its selected model', async () => {
  const adapter = new FakeAdapter('omp');
  const deps = { accounts: new FakeAccounts([omp]), adapters: { omp: adapter } };
  const h = makeHarness(undefined, {}, deps);
  const { thread } = h.runner.create({ text: 'remember this', accountId: omp.id, model: 'openai/gpt-example', permissionMode: 'ask' });
  adapter.last.init('/sessions/this-thread.jsonl', 'openai/gpt-example');
  adapter.last.result();
  await tick();
  await h.runner.shutdown();
  const again = makeHarness(h.home, {}, deps);
  try {
    again.runner.send(thread.id, 'continue');
    await tick();
    assert.equal(adapter.last.opts.resume, true);
    assert.equal(adapter.last.opts.sessionId, '/sessions/this-thread.jsonl');
    assert.equal(adapter.last.opts.model, 'openai/gpt-example');
    assert.equal(adapter.last.opts.permissionMode, 'ask');
  } finally { await again.runner.shutdown(); }
});

test('moving a Plan first thread to OMP selects Ask before edits', async () => {
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts([{ id: 'claude-main', provider: 'claude', title: 'Claude', configDir: '/unused/claude' }, omp]), adapters: { claude: new FakeAdapter('claude'), omp: new FakeAdapter('omp') } });
  try {
    const { thread } = h.runner.create({ text: 'plan it', accountId: 'claude-main', permissionMode: 'plan' });
    const changed = h.runner.update({ threadId: thread.id, accountId: omp.id });
    assert.equal(changed.thread.provider, 'omp');
    assert.equal(changed.thread.permissionMode, 'ask');
  } finally { await h.runner.shutdown(); }
});

test('OMP reloads standing instructions into its rebuilt system prompt on resume', async () => {
  const adapter = new FakeAdapter('omp');
  let instructions = 'Use Australian spelling.';
  const deps = { accounts: new FakeAccounts([omp]), adapters: { omp: adapter }, standingInstructions: () => instructions };
  const h = makeHarness(undefined, {}, deps);
  const { thread } = h.runner.create({ text: 'remember this', accountId: omp.id });
  assert.match(adapter.last.opts.instructions ?? '', /Use Australian spelling/);
  adapter.last.init('/sessions/this-thread.jsonl', 'openai/gpt-example');
  adapter.last.result();
  await tick();
  await h.runner.shutdown();
  const again = makeHarness(h.home, {}, deps);
  try {
    again.runner.send(thread.id, 'continue');
    await tick();
    assert.equal(adapter.last.opts.resume, true);
    assert.match(adapter.last.opts.instructions ?? '', /Use Australian spelling/);
    adapter.last.result();
    await tick();
    instructions = 'Use short sentences.';
    again.runner.send(thread.id, 'carry on');
    await tick();
    assert.match(adapter.last.sent.at(-1)!.text, /standing instructions have changed/);
    assert.match(adapter.last.sent.at(-1)!.text, /Use short sentences/);
  } finally { await again.runner.shutdown(); }
});
