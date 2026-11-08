import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OmpFrameDecoder, OmpProcess } from '../../src/adapters/omp/process.ts';
import { OmpNormalizer } from '../../src/adapters/omp/normalize.ts';
import { OmpAdapter } from '../../src/adapters/omp/adapter.ts';
import { nullLogger } from '../../src/log.ts';
import type { AdapterOutput, SessionSink, StartSessionOptions } from '../../src/adapters/types.ts';
import { fileContext } from '../../src/adapters/context.ts';
import { LIMITS } from '../../src/protocol.ts';
import { remoteCardShowsAll } from '../../src/tools.ts';

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-omp-test-'));
}
function chunks(value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  const split = Math.floor(data.length / 2);
  return [data.subarray(0, split), data.subarray(split)].map((b, index) => ({
    type: 'rpc_chunk',
    chunkId: 'one',
    index,
    count: 2,
    byteLength: data.length,
    data: b.toString('base64'),
  }));
}
test('OMP framing reassembles strict ordered chunks and rejects interruption and overflow', () => {
  const d = new OmpFrameDecoder();
  const parts = chunks({ type: 'message_end', text: 'large 🌱 response' });
  assert.equal(d.accept(parts[0]), undefined);
  assert.deepEqual(d.accept(parts[1]), {
    type: 'message_end',
    text: 'large 🌱 response',
  });
  assert.equal(d.accept(parts[0]), undefined);
  assert.throws(() => d.accept({ type: 'agent_end' }), /chunk/i);
  assert.throws(() => new OmpFrameDecoder().accept({ ...parts[0], byteLength: 100_000_000 }), /limit/i);
  assert.throws(() => new OmpFrameDecoder().accept(parts[1]), /chunk/i);
});

