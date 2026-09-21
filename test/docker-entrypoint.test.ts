/**
 * @fileoverview Static and fixture checks for the Docker Compose deployment's
 * privilege handling: `docker/entrypoint.sh` starts as root, corrects bind-mount
 * ownership and drops to PUID:PGID, which only works while three files agree.
 *
 * 1. The capabilities `docker-compose.yaml` adds back on top of `cap_drop: ALL`
 *    must be exactly what the entrypoint and `init: true` need. This is the
 *    drift that shipped once already: the `USER` instruction became a root
 *    entrypoint, tini stayed root while the server became PUID, and with no
 *    CAP_KILL every `docker compose down` ended in tini failing to forward
 *    SIGTERM and the server being SIGKILLed. The list is derived here from what
 *    the scripts actually do, not copied.
 * 2. The runtime-owned CLI prefix must never sit ahead of the system
 *    directories on the PATH the root entrypoint resolves commands through: a
 *    planted `setpriv` in a PUID-writable prefix ran as uid 0 (measured with a
 *    minimal image of the same shape).
 * 3. `Start-Codeman.sh` derives PUID/PGID BEFORE it creates
 *    `CODEMAN_CASES_PATH`, so the directory it creates has the owner the
 *    container will accept, and its `git_head_commit` helper (a pure function
 *    over `.git`) resolves the three ref layouts a checkout can have.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

const compose = read('docker/docker-compose.yaml');
const entrypoint = read('docker/entrypoint.sh');
const dockerfile = read('docker/server.Dockerfile');
const startScript = read('docker/Start-Codeman.sh');

/** The `- NAME` entries under `cap_add:` (the block ends at the next key at the same indent). */
function composeCapAdd(text: string): string[] {
  const m = text.match(/^(\s*)cap_add:\n((?:\1\s+.*\n)*)/m);
  if (!m) return [];
  return m[2]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .sort();
}

/**
 * What the deployment needs, derived from the scripts. Each rule names the
 * line that needs it, so a capability cannot be added or removed here without
 * the reason changing too.
 */
function requiredCaps(): string[] {
  const caps = new Set<string>();
  if (/\bchown\b/.test(entrypoint)) {
    // chown of a root-owned bind source, and traversing trees root cannot
    // otherwise read on a mount with restrictive modes.
    caps.add('CHOWN');
    caps.add('DAC_OVERRIDE');
  }
  if (/setpriv .*--reuid/.test(entrypoint)) caps.add('SETUID');
  if (/setpriv .*--(regid|groups|clear-groups)/.test(entrypoint)) caps.add('SETGID');
  const dropsUid = /setpriv .*--reuid/.test(entrypoint);
  if (/^\s*init:\s*true\s*$/m.test(compose) && dropsUid) {
    // tini is PID 1 and stays root; signalling the PUID server needs CAP_KILL.
    caps.add('KILL');
  }
  return [...caps].sort();
}

describe('docker-compose.yaml cap_add covers what entrypoint.sh and init:true need', () => {
  it('the compose file adds back exactly the derived capability set', () => {
    expect(composeCapAdd(compose)).toEqual(requiredCaps());
  });

  it('cap_drop: ALL is still the baseline', () => {
    expect(compose).toMatch(/^\s*cap_drop:\n\s*- ALL\s*$/m);
  });

  it("the entrypoint's own diagnosis names the same list, so a missing cap gets a one-line fix", () => {
    const m = entrypoint.match(/^required_caps='([^']+)'/m);
    expect(m, 'entrypoint.sh must declare required_caps').not.toBeNull();
    const named = m![1]
      .split(',')
      .map((c) => c.trim())
      .sort();
    expect(named).toEqual(composeCapAdd(compose));
  });

  it('the user-facing docs quote the same cap_add list', () => {
    for (const rel of ['docker/README.md', 'CLAUDE.md']) {
      const text = read(rel);
      const quoted = [...text.matchAll(/cap_add: \[([^\]]+)\]/g)].map((m) =>
        m[1]
          .split(',')
          .map((c) => c.trim())
          .sort()
      );
      expect(quoted.length, `${rel} should quote the cap_add list at least once`).toBeGreaterThan(0);
      for (const list of quoted) expect(list, rel).toEqual(composeCapAdd(compose));
    }
  });
});

