/**
 * @fileoverview Launching a CLI with its own remote control on (src/launch-remote-control.ts): the
 * synced switch is OFF by default, applies to local launches only, and the registry templates add
 * the flag only when it is on. Claude's flag is version-gated and fail-closed, like `--name`.
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME (and so one settings.json). Port: N/A.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { readLaunchRemoteControl } from '../src/launch-remote-control.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

const FLAG = '--remote-control';
const claude = (extra: Record<string, unknown> = {}) =>
  buildSpawnCommand({ mode: 'claude', sessionId: 'abc', claudeCliVersion: '2.1.302', ...extra });

describe('claude launch template', () => {
  it('adds --remote-control for a new and a resumed session when on and the version allows it', () => {
    expect(claude({ remoteControl: true })).toContain(` ${FLAG}`);
    const resumed = claude({ remoteControl: true, resumeSessionId: '11111111-2222-3333-4444-555555555555' });
    expect(resumed).toContain('--resume');
    expect(resumed).toContain(` ${FLAG}`);
  });

  it('is byte-identical to before when it is off', () => {
    expect(claude({ remoteControl: false })).toBe(claude());
    expect(claude()).not.toContain(FLAG);
  });

  it('fails closed: an old or unknown claude version gets no flag (an unknown option aborts startup)', () => {
    for (const version of ['2.1.50', null]) {
      expect(claude({ remoteControl: true, claudeCliVersion: version })).not.toContain(FLAG);
    }
    expect(claude({ remoteControl: true, claudeCliVersion: '2.1.51' })).toContain(FLAG);
  });
});

describe('other launch templates', () => {
  it('antigravity adds the flag when on, and not otherwise', () => {
    const on = buildSpawnCommand({ mode: 'antigravity', sessionId: 'abc', remoteControl: true });
    expect(on).toContain(`agy`);
    expect(on).toContain(FLAG);
    expect(buildSpawnCommand({ mode: 'antigravity', sessionId: 'abc' })).not.toContain(FLAG);
  });

  it('copilot adds --remote when on, and not otherwise', () => {
    const on = buildSpawnCommand({ mode: 'copilot', sessionId: 'abc', remoteControl: true });
    expect(on).toContain('copilot');
    expect(on).toMatch(/ --remote(\s|$)/);
    expect(buildSpawnCommand({ mode: 'copilot', sessionId: 'abc' })).not.toContain('--remote');
    expect(buildSpawnCommand({ mode: 'copilot', sessionId: 'abc', remoteControl: false })).toBe(
      buildSpawnCommand({ mode: 'copilot', sessionId: 'abc' })
    );
  });

  it('a CLI that does not declare it ignores the value', () => {
    for (const mode of ['codex', 'gemini', 'opencode']) {
      expect(buildSpawnCommand({ mode, sessionId: 'abc', remoteControl: true }), mode).not.toContain(FLAG);
    }
  });
});

describe('readLaunchRemoteControl', () => {
  const settings = (value: Record<string, unknown> | null) => {
    if (value === null) return rmSync(SETTINGS_PATH, { force: true });
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(value));
  };
  afterEach(() => rmSync(SETTINGS_PATH, { force: true }));

  it('is off by default, and only an explicit true turns it on', async () => {
    settings(null);
    expect(await readLaunchRemoteControl('claude', false)).toBe(false);
    for (const v of [false, 'true', 1]) {
      settings({ claudeRemoteControlEnabled: v });
      expect(await readLaunchRemoteControl('claude', false), String(v)).toBe(false);
    }
    settings({ claudeRemoteControlEnabled: true });
    expect(await readLaunchRemoteControl('claude', false)).toBe(true);
  });

  it('reads each CLI its own switch', async () => {
    settings({ claudeRemoteControlEnabled: true });
    expect(await readLaunchRemoteControl('antigravity', false)).toBe(false);
    settings({ antigravityRemoteControlEnabled: true });
    expect(await readLaunchRemoteControl('antigravity', false)).toBe(true);
    expect(await readLaunchRemoteControl('claude', false)).toBe(false);
    settings({ copilotRemoteControlEnabled: true });
    expect(await readLaunchRemoteControl('copilot', false)).toBe(true);
    expect(await readLaunchRemoteControl('antigravity', false)).toBe(false);
  });

  it('never applies to remote or Docker launches, nor to a CLI without the capability', async () => {
    settings({ claudeRemoteControlEnabled: true, codexRemoteControlEnabled: true });
    expect(await readLaunchRemoteControl('claude', true)).toBe(false);
    expect(await readLaunchRemoteControl('codex', false)).toBe(false);
    expect(await readLaunchRemoteControl('shell', false)).toBe(false);
  });
});
