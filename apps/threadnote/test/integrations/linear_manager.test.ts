import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {handleManagerIntegrationRequest} from '@threadnote/threadnote/integrations/manager';
import {handleManagerLinearIntegrationRequest} from '@threadnote/integration-linear/manager';
import {runLinearSourceSync} from '@threadnote/integration-linear/source';
import {loadExternalResourceAccess} from '@threadnote/store/external-resource';
import {readSourceConfiguration} from '@threadnote/threadnote/integrations/config';
import {provideLayer} from './linear-layer.js';
import {safeFetch, source} from './linear-fixtures.js';
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
describe('Linear Manager backend composition', () => {
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
});
