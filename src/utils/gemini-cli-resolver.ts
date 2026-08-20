/**
 * @fileoverview Thin shim — delegates to generic-cli-resolver.
 * @module utils/gemini-cli-resolver
 */

import { resolveCliDir, isCliAvailable } from './generic-cli-resolver.js';

export const resolveGeminiDir = (): string | null => resolveCliDir('gemini');
export const isGeminiAvailable = (): boolean => isCliAvailable('gemini');