describe('the runtime-owned CLI prefix never shadows root commands', () => {
  it('server.Dockerfile appends /opt/codeman-cli/bin to PATH rather than prepending it', () => {
    const pathLines = dockerfile.split('\n').filter((l) => /^ENV PATH=/.test(l));
    expect(pathLines.length).toBeGreaterThan(0);
    for (const line of pathLines) {
      expect(line, 'a writable prefix ahead of $PATH lets a planted setpriv run as root').not.toMatch(
        /^ENV PATH=\/opt\/codeman-cli/
      );
    }
    expect(pathLines).toContain('ENV PATH=$PATH:/opt/codeman-cli/bin');
  });

  it('entrypoint.sh pins PATH to the system directories before its first command', () => {
    const lines = entrypoint.split('\n');
    const pinIdx = lines.findIndex((l) => l === 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(pinIdx, 'the PATH pin must exist').toBeGreaterThan(-1);
    const firstToolIdx = lines.findIndex((l) => !l.trim().startsWith('#') && /\b(setpriv|chown|stat)\b/.test(l));
    expect(firstToolIdx).toBeGreaterThan(pinIdx);
    // The only thing allowed before the pin is the `user:` short-circuit.
    const before = lines
      .slice(0, pinIdx)
      .filter((l) => l.trim() && !l.trim().startsWith('#') && !/^(set -eu|runtime_path=\$PATH)$/.test(l.trim()));
    expect(before).toEqual(['if [ "$(id -u)" -ne 0 ]; then', '  exec "$@"', 'fi']);
  });

  it("entrypoint.sh hands the image's full PATH back to the server at the drop", () => {
    expect(entrypoint).toMatch(/exec setpriv [^\n]*\\\n\s*env PATH="\$runtime_path" "\$@"/);
  });

  it('entrypoint.sh no longer passes --bounding-set (a silent no-op without CAP_SETPCAP)', () => {
    const code = entrypoint
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/--bounding-set/);
    expect(composeCapAdd(compose)).not.toContain('SETPCAP');
  });
});

