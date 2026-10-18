/**
 * @fileoverview Codex remote control (src/codex-remote-control.ts): the exact command run, JSON or text
 * passthrough, failures that never echo stdout, and one command at a time. A fake runner stands in for
 * `codex`, so nothing here starts a daemon. port: N/A.
 */
import { describe, expect, it } from 'vitest';
import {
  CodexRemoteControlBusyError,
  CodexRemoteControlFailedError,
  runCodexRemoteControl,
  type CodexRunner,
} from '../src/codex-remote-control.js';

describe('runCodexRemoteControl', () => {
  it('runs `codex remote-control <action> --json` without a shell and parses JSON output', async () => {
    const calls: string[][] = [];
    const run: CodexRunner = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: '{"code":"123-456"}\n', stderr: '' };
    };
    const out = await runCodexRemoteControl('pair', '/opt/codex', run);
    expect(calls).toEqual([['/opt/codex', 'remote-control', 'pair', '--json']]);
    expect(out).toEqual({ action: 'pair', output: { code: '123-456' } });
  });

  it('passes text through when the output is not JSON', async () => {
    const out = await runCodexRemoteControl('start', 'codex', async () => ({ stdout: ' started \n', stderr: '' }));
    expect(out.output).toBe('started');
  });

  it('reports a failure by stderr, never by stdout (a failed pair could still print a code)', async () => {
    const run: CodexRunner = async () => {
      throw Object.assign(new Error('exit 1'), { stdout: 'CODE-SECRET', stderr: 'daemon already running' });
    };
    const err = await runCodexRemoteControl('start', 'codex', run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexRemoteControlFailedError);
    expect((err as Error).message).toContain('daemon already running');
    expect((err as Error).message).not.toContain('CODE-SECRET');
  });

  it('falls back to the error message when stderr is empty, and truncates it', async () => {
    const run: CodexRunner = async () => {
      throw Object.assign(new Error('x'.repeat(2000)), { stderr: '' });
    };
    const err = (await runCodexRemoteControl('stop', 'codex', run).catch((e: unknown) => e)) as Error;
    expect(err.message.length).toBeLessThan(600);
  });

  it('refuses a second command while one runs, and recovers afterwards', async () => {
    let release!: () => void;
    const slow: CodexRunner = () => new Promise((resolve) => (release = () => resolve({ stdout: 'ok', stderr: '' })));
    const first = runCodexRemoteControl('start', 'codex', slow);
    await expect(runCodexRemoteControl('pair', 'codex', slow)).rejects.toBeInstanceOf(CodexRemoteControlBusyError);
    release();
    await first;
    await expect(
      runCodexRemoteControl('stop', 'codex', async () => ({ stdout: 'ok', stderr: '' }))
    ).resolves.toBeTruthy();
  });
});
