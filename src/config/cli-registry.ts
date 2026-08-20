/**
 * @fileoverview Central registry of CLI backends supported by Codeman.
 *
 * Each entry declares everything Codeman needs to discover, spawn, and render
 * a CLI backend without further hardcoding. The built-in entries describe the
 * seven backends that ship with Codeman; additional entries can be loaded at
 * boot from the user-overlay file (`~/.codeman/cli-registry.json`) so operators
 * can add CLIs (e.g. GitHub Copilot CLI, Cursor CLI) without recompiling.
 *
 * Security rules for overlay entries (enforced by `loadOverlay()`):
 *   - May only ADD new ids; built-in ids are reserved and overlay cannot modify
 *     security-critical fields of any built-in entry.
 *   - `binary` must match /^[a-zA-Z0-9._-]+$/ (no path separators or metachars).
 *   - `envPrefixes` entries must match /^[A-Z][A-Z0-9_]*_$/.
 *   - `argSpec` values are allowlist-validated at spawn time via the regex on each
 *     flag (they reach `bash -c` as part of the command string).
 *   - A malformed overlay entry is DROPPED with a warning; it never crashes boot.
 *
 * @module config/cli-registry
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod/v4';
import { dataPath } from './instance.js';
import DEFAULT_REGISTRY from './cli-registry.default.json';

// ============================================================================
// Types
// ============================================================================

/**
 * How the local-echo overlay should behave for this CLI.
 *   'buffer'  — standard buffer-until-Enter overlay (most CLIs)
 *   'predict' — write-through predictive overlay (Codex, keystroke-reactive TUIs)
 *   'none'    — no overlay (shell mode handles its own echo)
 */
export type EchoPolicy = 'buffer' | 'predict' | 'none';

/**
 * How the terminal scrollback strip should handle this CLI's sequences.
 *   'full'   — strip alt-screen, 3J, and mouse-tracking DECSETs (Ink/React TUIs)
 *   'narrow' — strip alt-screen toggles only (tmux-backed, non-Ink CLIs)
 *   'none'   — no stripping (direct-PTY shell sessions)
 */
export type TerminalStripMode = 'full' | 'narrow' | 'none';

/**
 * Declarative spec for a CLI flag whose value comes from the session config.
 * Used by the generic spawn-command builder for external CLIs.
 */
export interface CliArgSpec {
  /** CLI flag string, e.g. '--model' */
  flag: string;
  /** Name of the field in the per-CLI config object */
  configKey: string;
  /** Regex allowlist — value dropped (never injected) if it fails */
  allowPattern: RegExp;
  /** When true, flag is emitted as `--flag` with no value (boolean flag) */
  booleanFlag?: boolean;
  /** Literal values to append after the flag value (e.g. '--skip-trust') */
  prefix?: string;
}

/**
 * How the resume flag is appended when re-creating a docker pane.
 */
export interface ResumeSpec {
  /** CLI flag for resume, e.g. '--resume' or '--conversation' */
  flag: string;
  /** 'after' = `command --flag <id>`, 'subcommand' = `command subcommand <id>` */
  position: 'after' | 'subcommand';
}

/** A single CLI backend entry. */
export interface CliRegistryEntry {
  /** Unique mode id — becomes a `SessionMode` value */
  id: string;

  /** Display name, e.g. 'GitHub Copilot' */
  label: string;

  /** 2-char tab badge, e.g. 'co' */
  shortBadge: string;

  /** The binary name to run, e.g. 'gemini'. No path separators. */
  binary: string;

  /** Directories to search when `which <binary>` fails */
  searchDirs: string[];

  /** Env var prefixes to add to ALLOWED_ENV_PREFIXES for this CLI */
  envPrefixes: string[];

  /**
   * Exact env var keys to add to ALLOWED_ENV_KEYS (rare; only for special keys
   * like CLAUDE_CONFIG_DIR that have no natural prefix).
   */
  envExactKeys?: string[];

  // ── Capability flags ─────────────────────────────────────────────────────

  /** True for non-Claude external-TUI CLIs (gates Claude-specific behaviour) */
  isExternalCli: boolean;

  /** Whether terminal sequences should be stripped for this mode */
  stripMode: TerminalStripMode;

  /** Must run under tmux (no direct-PTY fallback) */
  muxRequired: boolean;

  /** Whether to export COLORTERM=truecolor for this CLI */
  colorterm: boolean;

  /** Local-echo overlay policy */
  echoPolicy: EchoPolicy;

  /** Whether this CLI fires Codeman hooks (stop/blocked signals) */
  hooksAvailable: boolean;

  /** Whether respawn/ralph/cron/orchestrator features apply */
  supportsRespawn: boolean;

  /** Whether wheel/touch scroll forwarding applies (requires version check per CLAUDE.md) */
  supportsScrollForward?: boolean;