describe('Start-Codeman.sh', () => {
  it('parses under bash -n', () => {
    execFileSync('bash', ['-n', join(ROOT, 'docker/Start-Codeman.sh')]);
    execFileSync('sh', ['-n', join(ROOT, 'docker/entrypoint.sh')]);
  });

  it('derives PUID/PGID before creating CODEMAN_CASES_PATH, so the new directory gets that owner', () => {
    const puid = startScript.indexOf('export PUID=');
    const mkdirCases = startScript.indexOf('mkdir -p -- "$cases_path"');
    expect(puid).toBeGreaterThan(-1);
    expect(mkdirCases).toBeGreaterThan(puid);
    expect(startScript).toMatch(/chown -- "\$PUID:\$PGID" "\$cases_path"/);
  });

  it('builds before taking the stack down, and writes the source marker only after a refresh', () => {
    const build = startScript.indexOf('"${compose_command[@]}" build');
    const down = startScript.indexOf('"${compose_command[@]}" down');
    const marker = startScript.indexOf('>"$source_state_file.tmp"');
    expect(build).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(build);
    expect(marker).toBeGreaterThan(down);
    expect(startScript).toMatch(/if \[\[ "\$refreshed" == '1' \]\]; then\n\s*printf '\{\\n {2}"headCommit"/);
    // A failed volume removal must not abort under set -e with the stack down.
    expect(startScript).not.toMatch(/\[\[ -n "\$volume_name" \]\] && docker volume rm/);
    expect(startScript).toMatch(/&& ! docker volume rm -- "\$volume_name"; then/);
  });

  it('falls back to `down --volumes` when the Compose project name cannot be resolved', () => {
    expect(startScript).toMatch(/if \[\[ -z "\$project_name" \]\]; then[\s\S]*down --volumes/);
  });

  it('refuses to touch a Compose project already owned by a different checkout', () => {
    // docker-compose.yaml hard-codes `name: codeman`, so a second checkout run
    // without COMPOSE_PROJECT_NAME collides with a different deployment's
    // project. This guard is what caught it in the incident that motivated it
    // (2026-09-21): a second checkout's `down`/`up` silently took down and
    // rebuilt a live production container under the same resolved name.
    const projectName = startScript.indexOf('project_name=$(');
    const guard = startScript.indexOf('other_working_dir=$(');
    const build = startScript.indexOf('"${compose_command[@]}" build');
    const down = startScript.indexOf('"${compose_command[@]}" down');
    const fastPathUp = startScript.indexOf('exec "${compose_command[@]}" up --build -d');
    expect(projectName).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(projectName);
    // Must run before EVERY destructive path, including the no-refresh-needed
    // fast path that skips straight to `up --build -d`.
    expect(guard).toBeLessThan(fastPathUp);
    expect(guard).toBeLessThan(build);
    expect(guard).toBeLessThan(down);
    // Compares against the label Compose itself stamps, not a marker file this
    // script writes - the whole point is not trusting per-checkout state that
    // itself could be stale or absent on a first run against a live conflict.
    expect(startScript).toMatch(/label=com\.docker\.compose\.project=\$project_name/);
    expect(startScript).toMatch(/\{\{\.Label "com\.docker\.compose\.project\.working_dir"\}\}/);
    expect(startScript).toMatch(/grep -v -F -x -- "\$script_dir"/);
    // project_name is resolved exactly once and reused by the later
    // volume-refresh scoping - a second resolution could drift from the first.
    expect(startScript.match(/^project_name=\$\(/m)?.length ?? 0).toBe(1);
  });

  describe('the guard, actually executed (not just checked as text)', () => {
    /**
     * A static text/regex check on the source cannot see a runtime-only bug,
     * and this guard shipped with exactly one: under `set -o pipefail`, `grep
     * -v` legitimately exits 1 when nothing survives the filter - the
     * ORDINARY, no-collision case - and without `|| true` on the pipeline
     * that exit status propagates through the command substitution and `set
     * -e` aborts the WHOLE script at the guard, every single time, whether a
     * collision exists or not. Caught only by running the real guard block
     * against a stub `docker`, extracted from the live source the same way
     * the `git_head_commit` tests below extract that function - so a
     * regression here fails a real execution, not a string match.
     */
    let dir: string;
    let binDir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'codeman-guard-smoke-'));
      binDir = join(dir, 'bin');
      mkdirSync(binDir);
      const stub = [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "compose" ]]; then',
        '  shift',
        '  if [[ " $* " == *" config "* && " $* " == *" --format json "* ]]; then',
        // Real `docker compose config --format json` pretty-prints; `"name"`
        // starting its own line is what the sed extraction anchors on.
        '    printf \'{\\n  "name": "codeman"\\n}\\n\'',
        '    exit 0',
        '  fi',
        '  exit 0',
        'fi',
        'if [[ "$1" == "ps" && -n "${STUB_PS_WORKING_DIR:-}" ]]; then',
        '  echo "$STUB_PS_WORKING_DIR"',
        '  exit 0',
        'fi',
        'exit 0',
      ].join('\n');
      const stubPath = join(binDir, 'docker');
      writeFileSync(stubPath, stub);
      execFileSync('bash', ['-c', `chmod +x '${stubPath}'`]);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const runGuard = (
      scriptDir: string,
      extraEnv: Record<string, string> = {}
    ): { stdout: string; stderr: string; status: number } => {
      const harness = [
        'set -euo pipefail',
        'script_dir="$1"',
        'compose_command=(docker compose)',
        // Same range the `builds before taking the stack down` test above
        // pins as the guard's own boundaries: from where project_name is
        // resolved to the outer if's closing, unindented `fi`.
        `eval "$(sed -n '/^project_name=\\$(/,/^fi$/p' "$2")"`,
        'echo "GUARD_PASSED_WITHOUT_ABORTING"',
      ].join('\n');
      try {
        const stdout = execFileSync('bash', ['-c', harness, '_', scriptDir, join(ROOT, 'docker/Start-Codeman.sh')], {
          encoding: 'utf-8',
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...extraEnv },
        });
        return { stdout, stderr: '', status: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
      }
    };

    it('does NOT abort the ordinary, no-collision case (docker ps finds nothing)', () => {
      const { stdout, stderr, status } = runGuard('/this/checkout/docker');
      expect(status).toBe(0);
      expect(stdout).toContain('GUARD_PASSED_WITHOUT_ABORTING');
      expect(stderr).toBe('');
    });

    it('refuses when docker ps reports a DIFFERENT working_dir for the same project', () => {
      const { stdout, stderr, status } = runGuard('/this/checkout/docker', {
        STUB_PS_WORKING_DIR: '/some/other/checkout/docker',
      });
      expect(status).toBe(1);
      expect(stdout).not.toContain('GUARD_PASSED_WITHOUT_ABORTING');
      expect(stderr).toMatch(/already in use by a DIFFERENT checkout/);
      expect(stderr).toContain('/some/other/checkout/docker');
    });

    it('does NOT abort when docker ps reports back THIS checkout\u2019s own working_dir (a repeat run)', () => {
      // The filter excludes an exact match on script_dir - a second start
      // against the SAME checkout must never trip its own guard.
      const { stdout, stderr, status } = runGuard('/this/checkout/docker', {
        STUB_PS_WORKING_DIR: '/this/checkout/docker',
      });
      expect(status).toBe(0);
      expect(stdout).toContain('GUARD_PASSED_WITHOUT_ABORTING');
      expect(stderr).toBe('');
    });
  });
});

