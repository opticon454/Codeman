/**
 * @fileoverview Thin shim — delegates to generic-cli-resolver.
 * @module utils/antigravity-cli-resolver
 */

import { resolveCliDir, isCliAvailable } from './generic-cli-resolver.js';

export const resolveAntigravityDir = (): string | null => resolveCliDir('antigravity');
export const isAntigravityAvailable = (): boolean => isCliAvailable('antigravity');
