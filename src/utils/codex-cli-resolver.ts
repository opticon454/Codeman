/**
 * @fileoverview Thin shim — delegates to generic-cli-resolver.
 * @module utils/codex-cli-resolver
 */

import { resolveCliDir, isCliAvailable } from './generic-cli-resolver.js';

export const resolveCodexDir = (): string | null => resolveCliDir('codex');
export const isCodexAvailable = (): boolean => isCliAvailable('codex');