  // ── Spawn / resume ───────────────────────────────────────────────────────

  /**
   * Declarative flag specs for the generic spawn-command builder.
   * Not used for `claude` or `shell` (they have bespoke builders).
   */
  argSpec?: CliArgSpec[];

  /**
   * Static flags that are always prepended to the command (e.g. '--skip-trust').
   * Applied before argSpec.
   */
  staticArgs?: string[];

  /** Resume flag shape for docker pane re-creation */
  resumeSpec?: ResumeSpec;

  // ── UI ───────────────────────────────────────────────────────────────────

  /** CSS color for the tab dot and run-button gradient, e.g. '#8ab4f8' */
  color?: string;

  /**
   * Short label for the Run button in the toolbar, e.g. 'Run GM'.
   * Falls back to `Run ${id.toUpperCase().slice(0,2)}` when absent.
   */
  runButtonLabel?: string;

  /**
   * Prompt-row detection style for the local-echo overlay.
   *   'default' — look for a ❯/› character on the last rows (Claude, most CLIs)
   *   'opencode' — look for a ┃ border character (OpenCode Bubble Tea TUI)
   */
  promptStyle?: 'default' | 'opencode';

  /** Maximum bytes read per terminal frame; defaults to 65536. Codex uses 32768. */
  maxFrameBytes?: number;
}

// ============================================================================
// Entry schema + loader
// ============================================================================

/** Expand a leading ~ to the real home directory (JSON files can't call homedir()). */
function expandTilde(p: string): string {
  const home = homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

type RawArgSpec = { flag: string; configKey: string; allowPattern: string; booleanFlag?: boolean; prefix?: string };

function parseEntries(obj: unknown, source: string): CliRegistryEntry[] {
  const result = OverlaySchema.safeParse(obj);
  if (!result.success) {
    console.warn(`[CliRegistry] ${source} failed schema validation — skipped:`, result.error.message);
    return [];
  }
  return result.data.entries.map((entry) => {
    const argSpec = (entry.argSpec as RawArgSpec[] | undefined)?.map((s) => ({
      ...s,
      allowPattern: new RegExp(s.allowPattern),
    }));
    const searchDirs = (entry.searchDirs ?? []).map(expandTilde);
    return { ...entry, argSpec, searchDirs } as CliRegistryEntry;
  });
}

function loadFromFile(filePath: string): CliRegistryEntry[] | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    // ENOENT = file simply doesn't exist yet; any other error is unexpected
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[CliRegistry] Could not read ${filePath}:`, (err as Error).message);
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[CliRegistry] ${filePath} is not valid JSON — falling back to default`);
    return null;
  }
  return parseEntries(parsed, filePath);
}

const CliArgSpecSchema = z.object({
  flag: z.string().max(60).regex(/^--?[a-zA-Z][a-zA-Z0-9-]*$/),
  configKey: z.string().max(60).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  allowPattern: z.string().max(200),
  booleanFlag: z.boolean().optional(),
  prefix: z.string().max(100).optional(),
});

const ResumeSpecSchema = z.object({
  flag: z.string().max(60),
  position: z.enum(['after', 'subcommand']),
});

/** Schema for a single overlay entry. Binary must be a plain name with no metachars. */
const OverlayEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1).max(80),
    shortBadge: z.string().max(4),
    binary: z.string().max(60).regex(/^[a-zA-Z0-9._-]*$/),
    searchDirs: z.array(z.string().max(300)).max(20).default([]),
    envPrefixes: z
      .array(
        z
          .string()
          .max(60)
          .regex(/^[A-Z][A-Z0-9_]*_$/)
      )
      .max(10)
      .default([]),
    envExactKeys: z
      .array(
        z
          .string()
          .max(60)
          .regex(/^[A-Z_][A-Z0-9_]*$/)
      )
      .max(5)
      .optional(),
    isExternalCli: z.boolean().default(true),
    stripMode: z.enum(['full', 'narrow', 'none']).default('narrow'),
    muxRequired: z.boolean().default(true),
    colorterm: z.boolean().default(true),
    echoPolicy: z.enum(['buffer', 'predict', 'none']).default('buffer'),
    hooksAvailable: z.boolean().default(false),
    supportsRespawn: z.boolean().default(false),
    supportsScrollForward: z.boolean().optional(),
    argSpec: z.array(CliArgSpecSchema).max(20).optional(),
    staticArgs: z.array(z.string().max(80)).max(10).optional(),
    resumeSpec: ResumeSpecSchema.optional(),
    color: z
      .string()
      .max(30)
      .regex(/^#[0-9a-fA-F]{3,8}$|^[a-z]+$/)
      .optional(),
    runButtonLabel: z.string().max(20).optional(),
    promptStyle: z.enum(['default', 'opencode']).optional(),
    maxFrameBytes: z.number().int().min(1024).max(1048576).optional(),
  })
  .strict();

