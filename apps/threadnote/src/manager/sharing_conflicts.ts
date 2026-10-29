import {Effect} from 'effect';
import {listShareConflicts, showShareConflict, resolveShareConflict} from '../effect/share.js';
import {resolveTeam, shareTeamAccess} from '../share/core.js';
import {requireConfirm, requireString, requiredQuery} from '@threadnote/manager/request_inputs';
import type {SharingConflictDetail} from '@threadnote/manager/sharing-contracts';
import type {ManagerProcessApiRequest} from './processes.js';
import {managerFeatureError} from './feature_errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const routeManagerSharingConflicts = Effect.fn('manager.sharingConflicts')(function* (
  request: ManagerProcessApiRequest,
) {
  const path = request.url.pathname;
  if (path !== '/api/shares/conflicts' && !Effect2.pipe(path, EffectString.startsWith('/api/shares/conflicts/')))
    return undefined;
  if (request.method === 'GET' && path === '/api/shares/conflicts') {
    return {status: 200, body: {conflicts: yield* listShareConflicts(request.config, {})}};
  }
  if (request.method === 'GET' && path === '/api/shares/conflicts/detail') {
    const detail = yield* showShareConflict(request.config, requiredQuery(request.url, 'id'), {});
    const team = yield* resolveTeam(request.config, detail.team);
    const readOnly = shareTeamAccess(team.config) === 'read-only';
    const body: SharingConflictDetail = {
      ...detail,
      readOnly,
      canKeepLocal: !readOnly && detail.hasLocalContent,
      canUseShared:
        detail.identityConflict !== 'changed' &&
        (detail.status === 'removed' || detail.hasSharedContent) &&
        !(readOnly && detail.identityConflict === 'missing'),
      canMerge: !readOnly && (detail.hasLocalContent || detail.hasSharedContent),
    };
    return {status: 200, body};
  }
  if (request.method === 'POST' && path === '/api/shares/conflicts/resolve') {
    const body = yield* request.body;
    requireConfirm(body);
    const resolution = requireString(body.resolution, 'resolution');
    if (resolution === 'manual' || resolution === 'local' || resolution === 'shared') {
      const id = requireString(body.id, 'conflict');
      const expectedRevision = requireString(body.revision, 'reviewed revision');
      if (resolution === 'manual') {
        const result = yield* resolveShareConflict(request.config, id, {
          expectedRevision,
          mergedContent: requireString(body.content, 'merged content'),
        });
        return {status: 200, body: result};
      }
      const result = yield* resolveShareConflict(request.config, id, {expectedRevision, take: resolution});
      return {status: 200, body: result};
    }
    return {status: 400, body: {error: 'Choose local, shared, or manual resolution.'}};
  }
  return {status: 404, body: {error: 'Not found'}};
});

export const handleManagerSharingConflictRequest = (request: ManagerProcessApiRequest) =>
  routeManagerSharingConflicts(request).pipe(Effect.catchCause(managerFeatureError));
