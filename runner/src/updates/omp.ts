// Oh My Pi's own updater. `omp update --check` asks its release feed and
// prints "New version available: X" or "Already up to date"; `omp update`
// downloads the new binary beside the old one and renames it into place,
// so a running omp keeps the file it started from. Installs from Homebrew,
// mise or Nix answer that their package manager keeps omp up to date.
//
// omp picks what to check and replace with `which omp` on PATH, not the
// binary that was run, so both run with ompPath's folder first on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { VERSION_RE, type Exec } from './exec.ts';

const VERSION_IN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const NEWER = /New version available:\s*(\S+)/i;
const CURRENT = /Already up to date/i;
// What `omp update` prints, exiting 0, for an install it can't update itself.
const MANAGED_ELSEWHERE = /(managed by Nix and cannot update itself|kept up to date by|only supported for bun, npm, or binary installs)/i;

// "omp/18.12.6" from `omp --version`. Undefined when there's no omp.
export async function ompInstalledVersion(ompPath: string, exec: Exec): Promise<string | undefined> {
  if (ompPath.includes('/') && !fs.existsSync(ompPath)) return undefined;
  const r = await exec(ompPath, ['--version'], { timeoutMs: 10_000 });
  return r.code === 0 ? VERSION_IN.exec(r.stdout)?.[1] : undefined;
}

// The newest release, from `omp update --check`: the version it offers,
// or the installed one when it says it's up to date.
export async function ompLatestVersion(o: { ompPath: string; exec: Exec; env?: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; installed?: string }): Promise<string | undefined> {
  const env = targetEnv(o.ompPath, o.env);
  if (typeof env === 'string') throw new Error(env);
  fs.mkdirSync(o.cwd, { recursive: true });
  const r = await o.exec(o.ompPath, ['update', '--check'], { cwd: o.cwd, env, timeoutMs: o.timeoutMs });
  const output = `${r.stdout}${r.stderr}`;
  if (r.code !== 0) throw new Error(firstLine(output) || r.error || `omp update --check exited ${r.code}`);
  const offered = NEWER.exec(output)?.[1];
  if (offered && VERSION_RE.test(offered)) return offered;
  if (CURRENT.test(output)) return o.installed;
  return undefined;
}

export type OmpUpdateResult =
  | { kind: 'updated'; from?: string; to: string; output: string }
  | { kind: 'unchanged'; version?: string; output: string }
  | { kind: 'failed'; message: string; output: string };

// Runs `omp update` and asks the binary its version afterwards.
export async function runOmpUpdate(o: { ompPath: string; cwd: string; exec: Exec; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<OmpUpdateResult> {
  const env = targetEnv(o.ompPath, o.env);
  if (typeof env === 'string') return { kind: 'failed', message: env, output: '' };
  const before = await ompInstalledVersion(o.ompPath, o.exec);
  fs.mkdirSync(o.cwd, { recursive: true });
  const r = await o.exec(o.ompPath, ['update'], { cwd: o.cwd, env, timeoutMs: o.timeoutMs });
  const output = `${r.stdout}${r.stderr}`;
  const after = await ompInstalledVersion(o.ompPath, o.exec);
  if (after && after !== before) return { kind: 'updated', from: before, to: after, output };
  if (r.code !== 0) return { kind: 'failed', message: firstLine(output.replace(/^.*Update failed:\s*/ms, '')) || r.error || `omp update exited ${r.code}`, output };
  const elsewhere = MANAGED_ELSEWHERE.exec(output);
  if (elsewhere) return { kind: 'failed', message: firstLine(output.slice(output.lastIndexOf('\n', elsewhere.index) + 1)), output };
  return { kind: 'unchanged', version: after, output };
}

// The environment that makes `which omp` find ompPath, or why there's none.
export function targetEnv(ompPath: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | string {
  if (!path.isAbsolute(ompPath) || !fs.existsSync(ompPath)) return `Oh My Pi isn't at ${ompPath}.`;
  if (path.basename(ompPath) !== 'omp') return `ompPath ${ompPath} isn't named omp, so omp update would update another copy. Update it by hand.`;
  const dir = path.dirname(ompPath);
  const rest = (env.PATH ?? '').split(path.delimiter).filter((d) => d && path.resolve(d) !== dir);
  return { ...env, PATH: [dir, ...rest].join(path.delimiter) };
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}
