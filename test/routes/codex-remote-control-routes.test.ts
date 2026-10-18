/**
 * @fileoverview POST /api/codex-remote-control/:action. The Codex binary is replaced by a temp script that
 * only echoes its arguments, so no test ever starts a real Codex daemon.
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME (and so one data dir). Port: N/A (inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCodexRemoteControlRoutes } from '../../src/web/routes/codex-remote-control-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';

const fake = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../src/utils/codex-cli-resolver.js', () => ({
  resolveCodexBinaryPath: () => fake.path,
  getCodexNotFoundMessage: () => 'Codex CLI not found',
}));

let dir: string;
const settings = (on: boolean | undefined) => {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(on === undefined ? {} : { codexRemoteControlEnabled: on }));
};
const post = async (action: string, opts: Parameters<typeof createRouteTestHarness>[1] = {}) => {
  const { app } = await createRouteTestHarness(registerCodexRemoteControlRoutes, opts);
  return app.inject({ method: 'POST', url: `/api/codex-remote-control/${action}` });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-rc-'));
  fake.path = join(dir, 'codex');
  writeFileSync(fake.path, '#!/bin/sh\nprintf \'{"argv":"%s"}\' "$*"\n');
  chmodSync(fake.path, 0o755);
  settings(true);
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(dir, { recursive: true, force: true });
  rmSync(SETTINGS_PATH, { force: true });
});

describe('POST /api/codex-remote-control/:action', () => {
  it('runs start, pair and stop with the exact arguments when the setting is on', async () => {
    for (const action of ['start', 'pair', 'stop']) {
      const res = await post(action);
      expect(res.statusCode, action).toBe(200);
      expect(res.json().data).toEqual({ action, output: { argv: `remote-control ${action} --json` } });
    }
  });

  it('is off by default: start and pair answer 403 and run nothing', async () => {
    for (const on of [undefined, false]) {
      settings(on);
      for (const action of ['start', 'pair']) {
        const res = await post(action);
        expect(res.statusCode, `${on} ${action}`).toBe(403);
        expect(res.json().error).toContain('disabled');
      }
    }
  });

  it('stop is never gated, so turning the setting off cannot strand a daemon', async () => {
    settings(false);
    expect((await post('stop')).statusCode).toBe(200);
  });

  it('400 for an unknown action, 404 when Codex is not installed', async () => {
    expect((await post('restart')).statusCode).toBe(400);
    fake.path = null;
    expect((await post('stop')).statusCode).toBe(404);
  });

  it('502 with Codex stderr when the command fails', async () => {
    writeFileSync(fake.path!, '#!/bin/sh\necho "no daemon" >&2\nexit 3\n');
    const res = await post('stop');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('no daemon');
  });

  it('is admin only in multi-user mode, for every action', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    for (const action of ['start', 'pair', 'stop']) {
      const res = await post(action, { authUser: { username: 'bob', role: 'user' } });
      expect(res.statusCode, action).toBe(403);
    }
    const ok = await post('stop', { authUser: { username: 'root', role: 'admin' } });
    expect(ok.statusCode).toBe(200);
  });
});
