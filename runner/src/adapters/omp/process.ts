import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killGroup, type ProcessRegistry } from '../../proc.ts';
import type { Logger } from '../../log.ts';

export type Frame = Record<string, any>;
const FRAME_LIMIT = 1024 * 1024;
const MESSAGE_LIMIT = 64 * 1024 * 1024;
export class OmpFrameDecoder {
  private chunk?: {
    id: string;
    count: number;
    length: number;
    parts: Buffer[];
    bytes: number;
  };
  accept(frame: Frame): Frame | undefined {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid OMP frame');
    if (frame.type !== 'rpc_chunk') {
      if (this.chunk) throw new Error('Interrupted OMP chunk sequence');
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== 'string' ||
      !chunkId ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      count < 1 ||
      index < 0 ||
      index >= count ||
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > MESSAGE_LIMIT ||
      count > 4096
    )
      throw new Error('Invalid OMP chunk or reassembly limit');
    if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid OMP chunk base64');
    if (!this.chunk) {
      if (index !== 0) throw new Error('OMP chunk sequence starts out of order');
      this.chunk = {
        id: chunkId,
        count,
        length: byteLength,
        parts: [],
        bytes: 0,
      };
    }
    const c = this.chunk;
    if (c.id !== chunkId || c.count !== count || c.length !== byteLength || index !== c.parts.length) throw new Error('Interleaved or out of order OMP chunks');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) throw new Error('Empty OMP chunk');
    c.bytes += bytes.length;
    if (c.bytes > c.length) throw new Error('OMP chunks exceed declared limit');
    c.parts.push(bytes);
    if (c.parts.length !== c.count) return;
    this.chunk = undefined;
    if (c.bytes !== c.length) throw new Error('Incomplete OMP chunk sequence');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(c.parts)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.type === 'rpc_chunk') throw new Error('Invalid reassembled OMP frame');
    return parsed;
  }
  finish(): void {
    if (this.chunk) throw new Error('Incomplete OMP chunk sequence at EOF');
  }
}
export type OmpProcessOptions = {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  registry: Pick<ProcessRegistry, 'add' | 'remove' | 'toolGroups'>;
  log: Logger;
  onFrame(frame: Frame): void;
  onExit(error?: Error): void;
};
export class OmpProcess {
  private child: ChildProcessWithoutNullStreams;
  private decoder = new OmpFrameDecoder();
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    string,
    {
      resolve(value: Frame): void;
      reject(e: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private closeResolve!: () => void;
  private readyTimer: NodeJS.Timeout;
  private ended = false;
  private closing = false;
  private failure?: Error;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  constructor(privateOptions: OmpProcessOptions) {
    this.options = privateOptions;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    this.readyTimer = setTimeout(() => this.fail(new Error('Oh My Pi did not become ready within 30 seconds')), 30_000).unref();
    this.child = spawn(privateOptions.binary, privateOptions.args, {
      cwd: privateOptions.cwd,
      env: privateOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (this.child.pid) privateOptions.registry.add(this.child.pid, privateOptions.binary);
    this.child.stdout.on('data', (data: Buffer) => {
      try {
        this.read(data);
      } catch (e) {
        this.fail(e as Error);
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', (e) => {
      if (!this.closing) this.fail(e);
    });
    this.child.once('error', (e) => this.finish(e));
    this.child.once('close', (code, signal) => {
      let error = this.failure;
      try {
        this.decoder.finish();
        if (this.buffer.length) throw new Error('Incomplete OMP frame at EOF');
      } catch (e) {
        error ??= e as Error;
      }
      this.finish(error ?? (!this.closing && code !== 0 ? new Error(`Oh My Pi exited (${signal ?? code})`) : undefined));
    });
  }
  private options: OmpProcessOptions;
  private read(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) >= 0) {
      if (index + 1 > FRAME_LIMIT) throw new Error('OMP physical frame exceeds 1 MiB limit');
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (!line.length) continue;
      const frame = this.decoder.accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
      if (!frame) continue;
      if (frame.type === 'ready') {
        clearTimeout(this.readyTimer);
        if (!Array.isArray(frame.supportedProtocolVersions) || !frame.supportedProtocolVersions.includes(2)) throw new Error('Oh My Pi needs RPC protocol v2 support; update omp');
        void this.request('negotiate_protocol', { protocolVersion: 2 }).then(
          () => this.readyResolve(),
          (e) => this.fail(e),
        );
      } else if (frame.type === 'response') {
        const pending = this.pending.get(frame.id);
        if (pending) {
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          frame.success ? pending.resolve(frame.data ?? {}) : pending.reject(new Error(String(frame.error ?? 'Oh My Pi command failed')));
        }
      } else if (frame.type === 'rpc_frame_error') throw new Error('Oh My Pi output exceeded its transport limit');
      this.options.onFrame(frame);
    }
    if (this.buffer.length > FRAME_LIMIT) throw new Error('OMP physical frame exceeds 1 MiB limit');
  }
  write(frame: Frame): void {
    if (this.ended || this.closing) throw new Error('Oh My Pi is closed');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > FRAME_LIMIT) throw new Error('Oh My Pi input exceeds its 1 MiB transport limit. Send less text or smaller pictures.');
    this.child.stdin.write(line);
  }
  request(type: string, params: Frame = {}, id = randomUUID()): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Oh My Pi ${type} timed out`));
      }, 30_000).unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ ...params, type, id });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private fail(error: Error): void {
    this.failure = error;
    this.readyReject(error);
    this.kill();
  }
  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.readyTimer);
    this.readyReject(error ?? new Error('Oh My Pi exited before startup completed'));
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error ?? new Error('Oh My Pi exited'));
    }
    this.pending.clear();
    const pid = this.child.pid;
    if (pid) {
      for (const group of this.options.registry.toolGroups(pid)) killGroup(group, 'SIGTERM');
      killGroup(pid, 'SIGTERM');
      this.options.registry.remove(pid);
    }
    this.closeResolve();
    this.options.onExit(error);
  }
  async end(hard = false): Promise<void> {
    if (this.ended) return;
    this.closing = true;
    if (hard) this.kill();
    else this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), 3000).unref();
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
  kill(): void {
    this.closing = true;
    if (this.child.pid && !this.ended) {
      for (const g of this.options.registry.toolGroups(this.child.pid)) killGroup(g, 'SIGKILL');
      killGroup(this.child.pid, 'SIGKILL');
    }
  }
}
