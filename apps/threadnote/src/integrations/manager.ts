import {Effect} from 'effect';
import {handleManagerLinearIntegrationRequest, listLinearIntegrations} from './linear/manager.js';
import type {ManagerProcessApiRequest} from '../manager/processes.js';
import {managerFeatureError} from '../manager/feature_errors.js';
import {isObsidianSource, readSourceConfiguration} from './config.js';
import {handleManagerObsidianIntegrationRequest} from './obsidian/manager.js';
import {handleManagerPocketIntegrationRequest, listPocketIntegrations} from './pocket/manager.js';
import {handleManagerSuperhumanIntegrationRequest, listSuperhumanIntegrations} from './superhuman/manager.js';

const routeManagerIntegration = Effect.fn('manager.integrations')(function* (request: ManagerProcessApiRequest) {
  if (request.url.pathname === '/api/integrations/linear') return yield* handleManagerLinearIntegrationRequest(request);
  if (request.url.pathname === '/api/integrations/superhuman')
    return yield* handleManagerSuperhumanIntegrationRequest(request);
  if (request.url.pathname === '/api/integrations/pocket') return yield* handleManagerPocketIntegrationRequest(request);
  if (request.url.pathname !== '/api/integrations') return yield* handleManagerObsidianIntegrationRequest(request);
  if (request.method !== 'GET') return {status: 405, body: {error: 'Method not allowed'}};
  return yield* Effect.gen(function* () {
    const configuration = yield* readSourceConfiguration(request.config);
    const superhuman = yield* listSuperhumanIntegrations(request.config);
    const pocket = yield* listPocketIntegrations(request.config);
    const linear = yield* listLinearIntegrations(request.config);
    return {
      status: 200,
      body: {
        obsidian: {sources: configuration.sources.filter(isObsidianSource), projections: configuration.projections},
        superhuman,
        pocket,
        linear,
      },
    };
  }).pipe(Effect.catchCause(() => Effect.succeed({status: 409, body: {error: 'Connections could not be loaded.'}})));
});

export const handleManagerIntegrationRequest = (request: ManagerProcessApiRequest) =>
  routeManagerIntegration(request).pipe(Effect.catchCause(managerFeatureError));
