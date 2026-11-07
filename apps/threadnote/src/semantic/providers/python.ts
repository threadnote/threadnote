import * as EffectString from 'effect/String';
import {Effect} from 'effect';
import type {LspClient} from '../lsp_transport.js';
import {makeLspSession, type LspSessionOptions} from '../provider.js';
export {makeSemanticNotifications as makePythonNotifications} from '../provider.js';
export interface PythonSessionOptions extends Omit<LspSessionOptions, 'policy' | 'ready'> {
  readonly environmentReady: LspSessionOptions['ready'];
}
/** Python policy over the shared versioned, read-only LSP session. */
export const makePythonSession = Effect.fn('semantic.makePythonSession')(function* (
  client: LspClient,
  options: PythonSessionOptions,
) {
  return yield* makeLspSession(client, {
    ...options,
    ready: options.environmentReady,
    policy: {
      language: 'python',
      editSourceQualification: 'versioned-diagnostics-foreground-v1',
      workspaceName: 'semantic-python-project',
      acceptsServer: server =>
        server?.version === '1.40.2' && EffectString.includes('basedpyright')(EffectString.toLowerCase(server.name)),
      limitations: [
        'Experimental Python static-environment profile',
        'Selected project and verified static dependencies only',
        'Interpreter execution, import hooks, commands and dependency acquisition disabled',
      ],
    },
  });
});
