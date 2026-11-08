import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account, EffortLevel, ModelChoice, PermissionMode, Question } from '../../protocol.ts';
import { isEffortLevel } from '../../protocol.ts';
import type { ProcessRegistry } from '../../proc.ts';
import type { Logger } from '../../log.ts';
import { atomicWriteFileSync } from '../../fsutil.ts';
import { toolTitle, truncateInput } from '../../tools.ts';
import type { AgentAdapter, AgentSession, SessionSink, StartSessionOptions, TurnResult, UserInput } from '../types.ts';
import { SessionNotFoundError } from '../types.ts';
import { fileContext } from '../context.ts';
import { CodexTools, NAMESPACE, toolGuidance, type ToolDefinition } from '../codex/tools.ts';
import { OmpProcess, type Frame } from './process.ts';
import { OmpNormalizer, displayTool } from './normalize.ts';

export type OmpAdapterDeps = {
  ompBinary(): string;
  registry: Pick<ProcessRegistry, 'add' | 'remove' | 'toolGroups'>;
  log: Logger;
  toolsFor?(threadId: string): ToolDefinition[];
  extraGuidance?(): string;
};
const HOST_PREFIX = `mcp__${NAMESPACE}__`;
const GUARD = path.join(import.meta.dirname, 'guard.mjs');
function environment(account: Account, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    PI_CODING_AGENT_DIR: account.configDir,
    PI_NO_TITLE: '1',
    PI_NO_PTY: '1',
  };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  return env;
}
function modelPair(model: string): { provider: string; modelId: string } {
  const at = model.indexOf('/');
  if (at < 1 || at === model.length - 1) throw new Error('An Oh My Pi model must be provider/model');
  return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}
