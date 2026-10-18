/**
 * @fileoverview Codex remote control: runs `codex remote-control start|stop|pair` (the Codex CLI's
 * own experimental command, which runs its app-server daemon with remote control on) so it can be
 * switched on from Settings instead of a shell.
 *
 * Codeman starts nothing on its own: each call is one explicit request. The output is passed through
 * as Codex prints it (parsed when it is JSON) because its shape is Codex's, not ours. `pair` prints a
 * short-lived pairing code, a credential: it is returned to the caller and never logged here.
 *
 * @module codex-remote-control
 */

import { execFile } from 'node:child_process';

export const CODEX_REMOTE_CONTROL_ACTIONS = ['start', 'stop', 'pair'] as const;
export type CodexRemoteControlAction = (typeof CODEX_REMOTE_CONTROL_ACTIONS)[number];

export class CodexRemoteControlBusyError extends Error {}
export class CodexRemoteControlFailedError extends Error {}

export interface CodexRemoteControlResult {
  action: CodexRemoteControlAction;
  /** Codex's `--json` output parsed, or its text when it is not JSON. */
  output: unknown;
}

export type CodexRunner = (
  file: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>;

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 64 * 1024;

const execRunner: CodexRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // No shell; SIGKILL because a wedged daemon start ignores SIGTERM.
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES, env: process.env },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr }))
    );
  });

let running = false;

export async function runCodexRemoteControl(
  action: CodexRemoteControlAction,
  binaryPath: string,
  run: CodexRunner = execRunner
): Promise<CodexRemoteControlResult> {
  if (running) throw new CodexRemoteControlBusyError('Another Codex remote control command is still running');
  running = true;
  try {
    const { stdout } = await run(binaryPath, ['remote-control', action, '--json'], TIMEOUT_MS);
    const text = stdout.trim();
    try {
      return { action, output: JSON.parse(text) as unknown };
    } catch {
      return { action, output: text };
    }
  } catch (err) {
    // stderr only: stdout of a failed `pair` could still hold a code.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    const why = stderr || (err instanceof Error ? err.message : String(err));
    throw new CodexRemoteControlFailedError(`codex remote-control ${action} failed: ${why.slice(0, 500)}`);
  } finally {
    running = false;
  }
}
