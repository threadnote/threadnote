import {Effect} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {commandLauncherPath} from '../command-shim.js';

// Shared by surface planning and the installer; importing this must not load
// setup orchestration or the adapter catalog it is still constructing.
export const mcpAdapterCommand = Effect.fn('mcp.adapterCommand')(function* () {
  const system = yield* SystemInfo;
  const launcher = yield* commandLauncherPath('mcp');
  if (system.platform === 'win32') {
    const comSpec = system.environment().ComSpec ?? system.environment().COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
    return [comSpec, '/d', '/c', launcher];
  }
  return [launcher];
});