test('OMP normalizer keeps streamed blocks, authoritative final content, tool errors and image output', () => {
  const dir = temp();
  try {
    const out: AdapterOutput[] = [];
    const n = new OmpNormalizer(fileContext(dir, dir, dir), (o) => out.push(o));
    n.accept({
      type: 'message_update',
      messageId: 'm',
      message: { role: 'assistant' },
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'draft',
      },
    });
    n.accept({
      type: 'message_end',
      messageId: 'm',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'final' },
          { type: 'thinking', thinking: 'thought' },
        ],
      },
    });
    n.accept({
      type: 'tool_execution_start',
      toolCallId: 't',
      toolName: 'bash',
      args: { command: 'false' },
    });
    n.accept({
      type: 'tool_execution_end',
      toolCallId: 't',
      isError: true,
      result: { content: [{ type: 'text', text: 'failure' }] },
    });
    assert.ok(out.some((o) => o.kind === 'delta' && o.delta.text === 'draft'));
    assert.ok(out.some((o) => o.kind === 'event' && o.event.type === 'assistant.text' && o.event.text === 'final'));
    assert.ok(out.some((o) => o.kind === 'event' && o.event.type === 'reasoning' && o.event.text === 'thought'));
    assert.ok(out.some((o) => o.kind === 'event' && o.event.type === 'tool.result' && !o.event.ok && o.event.text === 'failure'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const registry = {
  add() {},
  remove() {},
  toolGroups() {
    return [];
  },
};
const fixture = `#!/usr/bin/env node
const fs = require('fs'); const rl = require('readline').createInterface({input: process.stdin});
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name)+1] : undefined;
const dir = arg('--session-dir'); const sessionFile = arg('--resume') || (dir ? dir+'/new-'+process.pid+'.jsonl' : undefined);
if (dir) { fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(sessionFile, '{}\\n'); }
const write = x => process.stdout.write(JSON.stringify(x)+'\\n');
let currentModel={provider:'test',id:'small'};
let approvalPrompt;
write({type:'ready',supportedProtocolVersions:[1,2]});
if(process.env.THREADBEAR_OMP_POLICY) { const policy=JSON.parse(fs.readFileSync(process.env.THREADBEAR_OMP_POLICY,'utf8')); write({type:'extension_ui_request',method:'notify',message:'threadbear-guard-ready:'+policy.nonce}); }
rl.on('line',line=> { const c=JSON.parse(line); let data={};
if(c.type==='get_state') data={sessionFile,sessionId:'native-id',model:currentModel,isSettled:true};
if(c.type==='set_model') {currentModel={provider:c.provider,id:c.modelId};data=currentModel;write({type:'model_changed',model:currentModel});}
if(c.type==='get_available_models') data={models:[{provider:'test',id:'small',name:'Small',reasoning:false}]};
if(c.type==='prompt' && c.message.startsWith('approval:')) {
  approvalPrompt=c;
  const request=JSON.parse(c.message.slice('approval:'.length));
  if(request.title==='Threadbear tool approval') {
    const policy=JSON.parse(fs.readFileSync(process.env.THREADBEAR_OMP_POLICY,'utf8'));
    request.message=JSON.stringify({...request.message,nonce:policy.nonce});
  }
  write({type:'response',id:c.id,command:c.type,success:true,data:{agentInvoked:true}});
  write({type:'agent_start'});
  write({type:'extension_ui_request',id:'approval',...request});
  return;
}
if(c.type==='extension_ui_response' && approvalPrompt) {
  write({type:'message_end',messageId:approvalPrompt.id,message:{role:'assistant',content:[{type:'text',text:JSON.stringify(c)}]}});
  write({type:'prompt_result',id:approvalPrompt.id,status:'completed',sessionSettled:true});
  approvalPrompt=undefined;
  return;
}
if(c.type==='prompt') {write({type:'response',id:c.id,command:c.type,success:true,data:{agentInvoked:true}}); write({type:'agent_start'}); write({type:'message_end',messageId:'m',message:{role:'assistant',content:[{type:'text',text:c.message}]}}); write({type:'prompt_result',id:c.id,status:'completed',sessionSettled:false}); write({type:'session_settled'});return;}
if(c.type==='extension_ui_response'||c.type==='host_tool_result') return;
write({type:'response',id:c.id,command:c.type,success:true,data});
});
`;

test('OMP adapter discovers qualified models, sends and resumes only its exact session', async () => {
  const dir = temp();
  const bin = path.join(dir, 'fake-omp');
  fs.writeFileSync(bin, fixture, { mode: 0o700 });
  const outputs: AdapterOutput[] = [];
  const exits: (Error | undefined)[] = [];
  const sink: SessionSink = {
    output: (o) => outputs.push(o),
    exited: (e) => exits.push(e),
    requestApproval: async () => ({ decision: 'deny' }),
    requestQuestion: async () => ({ answers: null }),
  };
  const adapter = new OmpAdapter({
    ompBinary: () => bin,
    registry,
    log: nullLogger,
  });
  const account = {
    id: 'omp-main',
    provider: 'omp' as const,
    title: 'Oh My Pi',
    configDir: path.join(dir, 'auth'),
  };
  const opts: StartSessionOptions = {
    threadId: 'thread',
    cwd: dir,
    account,
    sessionId: 'allocated',
    resume: false,
    permissionMode: 'ask',
    mediaDir: path.join(dir, 'thread/media'),
    blobsDir: path.join(dir, 'thread/blobs'),
    tmpDir: path.join(dir, 'thread/tmp'),
  };
  try {
    const models = await adapter.models(account);
    assert.equal(models[0].id, 'test/small');
    let session = adapter.start(opts, sink);
    session.send({ id: 'turn1', text: 'first', images: [] });
    await until(() => outputs.some((o) => o.kind === 'result'));
    const tasks = outputs.filter((o) => o.kind === 'tasks');
    assert.deepEqual(tasks.at(-1), { kind: 'tasks', tasks: [] });
    const identity = outputs.find((o) => o.kind === 'session');
    assert.ok(identity?.kind === 'session');
    assert.ok(path.isAbsolute(identity.nativeSessionId));
    await session.end();
    outputs.length = 0;
    session = adapter.start({ ...opts, resume: true, sessionId: identity.nativeSessionId }, sink);
    session.send({ id: 'turn2', text: 'second', images: [] });
    await until(() => outputs.some((o) => o.kind === 'result'));
    assert.ok(outputs.some((o) => o.kind === 'session' && o.nativeSessionId === identity.nativeSessionId));
    await assert.rejects(session.setPermissionMode('plan'), /Plan first/);
    await session.setModel('test/other');
    await session.setModel(undefined);
    const lastModel = outputs.filter((o) => o.kind === 'session').at(-1);
    assert.equal(lastModel?.kind === 'session' ? lastModel.model : undefined, 'test/small');
    await session.setPermissionMode('full');
    const policy = fs.readdirSync(opts.tmpDir).find((name) => name.startsWith('omp-policy-'))!;
    fs.rmSync(path.join(opts.tmpDir, policy));
    fs.mkdirSync(path.join(opts.tmpDir, policy));
    const exitsBefore = exits.length;
    await assert.rejects(session.setPermissionMode('ask'));
    await until(() => exits.length > exitsBefore);
    assert.ok(exits.at(-1), 'A failed downgrade must terminate the process, not continue in Full access');
    await session.end();
    assert.equal(exits.filter(Boolean).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OMP refuses confined threads before starting a process or writing session files', () => {
  const dir = temp();
  try {
    const adapter = new OmpAdapter({
      ompBinary: () => {
        throw new Error('Must not launch');
      },
      registry,
      log: nullLogger,
    });
    const opts: StartSessionOptions = {
      threadId: 'thread',
      cwd: dir,
      account: { id: 'omp-main', provider: 'omp', title: 'Oh My Pi', configDir: path.join(dir, 'auth') },
      sessionId: 'allocated',
      resume: false,
      permissionMode: 'full',
      confined: true,
      mediaDir: path.join(dir, 'media'),
      blobsDir: path.join(dir, 'blobs'),
      tmpDir: path.join(dir, 'tmp'),
    };
    const sink: SessionSink = {
      output() {},
      exited() {},
      requestApproval: async () => ({ decision: 'allow' }),
      requestQuestion: async () => ({ answers: null }),
    };
    assert.throws(() => adapter.start(opts, sink), /sandbox.*Oh My Pi/i);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OMP approvals contain the whole action or refuse it without exposing Allow', async () => {
  const dir = temp();
  const bin = path.join(dir, 'fake-omp');
  fs.writeFileSync(bin, fixture, { mode: 0o700 });
  const outputs: AdapterOutput[] = [];
  const cards: Parameters<SessionSink['requestApproval']>[0][] = [];
  const sink: SessionSink = {
    output: (o) => outputs.push(o),
    exited() {},
    requestApproval: async (card) => {
      cards.push(card);
      return { decision: 'allow' };
    },
    requestQuestion: async () => ({ answers: null }),
  };
  const adapter = new OmpAdapter({ ompBinary: () => bin, registry, log: nullLogger });
  const session = adapter.start(
    {
      threadId: 'thread',
      cwd: dir,
      account: { id: 'omp-main', provider: 'omp', title: 'Oh My Pi', configDir: path.join(dir, 'auth') },
      sessionId: 'allocated',
      resume: false,
      permissionMode: 'ask',
      mediaDir: path.join(dir, 'thread/media'),
      blobsDir: path.join(dir, 'thread/blobs'),
      tmpDir: path.join(dir, 'thread/tmp'),
    },
    sink,
  );
  const request = async (frame: Record<string, unknown>) => {
    outputs.length = 0;
    cards.length = 0;
    session.send({ id: 'turn', text: 'approval:' + JSON.stringify(frame), images: [] });
    await until(() => outputs.some((o) => o.kind === 'result'));
    const response = outputs.find((o) => o.kind === 'event' && o.event.type === 'assistant.text');
    assert.ok(response?.kind === 'event' && response.event.type === 'assistant.text');
    return JSON.parse(response.event.text);
  };
  const guard = (name: string, input: Record<string, unknown>) => ({ method: 'confirm', title: 'Threadbear tool approval', message: { name, input, toolCallId: 'tool' } });
  const long = 'x'.repeat(LIMITS.toolInputString + 1);
  try {
    for (const frame of [
      guard('bash', { command: long }),
      guard('python', { code: 'print(1)', options: { prelude: long } }),
      { method: 'select', title: long, options: ['Approve Once', 'Deny'] },
      { method: 'select', title: 'Run command', options: ['Approve Once', 'Deny'], optionDetails: [{ description: long }, {}] },
      { method: 'confirm', title: 'Allow action', message: long },
      { method: 'confirm', title: long, message: 'Allow action' },
    ]) {
      const answer = await request(frame);
      assert.equal(cards.length, 0, 'An incomplete approval must never offer Allow');
      assert.ok(answer.confirmed === false || answer.value === 'Deny');
      assert.ok(outputs.some((o) => o.kind === 'event' && o.event.type === 'system.note' && o.event.text.includes('longer than an approval card')));
    }
    const input = { code: 'print(1)', cwd: '/other' };
    assert.equal((await request(guard('python', input))).confirmed, true);
    assert.equal(cards[0].name, 'omp__python');
    assert.deepEqual(cards[0].input, input);
    assert.equal(remoteCardShowsAll(cards[0].name, cards[0].input, dir, cards[0].title), false);
    assert.equal((await request({ method: 'confirm', title: 'Remove file', message: 'file.txt' })).confirmed, true);
    assert.deepEqual(cards[0].input, { title: 'Remove file', message: 'file.txt' });
    assert.equal(remoteCardShowsAll(cards[0].name, cards[0].input, dir, cards[0].title), false);
    assert.equal((await request({ method: 'select', title: 'Run command\necho hi', options: ['Approve Once', 'Deny'] })).value, 'Approve Once');
    assert.deepEqual(cards[0].input, { details: 'Run command\necho hi' });
    assert.equal(remoteCardShowsAll(cards[0].name, cards[0].input, dir, cards[0].title), false);
    const optionDetails = [{ description: 'Runs in /elsewhere' }, {}];
    await request({ method: 'select', title: 'Run command', options: ['Approve Once', 'Deny'], optionDetails });
    assert.deepEqual(cards[0].input, { details: 'Run command', options: ['Approve Once', 'Deny'], optionDetails });
    assert.equal(remoteCardShowsAll(cards[0].name, cards[0].input, dir, cards[0].title), false);
  } finally {
    await session.end({ hard: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OMP remote approvals require every argument to fit the visible line', () => {
  assert.equal(remoteCardShowsAll('omp__bash', { command: 'ls' }), true);
  assert.equal(remoteCardShowsAll('omp__bash', { command: 'ls', cwd: '/elsewhere' }), false);
  assert.equal(remoteCardShowsAll('omp__bash', { command: 'ls', network: true }), false);
  assert.equal(remoteCardShowsAll('omp__python', { code: 'print(1)' }), true);
  assert.equal(remoteCardShowsAll('omp__python', { code: 'print(1)\nremove_file()' }), false);
  assert.equal(remoteCardShowsAll('omp__python', { code: 'x'.repeat(161) }), false);
  assert.equal(remoteCardShowsAll('omp__remote_run', { command: 'ls', id: 'production' }), false);
  assert.equal(remoteCardShowsAll('omp__write', { path: 'a', content: 'new' }), false);
  assert.equal(remoteCardShowsAll('omp__approval', { title: 'Remove file', message: 'a' }), false);
  assert.equal(remoteCardShowsAll('omp__custom', { options: { enabled: true } }), false);
});
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('OMP guard asks before mutation, blocks headless children and policy failures, and applies downgrades', async () => {
  const dir = temp();
  const policyFile = path.join(dir, 'policy.json');
  const old = process.env.THREADBEAR_OMP_POLICY;
  process.env.THREADBEAR_OMP_POLICY = policyFile;
  const policy = (mode: string) => fs.writeFileSync(policyFile, JSON.stringify({ mode, nonce: 'test', hostTools: ['mcp__threadbear__pin'] }));
  try {
    policy('ask');
    const modulePath = '../../src/adapters/omp/guard.mjs';
    const { default: guard } = await import(modulePath);
    const handlers: Record<string, (...args: any[]) => any> = {};
    const selected: string[][] = [];
    guard({
      getActiveTools: () => ['read'],
      setActiveTools: async (names: string[]) => {
        selected.push(names);
      },
      on: (name: string, handler: (...args: any[]) => any) => {
        handlers[name] = handler;
      },
    });
    await handlers.before_agent_start();
    assert.deepEqual(selected, [['read', 'mcp__threadbear__pin']]);
    const requests: unknown[] = [];
    const context = {
      hasUI: true,
      agent: { kind: 'main' },
      ui: {
        confirm: async (_title: string, request: string) => {
          requests.push(JSON.parse(request));
          return false;
        },
      },
    };
    const write = { toolName: 'write', toolCallId: 'w', input: { path: 'file.txt', content: 'changed' } };
    assert.equal((await handlers.tool_call(write, context)).block, true);
    assert.deepEqual(requests, [{ nonce: 'test', toolCallId: 'w', name: 'write', input: write.input }]);
    assert.equal(await handlers.tool_call({ toolName: 'read', input: { path: 'file.txt' } }, context), undefined);
    assert.equal((await handlers.tool_call(write, { ...context, agent: { kind: 'sub' } })).block, true);
    policy('full');
    assert.equal(await handlers.tool_call(write, context), undefined);
    policy('ask');
    assert.equal((await handlers.tool_call(write, context)).block, true);
    fs.writeFileSync(policyFile, 'broken');
    assert.equal((await handlers.tool_call(write, context)).block, true);
    fs.rmSync(policyFile);
    assert.equal((await handlers.tool_call(write, context)).block, true);
  } finally {
    if (old === undefined) delete process.env.THREADBEAR_OMP_POLICY;
    else process.env.THREADBEAR_OMP_POLICY = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OMP transport refuses truncated output even after an otherwise clean process exit', async () => {
  const dir = temp();
  let error: Error | undefined;
  const proc = new OmpProcess({
    binary: process.execPath,
    args: ['-e', `process.stdout.write('{"type":"ready"');`],
    cwd: dir,
    env: process.env,
    registry,
    log: nullLogger,
    onFrame() {},
    onExit: (e) => {
      error = e;
    },
  });
  try {
    await assert.rejects(proc.ready);
    await proc.closed;
    assert.match(error?.message ?? '', /Incomplete OMP frame/);
  } finally {
    await proc.end(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
