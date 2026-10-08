import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {handleManagerIntegrationRequest} from '../../manager.js';
import {handleManagerLinearIntegrationRequest, resolveLinearSelection} from '../manager.js';
import {runLinearSourceAdd, runLinearSourceSync} from '../source.js';
import {loadExternalResourceAccess} from '@threadnote/store/external-resource';
import {readSourceConfiguration} from '../../config.js';
import {Redacted} from 'effect';
import {provideLayer} from './layer.js';
import {issue, response, safeFetch, source, uuid} from './fixtures.js';
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'linear-manager-'}));
  return {config: {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig};
});
const body = {
  ...source,
  action: 'save-source',
  token: 'synthetic-linear-private-key',
  credentialEnv: undefined,
  apply: true,
  confirm: true,
  editing: false,
};
const request = (
  config: RuntimeConfig,
  body: Record<string, unknown> = {},
  method = 'POST',
  path = '/api/integrations/linear',
) => ({config, body: Effect.succeed(body), method, url: new URL(`http://localhost${path}`)});
describe('Linear Manager backend contract', () => {
  effectIt.effect('saves protected credentials and returns safe counters through provider and aggregate routes', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const saved = yield* handleManagerLinearIntegrationRequest(request(config, body));
      expect(saved?.status).toBe(200);
      const provider = yield* handleManagerIntegrationRequest(request(config, {}, 'GET'));
      expect(provider?.status).toBe(200);
      const content = JSON.stringify(provider?.body);
      expect(content).toContain('credentialConfigured');
      expect(content).toContain('needs-sync');
      expect(content).not.toContain('synthetic-linear-private-key');
      const aggregate = yield* handleManagerIntegrationRequest(request(config, {}, 'GET', '/api/integrations'));
      expect(aggregate?.status).toBe(200);
      expect(JSON.stringify(aggregate?.body)).toContain('linear');
      yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: safeFetch}});
      const location = {home: config.agentContextHome, account: config.account, user: config.user};
      expect(Object.keys(yield* loadExternalResourceAccess(location))).not.toEqual([]);
      const paused = yield* handleManagerLinearIntegrationRequest(
        request(config, {action: 'set-enabled', id: source.id, enabled: false, apply: true, confirm: true}),
      );
      expect(paused?.status).toBe(200);
      expect((yield* readSourceConfiguration(config)).sources[0]?.enabled).toBe(false);
      yield* handleManagerLinearIntegrationRequest(
        request(config, {action: 'set-enabled', id: source.id, enabled: true, apply: true, confirm: true}),
      );
      expect(Object.keys(yield* loadExternalResourceAccess(location))).toEqual([]);
      expect(
        (yield* handleManagerLinearIntegrationRequest(
          request(config, {action: 'remove-source', id: source.id, apply: true, confirm: true}),
        ))?.status,
      ).toBe(200);
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('requires applied-action confirmation and avoids implicit projectless or empty scope saves', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      for (const delta of [
        {confirm: false},
        {project: null},
        {teamIds: []},
        {issueIds: [], projectIds: []},
        {organizationId: 'name'},
      ]) {
        const result = yield* handleManagerLinearIntegrationRequest(request(config, {...body, ...delta}));
        expect(result?.status).not.toBe(200);
      }
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
      expect((yield* handleManagerLinearIntegrationRequest(request(config, {}, 'DELETE')))?.status).toBe(405);
    }).pipe(TestClock.withLive, provideLayer),
  );
  effectIt.effect('resolves only explicit IDs using existing local credentials and validates bound identity', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      yield* runLinearSourceAdd(config, {
        ...source,
        apiToken: Redacted.make('synthetic-linear-private-key'),
        apply: true,
      });
      const selection = yield* resolveLinearSelection(
        config,
        {id: source.id, teamIds: source.teamIds, issueIds: source.issueIds, projectIds: []},
        {fetch: safeFetch},
      );
      expect(selection.organizationId).toBe(source.organizationId);
      expect(selection.principalId).toBe(source.principalId);
      expect(selection.teams).toEqual([{id: uuid(3), name: 'Synthetic team'}]);
      expect(selection.issues).toEqual([
        {id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url, teamId: issue.team.id},
      ]);
      const mismatch = yield* resolveLinearSelection(
        config,
        {id: source.id, organizationId: uuid(999), teamIds: source.teamIds, issueIds: source.issueIds, projectIds: []},
        {fetch: safeFetch},
      ).pipe(Effect.exit);
      expect(mismatch._tag).toBe('Failure');
      const rejected = yield* resolveLinearSelection(
        config,
        {id: source.id, teamIds: source.teamIds, issueIds: source.issueIds, projectIds: []},
        {fetch: async () => response({}, 401)},
      ).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      expect(JSON.stringify(rejected)).not.toContain('synthetic-linear-private-key');
    }).pipe(TestClock.withLive, provideLayer),
  );
});