function modelId(model: Frame | undefined): string | undefined {
  return typeof model?.provider === 'string' && typeof model?.id === 'string' ? `${model.provider}/${model.id}` : undefined;
}
export class OmpAdapter implements AgentAdapter {
  readonly provider = 'omp' as const;
  readonly wakesAfterTasks = true;
  private deps: OmpAdapterDeps;
  private defaults = new Map<string, string | undefined>();
  constructor(deps: OmpAdapterDeps) {
    this.deps = deps;
  }
  start(options: StartSessionOptions, sink: SessionSink): AgentSession {
    if (options.permissionMode === 'plan') throw new Error('Plan first is not supported by Oh My Pi. Choose Ask before edits.');
    return new OmpSession(options, sink, this.deps, async () => {
      if (!this.defaults.has(options.account.configDir)) await this.models(options.account);
      return this.defaults.get(options.account.configDir);
    });
  }
  async models(account: Account): Promise<ModelChoice[]> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-omp-models-'));
    const proc = new OmpProcess({
      binary: this.deps.ompBinary(),
      args: ['--mode', 'rpc-ui', '--no-session', '--no-extensions', '--no-tools', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp'],
      cwd,
      env: environment(account),
      registry: this.deps.registry,
      log: this.deps.log,
      onFrame() {},
      onExit() {},
    });
    try {
      await proc.ready;
      const data = await proc.request('get_available_models');
      const state = await proc.request('get_state');
      this.defaults.set(account.configDir, modelId(state.model));
      return (Array.isArray(data.models) ? data.models : []).flatMap((m: Frame) => {
        const id = modelId(m);
        if (!id) return [];
        const levels = Array.isArray(m.supportedThinkingLevels) ? m.supportedThinkingLevels.filter((e: unknown) => isEffortLevel(e) && e !== 'ultra') : undefined;
        return [
          {
            id,
            model: id,
            title: String(m.name ?? m.id),
            description: m.provider,
            ...(levels?.length ? { effortLevels: levels } : {}),
          },
        ];
      });
    } finally {
      await proc.end();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}
class OmpSession implements AgentSession {
  private proc?: OmpProcess;
  private init: Promise<void>;
  private normalizer: OmpNormalizer;
  private mode: PermissionMode;
  private policyFile: string;
  private configFile: string;
  private nonce = randomUUID();
  private guardReady = false;
  private tools: ToolDefinition[];
  private hostTools: CodexTools;
  private rules: Set<string>;
  private pending = new Map<string, AbortController>();
  private prompts = new Map<string, { input: UserInput; at: number }>();
  private results = new Map<string, Frame>();
  private flushQueued = false;
  private ownRunning = false;
  private ownAt = 0;
  private sessionFile?: string;
  private closing = false;
  private failed = false;
  private failure?: Error;
  private active = false;
  private settled = true;
  private selectedModel?: string;
  private opts: StartSessionOptions;
  private sink: SessionSink;
  private deps: OmpAdapterDeps;
  private defaultModel: () => Promise<string | undefined>;
  constructor(opts: StartSessionOptions, sink: SessionSink, deps: OmpAdapterDeps, defaultModel: () => Promise<string | undefined>) {
    this.defaultModel = defaultModel;
    this.opts = opts;
    this.sink = sink;
    this.deps = deps;
    this.mode = opts.permissionMode;
    this.rules = new Set(opts.allowRules ?? []);
    this.normalizer = new OmpNormalizer(fileContext(opts.cwd, opts.mediaDir, opts.blobsDir), (o) => sink.output(o));
    this.tools = deps.toolsFor?.(opts.threadId) ?? [];
    fs.mkdirSync(opts.tmpDir, { recursive: true });
    this.policyFile = path.join(opts.tmpDir, `omp-policy-${this.nonce}.json`);
    this.writePolicy();
    this.configFile = path.join(opts.tmpDir, `omp-config-${this.nonce}.yml`);
    atomicWriteFileSync(this.configFile, 'mcp:\n  enableProjectConfig: false\nlsp:\n  lazy: true\n');
    this.hostTools = new CodexTools(this.tools, {
      cwd: () => opts.cwd,
      mode: () => this.mode,
      rules: () => this.rules,
      addRules: (rules) => {
        for (const r of rules) this.rules.add(r);
        sink.output({ kind: 'allowRules', rules: [...this.rules] });
      },
      requestApproval: (r) => sink.requestApproval(r),
    });
    this.init = this.initialize();
    this.init.catch((e) => this.fail(e));
  }
  private writePolicy(): void {
    atomicWriteFileSync(
      this.policyFile,
      JSON.stringify({
        mode: this.mode,
        nonce: this.nonce,
        hostTools: this.tools.map((t) => HOST_PREFIX + t.name),
      }),
    );
  }
  private async initialize(): Promise<void> {
    const sessions = path.join(path.dirname(this.opts.mediaDir), 'omp-sessions');
    fs.mkdirSync(sessions, { recursive: true });
    if (this.opts.resume) {
      const session = path.resolve(this.opts.sessionId);
      if (!path.isAbsolute(this.opts.sessionId) || path.dirname(session) !== sessions || !fs.existsSync(session))
        throw new SessionNotFoundError('The saved Oh My Pi session was not found in this thread.');
      this.sessionFile = session;
    }
    const instructions = [toolGuidance(this.tools), this.opts.instructions, this.deps.extraGuidance?.()].filter(Boolean).join('\n\n');
    const args = ['--mode', 'rpc-ui', '--no-extensions', '--extension', GUARD, '--approval-mode', 'yolo', '--no-pty', '--session-dir', sessions, '--config', this.configFile];
    if (this.sessionFile) args.push('--resume', this.sessionFile);
    if (this.opts.model) {
      modelPair(this.opts.model);
      args.push('--model', this.opts.model);
    }
    if (this.opts.effort) {
      if (this.opts.effort === 'ultra') throw new Error('Oh My Pi does not support ultra effort');
      args.push('--thinking', this.opts.effort);
    }
    if (instructions) args.push('--append-system-prompt', instructions);
    this.proc = new OmpProcess({
      binary: this.deps.ompBinary(),
      args,
      cwd: this.opts.cwd,
      env: environment(this.opts.account, {
        ...this.opts.env,
        THREADBEAR_OMP_POLICY: this.policyFile,
      }),
      registry: this.deps.registry,
      log: this.deps.log,
      onFrame: (f) => this.frame(f),
      onExit: (e) => {
        this.cancelPending();
        if (!this.closing && e) this.fail(e);
        this.sink.exited(e ?? this.failure);
      },
    });
    await this.proc.ready;
    // get_state queues behind session_start, so its reply also proves the guard loaded.
    const state = await this.proc.request('get_state');
    if (!this.guardReady) throw new Error('Oh My Pi did not load the Threadbear approval guard; no prompt was sent.');
    this.state(state);
    if (!this.sessionFile) throw new Error('Oh My Pi did not report a persistent session file');
    await this.proc.request('set_host_tools', {
      tools: this.tools.map((t) => ({
        name: HOST_PREFIX + t.name,
        label: t.name,
        description: t.description,
        parameters: z.toJSONSchema(z.object(t.inputSchema as any)),
        loadMode: 'essential',
      })),
    });
    await this.proc.request('set_ask_dialog', { enabled: true });
    await this.proc.request('set_event_filter', {
      events: null,
      messageUpdates: 'delta',
    });
  }
  private state(state: Frame): void {
    if (typeof state.sessionFile === 'string') this.sessionFile = state.sessionFile;
    this.selectedModel = modelId(state.model) ?? this.selectedModel;
    if (this.sessionFile)
      this.sink.output({
        kind: 'session',
        nativeSessionId: this.sessionFile,
        model: this.selectedModel,
      });
    if (isEffortLevel(state.thinkingLevel)) this.sink.output({ kind: 'effort', level: state.thinkingLevel });
    if (typeof state.contextUsage?.tokens === 'number')
      this.sink.output({
        kind: 'context',
        contextTokens: state.contextUsage.tokens,
        contextWindow: state.contextUsage.contextWindow,
      });
  }
  send(input: UserInput): void {
    const id = randomUUID();
    this.prompts.set(id, { input, at: Date.now() });
    void this.init
      .then(async () => {
        if (this.closing) return;
        const images = input.images.map((image) => ({
          type: 'image',
          data: fs.readFileSync(image.path).toString('base64'),
          mimeType: image.mediaType,
        }));
        const response = await this.proc!.request(
          'prompt',
          {
            message: input.text,
            streamingBehavior: 'steer',
            ...(images.length ? { images } : {}),
          },
          id,
        );
        if (response.agentInvoked === false) this.complete(id, { status: 'completed', sessionSettled: true });
      })
      .catch((e) =>
        this.complete(id, {
          status: 'error',
          error: { message: String(e?.message ?? e) },
          sessionSettled: true,
        }),
      );
  }
  private frame(f: Frame): void {
    try {
      if (f.type === 'extension_ui_request') {
        void this.ui(f).catch(() => this.answer(f.id, { cancelled: true }));
        return;
      }
      if (f.type === 'host_tool_call') {
        void this.host(f);
        return;
      }
      if (f.type === 'host_tool_cancel') {
        this.pending.get(f.targetId)?.abort();
        return;
      }
      if (f.type === 'prompt_result') {
        this.complete(f.id, f);
        return;
      }
      if (f.type === 'session_settled') {
        this.settled = true;
        this.sink.output({ kind: 'tasks', tasks: [] });
        return;
      }
      if (f.type === 'agent_start') {
        this.settled = false;
        this.active = true;
        if (!this.prompts.size) {
          this.ownRunning = true;
          this.ownAt = Date.now();
          this.sink.output({
            kind: 'cliTurn',
            note: 'Oh My Pi background work continued',
          });
        }
      }
      if (f.type === 'agent_end' && f.isTerminal !== false) {
        this.active = false;
        if (this.ownRunning) {
          this.ownRunning = false;
          const last = f.messages?.at(-1);
          this.sink.output({
            kind: 'result',
            result: {
              own: true,
              outcome: last?.stopReason === 'error' ? 'failed' : 'completed',
              durationMs: Date.now() - this.ownAt,
              ...(last?.errorMessage ? { error: String(last.errorMessage) } : {}),
            },
          });
        }
      }
      if (f.type === 'model_changed') {
        this.selectedModel = modelId(f.model);
        if (this.sessionFile)
          this.sink.output({
            kind: 'session',
            nativeSessionId: this.sessionFile,
            model: this.selectedModel,
          });
      }
      if (f.type === 'thinking_level_changed' && isEffortLevel(f.thinkingLevel ?? f.level)) this.sink.output({ kind: 'effort', level: f.thinkingLevel ?? f.level });
      if (f.type === 'notice' && f.level === 'error')
        this.sink.output({
          kind: 'event',
          event: {
            type: 'error',
            message: String(f.message ?? 'Oh My Pi could not persist the session'),
          },
        });
      this.normalizer.accept(f);
    } catch (e) {
      this.fail(e as Error);
    }
  }
  private complete(id: string, f: Frame): void {
    if (!this.prompts.has(id) || this.results.has(id)) return;
    this.results.set(id, f);
    this.settled = f.sessionSettled !== false;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const done = [...this.results];
      this.results.clear();
      if (!done.length) return;
      const inputs = done.map(([key]) => this.prompts.get(key)).filter(Boolean);
      for (const [key] of done) this.prompts.delete(key);
      const result = done.find(([, r]) => r.status === 'error')?.[1] ?? done.find(([, r]) => r.status === 'aborted')?.[1] ?? done.at(-1)![1];
      const answered = inputs.map((p) => p!.input.id).filter((v): v is string => !!v);
      const output: TurnResult = {
        outcome: result.status === 'error' ? 'failed' : result.status === 'aborted' ? 'interrupted' : 'completed',
        durationMs: Date.now() - Math.min(...inputs.map((p) => p!.at)),
        ...(answered.length ? { answers: answered.at(-1), answered } : {}),
        ...(this.prompts.size ? { queuedTurns: this.prompts.size } : {}),
      };
      if (result.error?.message) output.error = String(result.error.message);
      if (result.error?.httpStatus === 401 || result.error?.httpStatus === 403) output.errorKind = 'auth';
      else if (result.error?.httpStatus === 429) output.errorKind = 'usageLimit';
      if (!this.settled)
        this.sink.output({
          kind: 'tasks',
          tasks: [
            {
              id: 'omp-background',
              type: 'omp',
              kind: 'other',
              description: 'Oh My Pi background work',
            },
          ],
        });
      this.sink.output({ kind: 'result', result: output });
      if (this.proc && !this.closing)
        void this.proc.request('get_state').then(
          (s) => this.state(s),
          () => {},
        );
    });
  }
  private answer(id: string, answer: Frame): void {
    if (this.proc && !this.closing) {
      try {
        this.proc.write({ type: 'extension_ui_response', id, ...answer });
      } catch {}
    }
  }
  private async ui(f: Frame): Promise<void> {
    if (f.method === 'notify' && f.message === `threadbear-guard-ready:${this.nonce}`) {
      this.guardReady = true;
      return;
    }
    if (f.method === 'cancel') {
      this.pending.get(f.targetId)?.abort();
      return;
    }
    if (!['select', 'confirm', 'input', 'editor', 'ask'].includes(f.method)) return;
    const abort = new AbortController();
    this.pending.set(f.id, abort);
    try {
      if (f.secret) {
        this.answer(f.id, { cancelled: true });
        return;
      }
      if (f.method === 'confirm' && f.title === 'Threadbear tool approval') {
        const request = JSON.parse(f.message);
        if (request.nonce !== this.nonce || typeof request.name !== 'string' || !request.input || typeof request.input !== 'object')
          throw new Error('Invalid Threadbear approval request');
        const display = displayTool(request.name, request.input);
        const result = await this.sink.requestApproval({
          toolUseId: this.normalizer.toolId(request.toolCallId),
          name: request.name,
          title: toolTitle(display.name, display.input, this.opts.cwd),
          input: truncateInput(request.input),
          canAlwaysAllow: false,
          signal: abort.signal,
        });
        this.answer(f.id, {
          confirmed: !abort.signal.aborted && (result.decision === 'allow' || result.decision === 'allowAlways'),
        });
        return;
      }
      const options = Array.isArray(f.options) ? f.options.filter((s: unknown) => typeof s === 'string') : [];
      if (f.method === 'select' && options.includes('Deny') && (options.includes('Approve') || options.includes('Approve Once'))) {
        const result = await this.sink.requestApproval({
          name: 'omp',
          title: String(f.title ?? 'Oh My Pi approval').split('\n')[0],
          input: { details: String(f.title ?? '') },
          canAlwaysAllow: false,
          signal: abort.signal,
        });
        this.answer(f.id, {
          value:
            !abort.signal.aborted && (result.decision === 'allow' || result.decision === 'allowAlways') ? (options.includes('Approve Once') ? 'Approve Once' : 'Approve') : 'Deny',
        });
        return;
      }
      if (f.method === 'confirm') {
        const result = await this.sink.requestApproval({
          name: 'omp',
          title: String(f.title ?? 'Oh My Pi confirmation'),
          input: { message: String(f.message ?? '') },
          canAlwaysAllow: false,
          signal: abort.signal,
        });
        this.answer(f.id, {
          confirmed: !abort.signal.aborted && result.decision === 'allow',
        });
        return;
      }
      const questions: Question[] =
        f.method === 'ask'
          ? (Array.isArray(f.questions) ? f.questions : []).map((q: Frame) => ({
              question: String(q.question),
              header: q.header,
              multiSelect: q.multi === true,
              options: (q.options ?? []).map((o: Frame) => ({
                label: String(o.label),
                description: o.description,
              })),
            }))
          : [
              {
                question: String(f.title ?? 'Oh My Pi question'),
                multiSelect: false,
                options: options.map((label: string) => ({ label })),
              },
            ];
      if (!questions.length) {
        this.answer(f.id, { cancelled: true });
        return;
      }
      const result = await this.sink.requestQuestion({
        questions,
        signal: abort.signal,
      });
      if (!result.answers || abort.signal.aborted) {
        this.answer(f.id, { cancelled: true });
        return;
      }
      if (f.method === 'ask')
        this.answer(f.id, {
          answers: questions.map((q, i) => {
            const answer = result.answers![q.question] ?? '';
            const chosen = [answer];
            const labels = q.options.map((o) => o.label);
            return {
              id: f.questions[i].id,
              selectedOptions: chosen.filter((s) => labels.includes(s)),
              ...(chosen.some((s) => !labels.includes(s))
                ? {
                    customInput: chosen.filter((s) => !labels.includes(s)).join('\n'),
                  }
                : {}),
            };
          }),
        });
      else
        this.answer(f.id, {
          value: result.answers[questions[0].question] ?? '',
        });
    } finally {
      this.pending.delete(f.id);
    }
  }
  private async host(f: Frame): Promise<void> {
    const abort = new AbortController();
    this.pending.set(f.id, abort);
    try {
      const name = typeof f.toolName === 'string' && f.toolName.startsWith(HOST_PREFIX) ? f.toolName.slice(HOST_PREFIX.length) : '';
      const result = await this.hostTools.call(
        {
          namespace: NAMESPACE,
          tool: name,
          arguments: f.arguments,
          callId: this.normalizer.toolId(f.toolCallId),
          threadId: this.opts.threadId,
          turnId: '',
        },
        { fromChild: false, signal: abort.signal },
      );
      if (!this.closing && !abort.signal.aborted)
        this.proc?.write({
          type: 'host_tool_result',
          id: f.id,
          isError: !result.success,
          result: {
            content: result.contentItems.map((c) => ({
              type: 'text',
              text: c.type === 'inputText' ? c.text : '',
            })),
          },
        });
    } catch (e) {
      if (!this.closing && !abort.signal.aborted)
        this.proc?.write({
          type: 'host_tool_result',
          id: f.id,
          isError: true,
          result: {
            content: [{ type: 'text', text: String((e as Error).message) }],
          },
        });
    } finally {
      this.pending.delete(f.id);
    }
  }
  private cancelPending(): void {
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear();
  }
  private fail(e: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.failure = e;
    for (const id of this.prompts.keys())
      this.complete(id, {
        status: 'error',
        error: { message: e.message },
        sessionSettled: true,
      });
    this.cancelPending();
    if (this.proc) this.proc.kill();
    else this.sink.exited(e);
  }
  async interrupt(): Promise<void> {
    await this.init;
    this.cancelPending();
    await this.proc!.request('abort_and_restore_queue');
  }
  async setModel(model: string | undefined): Promise<void> {
    await this.init;
    const selected = model ?? (await this.defaultModel());
    if (!selected) throw new Error('Oh My Pi has no default model configured. Choose a model.');
    const m = await this.proc!.request('set_model', modelPair(selected));
    this.selectedModel = modelId(m) ?? selected;
  }
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    if (effort === 'ultra') throw new Error('Oh My Pi does not support ultra effort');
    await this.init;
    await this.proc!.request('set_thinking_level', {
      level: effort ?? 'inherit',
    });
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode === 'plan') throw new Error('Plan first is not supported by Oh My Pi. Choose Ask before edits.');
    const lower = this.mode === 'full' && mode !== 'full';
    this.mode = mode;
    try {
      this.writePolicy();
    } catch (error) {
      this.fail(error as Error);
      throw error;
    }
    if (lower && this.active) await this.interrupt();
  }
  async end(opts?: { hard?: boolean }): Promise<void> {
    this.closing = true;
    this.cancelPending();
    await this.proc?.end(opts?.hard);
    try {
      fs.rmSync(this.policyFile, { force: true });
      fs.rmSync(this.configFile, { force: true });
    } catch {}
  }
  kill(): void {
    this.closing = true;
    this.cancelPending();
    this.proc?.kill();
  }
}
