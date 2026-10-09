import {Effect} from 'effect';
import {handleManagerLinearIntegrationRequest, listLinearIntegrations} from '@threadnote/integration-linear/manager';
import type {ManagerIntegrationApiRequest} from '@threadnote/integration-core/manager-http';
import {integrationFeatureError} from '@threadnote/integration-core/manager-http';
import {
  handleManagerObsidianIntegrationRequest,
  listObsidianIntegrations,
} from '@threadnote/integration-obsidian/manager';
import {handleManagerPocketIntegrationRequest, listPocketIntegrations} from '@threadnote/integration-pocket/manager';
import {
  handleManagerSuperhumanIntegrationRequest,
  listSuperhumanIntegrations,
} from '@threadnote/integration-superhuman/manager';
import {handleManagerGitHubIntegrationRequest, listGitHubIntegrations} from '@threadnote/integration-github/manager';

const routeManagerIntegration = Effect.fn('manager.integrations')(function* (request: ManagerIntegrationApiRequest) {
  if (request.url.pathname === '/api/integrations/linear') return yield* handleManagerLinearIntegrationRequest(request);
  if (request.url.pathname === '/api/integrations/superhuman')
    return yield* handleManagerSuperhumanIntegrationRequest(request);
  if (request.url.pathname === '/api/integrations/pocket') return yield* handleManagerPocketIntegrationRequest(request);
  if (request.url.pathname === '/api/integrations/github') return yield* handleManagerGitHubIntegrationRequest(request);
  if (request.url.pathname !== '/api/integrations') return yield* handleManagerObsidianIntegrationRequest(request);
  if (request.method !== 'GET') return {status: 405, body: {error: 'Method not allowed'}};
  return yield* Effect.gen(function* () {
    const obsidian = yield* listObsidianIntegrations(request.config);
    const superhuman = yield* listSuperhumanIntegrations(request.config);
    const pocket = yield* listPocketIntegrations(request.config);
    const linear = yield* listLinearIntegrations(request.config);
    const github = yield* listGitHubIntegrations(request.config);
    return {
      status: 200,
      body: {
        obsidian,
        superhuman,
        pocket,
        linear,
        github,
      },
    };
  }).pipe(Effect.catchCause(() => Effect.succeed({status: 409, body: {error: 'Connections could not be loaded.'}})));
});

export const handleManagerIntegrationRequest = (request: ManagerIntegrationApiRequest) =>
  routeManagerIntegration(request).pipe(Effect.catchCause(integrationFeatureError));