const OverlaySchema = z.object({
  entries: z.array(OverlayEntrySchema).max(50),
});

// ============================================================================
// Registry singleton
// ============================================================================

let _registry: CliRegistryEntry[] | null = null;

/**
 * Return the active registry, loaded once.
 * ~/.codeman/cli-registry.json is the complete source of truth when present.
 * When absent, falls back to the default config shipped with the app.
 */
export function getCliRegistry(): CliRegistryEntry[] {
  if (_registry) return _registry;
  const fromFile = loadFromFile(dataPath('cli-registry.json'));
  _registry = fromFile ?? parseEntries(DEFAULT_REGISTRY, 'bundled default');
  return _registry;
}

/** Look up a single entry by id, or null if unknown. */
export function getCliEntry(id: string): CliRegistryEntry | null {
  return getCliRegistry().find((e) => e.id === id) ?? null;
}

/**
 * Return derived env-prefix allowlist from all registered entries.
 * Used by schemas.ts to keep ALLOWED_ENV_PREFIXES in sync.
 */
export function getAllowedEnvPrefixes(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of getCliRegistry()) {
    for (const p of entry.envPrefixes) {
      if (!seen.has(p)) {
        seen.add(p);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Return derived exact-key allowlist from all registered entries.
 * Used by schemas.ts alongside ALLOWED_ENV_KEYS.
 */
export function getAllowedEnvExactKeys(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of getCliRegistry()) {
    for (const k of entry.envExactKeys ?? []) {
      if (!seen.has(k)) {
        seen.add(k);
        result.push(k);
      }
    }
  }
  return result;
}

/** Return all registered ids as a readonly array (suitable for `z.enum`). */
export function getRegisteredIds(): string[] {
  return getCliRegistry().map((e) => e.id);
}

// ============================================================================
// Capability predicates (replace hardcoded helpers in session.ts etc.)
// ============================================================================

export function isExternalCliMode(id: string): boolean {
  return getCliEntry(id)?.isExternalCli ?? false;
}

export function isAltScreenStripMode(id: string): boolean {
  return (getCliEntry(id)?.stripMode ?? 'none') === 'full';
}

export function isMuxAltScreenOnlyStripMode(id: string, useMux: boolean): boolean {
  if (!useMux) return false;
  const entry = getCliEntry(id);
  if (!entry) return false;
  return entry.stripMode === 'narrow' || (entry.stripMode === 'full' ? false : false);
}

export function needsColorterm(id: string): boolean {
  return getCliEntry(id)?.colorterm ?? false;
}

export function hooksAvailableForMode(id: string): boolean {
  return getCliEntry(id)?.hooksAvailable ?? false;
}

export function getModeLabel(id: string): string {
  return getCliEntry(id)?.label ?? id;
}

export function getEchoPolicy(id: string): EchoPolicy {
  return getCliEntry(id)?.echoPolicy ?? 'buffer';
}

export function getResumeSpec(id: string): ResumeSpec | undefined {
  return getCliEntry(id)?.resumeSpec;
}

export function getPromptStyle(id: string): 'default' | 'opencode' {
  return getCliEntry(id)?.promptStyle ?? 'default';
}

export function getMaxFrameBytes(id: string): number {
  return getCliEntry(id)?.maxFrameBytes ?? 65536;
}

/** Public shape returned by GET /api/cli-registry (no security-sensitive fields) */
export interface CliRegistryPublicEntry {
  id: string;
  label: string;
  shortBadge: string;
  isExternalCli: boolean;
  echoPolicy: EchoPolicy;
  stripMode: TerminalStripMode;
  hooksAvailable: boolean;
  supportsRespawn: boolean;
  supportsScrollForward: boolean;
  color: string;
  runButtonLabel: string;
  promptStyle: 'default' | 'opencode';
  maxFrameBytes: number;
}

/** Return the public (frontend-safe) shape for all entries. */
export function getPublicRegistry(): CliRegistryPublicEntry[] {
  return getCliRegistry().map((e) => ({
    id: e.id,
    label: e.label,
    shortBadge: e.shortBadge,
    isExternalCli: e.isExternalCli,
    echoPolicy: e.echoPolicy,
    stripMode: e.stripMode,
    hooksAvailable: e.hooksAvailable,
    supportsRespawn: e.supportsRespawn,
    supportsScrollForward: e.supportsScrollForward ?? false,
    color: e.color ?? '#6b7280',
    runButtonLabel: e.runButtonLabel ?? `Run ${e.id.toUpperCase().slice(0, 2)}`,
    promptStyle: e.promptStyle ?? 'default',
    maxFrameBytes: e.maxFrameBytes ?? 65536,
  }));
}
