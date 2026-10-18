/**
 * @fileoverview Codex remote control (src/codex-remote-control.ts).
 *
 * POST /api/codex-remote-control/:action — `start`, `stop` or `pair` (see `codex remote-control --help`).
 *
 * Opt-in: `start` and `pair` answer 403 until `codexRemoteControlEnabled` is on (default OFF), because
 * they let another device drive Codex on this machine. `stop` is never gated, so turning the setting
 * off cannot strand a running daemon. The server user's Codex is the one controlled, so in multi-user
 * mode every action is admin only. A second command while one runs answers 409. `pair` returns a
 * short-lived pairing code in `output`; nothing here logs it.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { isAdmin, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getCodexNotFoundMessage, resolveCodexBinaryPath } from '../../utils/codex-cli-resolver.js';
import {
  CODEX_REMOTE_CONTROL_ACTIONS,
  CodexRemoteControlBusyError,
  CodexRemoteControlFailedError,
  runCodexRemoteControl,
  type CodexRemoteControlAction,
  type CodexRemoteControlResult,
} from '../../codex-remote-control.js';

/** Default OFF, read fresh so a toggle applies at once. */
export async function readCodexRemoteControlEnabled(): Promise<boolean> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return settings.codexRemoteControlEnabled === true;
}

export function registerCodexRemoteControlRoutes(app: FastifyInstance): void {
  app.post('/api/codex-remote-control/:action', async (req, reply): Promise<ApiResponse<CodexRemoteControlResult>> => {
    const { action } = req.params as { action: string };
    if (!(CODEX_REMOTE_CONTROL_ACTIONS as readonly string[]).includes(action)) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Action must be start, stop or pair');
    }
    if (isMultiUserMode() && !isAdmin(req)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
    }
    if (action !== 'stop' && !(await readCodexRemoteControlEnabled())) {
      reply.code(403);
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Codex remote control is disabled. Turn on "Allow Codex remote control" in Settings and save first.'
      );
    }
    const binary = resolveCodexBinaryPath();
    if (!binary) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, getCodexNotFoundMessage());
    }
    try {
      return { success: true, data: await runCodexRemoteControl(action as CodexRemoteControlAction, binary) };
    } catch (err) {
      if (err instanceof CodexRemoteControlBusyError) {
        reply.code(409);
        return createErrorResponse(ApiErrorCode.CONFLICT, err.message);
      }
      reply.code(err instanceof CodexRemoteControlFailedError ? 502 : 500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });
}
