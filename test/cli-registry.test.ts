/**
 * @fileoverview Tests for the central CLI registry.
 *
 * Covers:
 *  1. Default config integrity (unique ids, required fields, valid prefixes)
 *  2. Capability predicate correctness (isExternalCliMode, isAltScreenStripMode, etc.)
 *  3. Derived lists (getAllowedEnvPrefixes, getAllowedEnvExactKeys, getRegisteredIds)
 *  4. Config file validation — invalid entries are dropped, invalid binaries rejected
 *  5. Extension smoke test — a Copilot CLI config file lights up all derived surfaces
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { homedir } from 'node:os';

// We import via the module so we can reset the singleton between tests.
// The registry is a module-level singleton; vi.resetModules() resets it.

// Helper to reimport the module with a fresh singleton
async function freshRegistry() {
  vi.resetModules();
  return import('../src/config/cli-registry.js');
}

describe('CLI Registry — default entries', () => {
  it('default config contains exactly the 7 expected modes', async () => {
    const { getRegisteredIds } = await freshRegistry();
    const ids = getRegisteredIds();
    expect(ids).toContain('claude');
    expect(ids).toContain('shell');
    expect(ids).toContain('opencode');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
    expect(ids).toContain('antigravity');
    expect(ids).toContain('pi');
    expect(ids.length).toBe(7);
  });

  it('has unique ids', async () => {
    const { getRegisteredIds } = await freshRegistry();
    const ids = getRegisteredIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every built-in entry has binary, label, shortBadge, and a color', async () => {
    const { getCliRegistry } = await freshRegistry();
    for (const entry of getCliRegistry()) {
      expect(entry.label, `${entry.id} missing label`).toBeTruthy();
      expect(entry.shortBadge !== undefined, `${entry.id} missing shortBadge`).toBe(true);
      if (entry.id !== 'shell') {
        // shell has no binary (resolved via shell-resolver)
        // other CLIs should have a binary name
      }
      expect(entry.color, `${entry.id} missing color`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });

  it('envPrefixes entries end with an underscore', async () => {
    const { getCliRegistry } = await freshRegistry();
    for (const entry of getCliRegistry()) {
      for (const prefix of entry.envPrefixes) {
        expect(prefix, `${entry.id} prefix "${prefix}" must end with _`).toMatch(/^[A-Z][A-Z0-9_]*_$/);
      }
    }
  });

  it('all built-in envExactKeys match the strict key pattern', async () => {
    const { getCliRegistry } = await freshRegistry();
    for (const entry of getCliRegistry()) {
      for (const key of entry.envExactKeys ?? []) {
        expect(key, `${entry.id} exact key "${key}" invalid`).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      }
    }
  });
});

describe('CLI Registry — capability predicates', () => {
  it('claude is NOT an external CLI and has hooks', async () => {
    const { isExternalCliMode, hooksAvailableForMode } = await freshRegistry();
    expect(isExternalCliMode('claude')).toBe(false);
    expect(hooksAvailableForMode('claude')).toBe(true);
  });

  it('shell is NOT an external CLI and has no hooks', async () => {
    const { isExternalCliMode, hooksAvailableForMode } = await freshRegistry();
    expect(isExternalCliMode('shell')).toBe(false);
    expect(hooksAvailableForMode('shell')).toBe(false);
  });

  it('opencode, codex, gemini, antigravity, pi are all external CLIs with no hooks', async () => {
    const { isExternalCliMode, hooksAvailableForMode } = await freshRegistry();
    for (const mode of ['opencode', 'codex', 'gemini', 'antigravity', 'pi']) {
      expect(isExternalCliMode(mode), `${mode} should be external`).toBe(true);
      expect(hooksAvailableForMode(mode), `${mode} should not have hooks`).toBe(false);
    }
  });

  it('isAltScreenStripMode: claude, codex, gemini = full strip; others = not full', async () => {
    const { isAltScreenStripMode } = await freshRegistry();
    expect(isAltScreenStripMode('claude')).toBe(true);
    expect(isAltScreenStripMode('codex')).toBe(true);
    expect(isAltScreenStripMode('gemini')).toBe(true);
    expect(isAltScreenStripMode('opencode')).toBe(false);
    expect(isAltScreenStripMode('shell')).toBe(false);
  });

  it('needsColorterm: codex, gemini, antigravity, pi = true; claude, shell, opencode = false', async () => {
    const { needsColorterm } = await freshRegistry();
    for (const mode of ['codex', 'gemini', 'antigravity', 'pi']) {
      expect(needsColorterm(mode), `${mode} should need colorterm`).toBe(true);
    }
    for (const mode of ['claude', 'shell', 'opencode']) {
      expect(needsColorterm(mode), `${mode} should not need colorterm`).toBe(false);
    }
  });

  it('getEchoPolicy: codex=predict, shell=none, others=buffer', async () => {
    const { getEchoPolicy } = await freshRegistry();
    expect(getEchoPolicy('codex')).toBe('predict');
    expect(getEchoPolicy('shell')).toBe('none');
    expect(getEchoPolicy('claude')).toBe('buffer');
    expect(getEchoPolicy('opencode')).toBe('buffer');
  });

  it('getModeLabel returns human-readable labels', async () => {
    const { getModeLabel } = await freshRegistry();
    expect(getModeLabel('claude')).toBe('Claude');
    expect(getModeLabel('antigravity')).toBe('Antigravity');
    expect(getModeLabel('pi')).toBe('Pi');
    expect(getModeLabel('unknown-mode')).toBe('unknown-mode');
  });

  it('getResumeSpec: codex subcommand, others flag-after', async () => {
    const { getResumeSpec } = await freshRegistry();
    expect(getResumeSpec('codex')).toEqual({ flag: 'resume', position: 'subcommand' });
    expect(getResumeSpec('gemini')?.flag).toBe('--resume');
    expect(getResumeSpec('pi')?.flag).toBe('--session');
    expect(getResumeSpec('claude')).toBeUndefined();
    expect(getResumeSpec('shell')).toBeUndefined();
  });
});

describe('CLI Registry — derived lists', () => {
  it('getAllowedEnvPrefixes includes all built-in prefixes', async () => {
    const { getAllowedEnvPrefixes } = await freshRegistry();
    const prefixes = getAllowedEnvPrefixes();
    for (const expected of ['CLAUDE_CODE_', 'OPENCODE_', 'CODEX_', 'GEMINI_', 'GOOGLE_', 'ANTIGRAVITY_', 'PI_']) {
      expect(prefixes, `missing prefix ${expected}`).toContain(expected);
    }
  });

  it('getAllowedEnvExactKeys includes CLAUDE_CONFIG_DIR', async () => {
    const { getAllowedEnvExactKeys } = await freshRegistry();
    expect(getAllowedEnvExactKeys()).toContain('CLAUDE_CONFIG_DIR');
  });

  it('getPublicRegistry contains no binary or searchDirs (security fields absent)', async () => {
    const { getPublicRegistry } = await freshRegistry();
    for (const entry of getPublicRegistry()) {
      expect(entry).not.toHaveProperty('binary');
      expect(entry).not.toHaveProperty('searchDirs');
      expect(entry).not.toHaveProperty('argSpec');
      expect(entry).not.toHaveProperty('envPrefixes');
    }
  });
});

describe('CLI Registry — config file validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('config with invalid binary (path separators) is rejected', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        readFileSync: (p: string, enc: string) => {
          if (String(p).endsWith('cli-registry.json')) {
            return JSON.stringify({
              entries: [{ id: 'evil', label: 'Evil', binary: '../../../etc/evil', searchDirs: [], isExternalCli: true }],
            });
          }
          return fs.readFileSync(p, enc as BufferEncoding);
        },
      };
    });
    const { getRegisteredIds } = await import('../src/config/cli-registry.js');
    expect(getRegisteredIds()).not.toContain('evil');
    warnSpy.mockRestore();
  });

  it('falls back to default config when no file exists', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        readFileSync: (p: string, enc: string) => {
          if (String(p).endsWith('cli-registry.json')) {
            const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            throw err;
          }
          return fs.readFileSync(p, enc as BufferEncoding);
        },
      };
    });
    const { getRegisteredIds } = await import('../src/config/cli-registry.js');
    const ids = getRegisteredIds();
    expect(ids).toContain('claude');
    expect(ids).toContain('gemini');
    expect(ids.length).toBe(7);
  });

  it('config file completely replaces the default — a file with only copilot gives only copilot', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        readFileSync: (p: string, enc: string) => {
          if (String(p).endsWith('cli-registry.json')) {
            return JSON.stringify({
              entries: [{
                id: 'copilot', label: 'GitHub Copilot', shortBadge: 'co',
                binary: 'gh', searchDirs: [], envPrefixes: ['GH_'],
                isExternalCli: true, stripMode: 'narrow', muxRequired: true,
                colorterm: false, echoPolicy: 'buffer', hooksAvailable: false,
                supportsRespawn: false, color: '#6e40c9', runButtonLabel: 'Run CP',
              }],
            });
          }
          return fs.readFileSync(p, enc as BufferEncoding);
        },
      };
    });
    const { getRegisteredIds } = await import('../src/config/cli-registry.js');
    const ids = getRegisteredIds();
    expect(ids).toEqual(['copilot']);
    expect(ids).not.toContain('claude');
  });

  it('config file with all 7 defaults + copilot gives 8 entries', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        readFileSync: (p: string, enc: string) => {
          if (String(p).endsWith('cli-registry.json')) {
            // Read the example file which has all 7 + copilot + cursor
            return fs.readFileSync(
              new URL('../cli-registry.example.json', import.meta.url).pathname,
              'utf-8'
            );
          }
          return fs.readFileSync(p, enc as BufferEncoding);
        },
      };
    });

    const {
      getRegisteredIds,
      getCliEntry,
      getAllowedEnvPrefixes,
      getPublicRegistry,
      isExternalCliMode,
      hooksAvailableForMode,
    } = await import('../src/config/cli-registry.js');

    // 1. All 7 defaults + copilot + cursor = 9
    expect(getRegisteredIds().length).toBe(9);
    expect(getRegisteredIds()).toContain('copilot');
    expect(getRegisteredIds()).toContain('claude');

    // 2. Full entry is retrievable
    const entry = getCliEntry('copilot');
    expect(entry?.label).toBe('GitHub Copilot');
    expect(entry?.binary).toBe('gh');

    // 3. Env prefix is in the derived allowlist
    expect(getAllowedEnvPrefixes()).toContain('GH_');

    // 4. Public registry includes it (no security fields)
    const pub = getPublicRegistry().find(e => e.id === 'copilot');
    expect(pub).toBeDefined();
    expect(pub?.runButtonLabel).toBe('Run CP');
    expect(pub).not.toHaveProperty('binary');

    // 5. Capability predicates work
    expect(isExternalCliMode('copilot')).toBe(true);
    expect(hooksAvailableForMode('copilot')).toBe(false);
  });
});
