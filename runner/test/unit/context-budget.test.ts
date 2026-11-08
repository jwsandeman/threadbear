// The context budget: what every Threadbear thread's agent is handed
// before it reads a word from the user (the threadbear tools' names,
// descriptions and argument schemas, and the standing instructions), in
// bytes, checked against context-budget.json. Any change, up or down,
// fails until the file is updated, so growth shows up in the diff as a
// choice someone made rather than creeping in. After T3 Code's
// AgentContextBudget test (4 Nov 2026); Mike wants agents' tools and
// standing context kept lean.
//
// To accept a change: npm run context-budget (in runner/), then commit
// context-budget.json with the change that caused it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildThreadbearTools, guidePath, serverInstructions, type ThreadControl } from '../../src/threadbear-mcp.ts';
import { z } from 'zod';
import { NAMESPACE_DESCRIPTION, toolGuidance, type ToolDefinition } from '../../src/adapters/codex/tools.ts';
import { worktreeInstructions } from '../../src/worktrees.ts';
import { USER_NAME } from '../../src/user-name.ts';

const BUDGET_FILE = path.resolve(import.meta.dirname, '..', '..', 'context-budget.json');
const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SELF = '00000000-0000-4000-8000-000000000000';

// The same on every Mac and in every worktree: the repo's path and the
// user's name are in the instructions, so they're swapped for fixed words.
// A release's guide is in its checkout (guidePath), which can differ from
// the folder these tests run in.
const GUIDE_ROOT = path.dirname(path.dirname(guidePath()));
function norm(s: string): string {
  let out = s.split(GUIDE_ROOT).join('/repo').split(REPO).join('/repo');
  if (USER_NAME) out = out.split(`The user is ${USER_NAME}. `).join('The user is Name. ');
  return out;
}
const bytes = (s: string) => Buffer.byteLength(norm(s), 'utf8');

// Every optional tool on (schedules, projects, app restarts, the Pocket,
// secrets): the most a thread gets. Nothing is called while building.
function stub<T extends object>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}
function tools(provider: 'claude' | 'codex' | 'omp', oneReply: boolean): ToolDefinition[] {
  return buildThreadbearTools(stub<ThreadControl>(), SELF, () => 0, stub(), stub(), stub(), {
    provider,
    oneReply: () => oneReply,
    bulletReplies: () => true,
    pocket: () => stub(),
  }) as unknown as ToolDefinition[];
}

// A tool as the model sees it: name, description and JSON Schema. Most
// tools take a zod shape; Claude's end_turn is a whole zod object.
function spec(t: ToolDefinition): string {
  const shape = t.inputSchema as Record<string, unknown> & { _zod?: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = z.toJSONSchema((shape._zod ? shape : z.object(shape as any)) as z.ZodType) as Record<string, unknown>;
  delete schema.$schema;
  return JSON.stringify({ name: t.name, description: t.description, inputSchema: schema });
}

function toolBytes(defs: ToolDefinition[]): { total: number; perTool: Record<string, number> } {
  const perTool: Record<string, number> = {};
  for (const t of defs) perTool[t.name] = bytes(spec(t));
  return { total: Object.values(perTool).reduce((a, b) => a + b, 0), perTool: Object.fromEntries(Object.entries(perTool).sort()) };
}

export function measure() {
  // Settings > General's One reply is on by default (config.ts).
  const claudeTools = toolBytes(tools('claude', true));
  const codexDefs = tools('codex', true);
  const codexTools = toolBytes(codexDefs);
  const ompDefs = tools('omp', true);
  const ompTools = toolBytes(ompDefs);
  const claudeInstructions = bytes(serverInstructions(SELF, { one: true, bulletReplies: true, pocket: true, projects: true }));
  // The namespace's own description goes with the tools (dynamicToolSpecs).
  const codexInstructions = bytes(toolGuidance(codexDefs)) + bytes(NAMESPACE_DESCRIPTION);
  const ompInstructions = bytes(toolGuidance(ompDefs));
  const worktree = bytes(worktreeInstructions({ repo: 'repo', path: '/repo-threads/slot-1', branch: 'thread/00000000', mainCheckout: '/repo', base: '0000000' }));
  return {
    claude: { instructions: claudeInstructions, tools: claudeTools.total, total: claudeInstructions + claudeTools.total },
    codex: { instructions: codexInstructions, tools: codexTools.total, total: codexInstructions + codexTools.total },
    omp: { instructions: ompInstructions, tools: ompTools.total, total: ompInstructions + ompTools.total },
    worktreeInstructions: worktree,
    perTool: claudeTools.perTool,
  };
}

test('the context budget: what agents are handed every turn matches context-budget.json', () => {
  const now = measure();
  if (process.env.UPDATE_CONTEXT_BUDGET === '1') {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(now, null, 2) + '\n');
    return;
  }
  const saved = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as ReturnType<typeof measure>;
  const changes: string[] = [];
  const walk = (a: unknown, b: unknown, at: string) => {
    if (typeof a === 'number' || typeof b === 'number') {
      if (a !== b) changes.push(`${at}: ${b ?? 'none'} -> ${a ?? 'gone'} bytes${typeof a === 'number' && typeof b === 'number' ? ` (${a > b ? '+' : ''}${a - b})` : ''}`);
      return;
    }
    const keys = new Set([...Object.keys((a as object) ?? {}), ...Object.keys((b as object) ?? {})]);
    for (const k of keys) walk((a as Record<string, unknown>)?.[k], (b as Record<string, unknown>)?.[k], at ? `${at}.${k}` : k);
  };
  walk(now, saved, '');
  assert.deepEqual(changes, [], `What every agent is handed changed size:\n  ${changes.join('\n  ')}\nIf that's meant, run \`npm run context-budget\` in runner/ and commit context-budget.json with the change.`);
});
