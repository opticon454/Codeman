/**
 * @fileoverview Should this launch start with the CLI's own remote control on?
 *
 * A registry entry that declares `capabilities.launchRemoteControl` names a synced, default-OFF App
 * Settings switch. When it is on, a LOCAL launch gets the flag, so the vendor's phone or web client
 * (a relay over outbound connections, which keeps working where this Codeman is unreachable behind a
 * firewall or DNS) can drive the session. Read fresh on every spawn, so a toggle applies to the next
 * launch; running sessions are never touched. Remote and Docker launches never get it: those CLIs
 * run elsewhere, under another account's network and sign-in.
 *
 * @module launch-remote-control
 */

import { getCli } from './config/cli-registry/registry.js';
import { readJsonConfig, SETTINGS_PATH } from './web/route-helpers.js';

export async function readLaunchRemoteControl(mode: string, remoteOrDocker: boolean): Promise<boolean> {
  const declared = getCli(mode)?.capabilities.launchRemoteControl;
  if (!declared || remoteOrDocker) return false;
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return settings[declared.setting] === true;
}