describe('git_head_commit resolves every ref layout a checkout can have', () => {
  let base: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).trim();

  /** Runs the function exactly as the script defines it, extracted by its own delimiters. */
  const headCommit = (repo: string): { out: string; status: number } => {
    const script = [`eval "$(sed -n '/^git_head_commit() {/,/^}/p' "$1")"`, 'git_head_commit "$2"'].join('\n');
    try {
      const out = execFileSync('bash', ['-c', script, '_', join(ROOT, 'docker/Start-Codeman.sh'), repo], {
        encoding: 'utf-8',
      });
      return { out: out.trim(), status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { out: (e.stdout ?? '').trim(), status: e.status ?? 1 };
    }
  };

  const makeRepo = (name: string): string => {
    const dir = join(base, name);
    git(base, 'init', '-q', '-b', 'master', dir);
    writeFileSync(join(dir, 'f'), 'x');
    git(dir, 'add', 'f');
    git(dir, 'commit', '-q', '-m', 'one');
    return dir;
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'codeman-head-commit-'));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('symbolic ref with a loose ref file', () => {
    const dir = makeRepo('loose');
    expect(headCommit(dir)).toEqual({ out: git(dir, 'rev-parse', 'HEAD'), status: 0 });
  });

  it('detached HEAD', () => {
    const dir = makeRepo('detached');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '--detach', sha);
    expect(headCommit(dir)).toEqual({ out: sha, status: 0 });
  });

  it('packed refs after gc', () => {
    const dir = makeRepo('packed');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'pack-refs', '--all');
    expect(readFileSync(join(dir, '.git/packed-refs'), 'utf-8')).toContain('refs/heads/master');
    expect(headCommit(dir)).toEqual({ out: sha, status: 0 });
  });

  it('a linked worktree (.git is a file) resolves nothing rather than something wrong', () => {
    const dir = makeRepo('main');
    const wt = join(base, 'wt');
    git(dir, 'worktree', 'add', '-q', wt);
    const result = headCommit(wt);
    expect(result.out).toBe('');
    expect(result.status).not.toBe(0);
  });

  it('a directory that is not a checkout fails', () => {
    const result = headCommit(base);
    expect(result.out).toBe('');
    expect(result.status).not.toBe(0);
  });
});
