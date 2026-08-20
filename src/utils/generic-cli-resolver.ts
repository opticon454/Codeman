/**
 * @fileoverview Generic CLI binary resolver backed by the CLI registry.
 *
 * Replaces the six individual *-cli-resolver.ts files.  Each entry in
 * `src/config/cli-registry.ts` declares `binary` and `searchDirs`; this module
 * provides a single parametric implementation of the `which` + fallback pattern
 * that all of them shared, plus per-entry caching so repeated calls are free.
 *
 * The Pi resolver's version-probe logic is preserved separately in `pi-cli-resolver.ts`
 * because the short, generic binary name requires extra sanity-checking that does
 * not apply to any other CLI.
 *
 * @module utils/generic-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCliEntry } from '../config/cli-registry.js';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Per-id directory cache: null = not yet probed, '' = probed, not found */
const _cache = new Map<string, string | null>();

/**
 * Find the directory containing the registered CLI binary for `id`.
 * Checks `which <binary>` first, then falls back to the entry's `searchDirs`.
 * Returns null if the binary is not found or the entry does not exist.
 */
export function resolveCliDir(id: string): string | null {
  const cached = _cache.get(id);
  if (cached !== undefined) return cached || null;

  const entry = getCliEntry(id);
  if (!entry || !entry.binary) {
    _cache.set(id, '');
    return null;
  }

  try {
    const result = execSync(`which ${entry.binary}`, {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      const dir = dirname(result);
      _cache.set(id, dir);
      return dir;
    }
  } catch {
    // binary not in PATH — fall through to searchDirs
  }

  for (const dir of entry.searchDirs) {
    if (existsSync(join(dir, entry.binary))) {
      _cache.set(id, dir);
      return dir;
    }
  }

  _cache.set(id, '');
  return null;
}

/** Return true if the binary for `id` is found anywhere on the system. */
export function isCliAvailable(id: string): boolean {
  return resolveCliDir(id) !== null;
}

/** Reset cached resolution for `id` (useful in tests). */
export function resetCliCache(id?: string): void {
  if (id) {
    _cache.delete(id);
  } else {
    _cache.clear();
  }
}
