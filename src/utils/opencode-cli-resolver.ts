/**
 * @fileoverview Thin shim — delegates to generic-cli-resolver.
 * @module utils/opencode-cli-resolver
 */

import { resolveCliDir, isCliAvailable } from './generic-cli-resolver.js';

export const resolveOpenCodeDir = (): string | null => resolveCliDir('opencode');
export const isOpenCodeAvailable = (): boolean => isCliAvailable('opencode');
