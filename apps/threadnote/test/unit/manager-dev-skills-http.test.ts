import {it as effectIt} from '@effect/vitest';
import {BunHttpServer} from '@effect/platform-bun';
import {Context, Effect, Layer, Schema, Scope} from 'effect';
import {HttpClient, HttpClientRequest, HttpServer} from 'effect/http';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {TestError} from '@threadnote/testing/test-error';
import type {
  ManagerDevSkillsApplyResponse,
  ManagerDevSkillsCatalog,
  ManagerDevSkillsPlan,
  ManagerDevSkillsProjects,
  ManagerDevSkillsSelector,
  ManagerDevSkillsStatus,
} from '@threadnote/manager/dev-skills/contracts';
import {createManagerServer} from '../../src/manager/server.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  applyDevSkills,
  ensureDevSkills,
  previewDevSkills,
  statusDevSkills,
  previewDevSkillsRefresh,
  prepareDevSkillsRefresh,
  runDevSkillsRefresh,
} from '../../src/dev_skills/index.js';
import {fixture, snapshot, devSkillsReleaseFixture} from '../dev-skills/service-fixture.js';
import {receiptPath} from '../../src/dev_skills/registry.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const token = 'isolated-workflow-http-token';
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(ApplicationLayer));
// This is the actual application HTTP/auth dispatcher, so its application service
// union is intentional. Host paths, runtime root and bundle source are isolated.
const serve = Effect.fn('test.managerDevSkills.serve')(function* (f: Fixture, run: Fixture['run'] = f.run) {
  const services = yield* Layer.build(BunHttpServer.layerTest);
  const server = Context.get(services, HttpServer.HttpServer);
  const scope = yield* Scope.Scope;
  yield* run(server.serve(createManagerServer({config: f.config, jobs: new Map(), token, worksetScope: scope})));
  if (server.address._tag === 'UnixPathAddress')
    return yield* TestError.make({message: 'Expected an isolated TCP server'});
  const origin = `http://127.0.0.1:${server.address.port}`;
  const request = <A = Record<string, unknown>>(route: string, body?: unknown, authenticated = true) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const outgoing =
        body === undefined
          ? HttpClientRequest.get(`${origin}${route}`)
          : yield* HttpClientRequest.bodyJson(HttpClientRequest.post(`${origin}${route}`), body);
      const response = yield* client.execute(
        outgoing.pipe(HttpClientRequest.setHeaders(authenticated ? {Authorization: `Bearer ${token}`} : {})),
      );
      return {status: response.status, body: (yield* response.json) as A};
    });
  const preview = (action: 'install' | 'update' | 'remove', selector: ManagerDevSkillsSelector) =>
    request<ManagerDevSkillsPlan>('/api/dev-skills/preview', {action, selector});
  const apply = (plan: ManagerDevSkillsPlan, selector: ManagerDevSkillsSelector) =>
    request<ManagerDevSkillsApplyResponse>('/api/dev-skills/apply', {
      action: plan.action,
      selector,
      previewDigest: plan.previewDigest,
      confirm: true,
    });
  return {request, preview, apply};
});
const statusPath = (selector: ManagerDevSkillsSelector) =>
  `/api/dev-skills/status?${new URLSearchParams(Object.entries(selector).filter((pair): pair is [string, string] => pair[1] !== undefined))}`;
const register = (f: Fixture, paths: readonly string[]) =>
  Effect.gen(function* () {
    yield* f.fs.makeDirectory(f.home, {recursive: true});
    yield* f.fs.writeFileString(
      f.config.manifestPath,
      JSON.stringify({
        version: 1,
        projects: paths.map((path, index) => ({
          name: `project-${index}`,
          path,
          uri: `threadnote://resources/project-${index}`,
          seed: [],
        })),
      }),
    );
  });

describe('authenticated Manager development workflows HTTP', () => {
  for (const [agent, layout] of [
    ['codex-cli', 'directory'],
    ['antigravity-cli', 'flat'],
  ] as const) {
    effectIt.effect(`${layout} lifecycle matches the service and preserves edited/extra files`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const server = yield* serve(f);
        const selector = {agent};
        const before = yield* snapshot(f.root);
        const catalog = yield* server.request<ManagerDevSkillsCatalog>('/api/dev-skills/catalog');
        expect(catalog.status).toBe(200);
        expect(catalog.body.platform).toBe(f.system.platform);
        expect(catalog.body.surfaces.find(item => item.surfaceId === 'codex-cloud')).toMatchObject({
          profile: 'codex-cloud-personal',
          platforms: ['linux'],
        });
        const preview = yield* server.preview('install', selector);
        expect(preview.status).toBe(200);
        expect(preview.body).toEqual(
          yield* f.run(previewDevSkills(f.config, 'install', selector, {reinstallMissingStore: true})),
        );
        expect(preview.body.canApply).toBe(true);
        expect(preview.body.readiness?.planning.state).toBe('blocked');
        expect((yield* server.request(statusPath(selector))).status).toBe(200);
        expect(yield* snapshot(f.root)).toEqual(before);
        const installed = yield* server.apply(preview.body, selector);
        expect(installed.status).toBe(200);
        expect(installed.body.status.targets[0]).toMatchObject({
          enabled: true,
          enrolled: true,
          installationState: 'current',
          target: {layout},
        });
        expect(installed.body.status).toEqual(yield* f.run(statusDevSkills(f.config, selector)));
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const updatedServer = yield* serve(f, release.run);
        const update = yield* updatedServer.preview('update', selector);
        expect(update.body.bundleDigest).toBe(release.bundle.manifest.digest);
        expect(
          (yield* updatedServer.apply(update.body, selector)).body.status.targets[0].installed?.releaseVersion,
        ).toBe('5.3.0-beta.5');
        const root = installed.body.result.target.skillRoot;
        const entry = f.path.join(root, layout === 'flat' ? 'dev-plan.md' : 'dev-plan/SKILL.md');
        yield* f.fs.writeFileString(entry, 'user-edited discovery content');
        const extra = f.path.join(root, 'user-extra.txt');
        yield* f.fs.writeFileString(extra, 'unowned');
        const removal = yield* updatedServer.preview('remove', selector);
        const removed = yield* updatedServer.apply(removal.body, selector);
        expect(removed.status).toBe(200);
        expect(removed.body.result.retainedPaths).toContain(entry);
        expect(removed.body.status.targets[0]).toMatchObject({enabled: false, enrollmentState: 'removed'});
        expect(yield* f.fs.readFileString(entry)).toBe('user-edited discovery content');
        expect(yield* f.fs.readFileString(extra)).toBe('unowned');
        expect(
          yield* f.fs.exists(f.path.join(root, '.threadnote-dev-skills/generations', preview.body.bundleDigest)),
        ).toBe(true);
      }).pipe(provide),
    );
  }
  effectIt.effect(
    'rejects unauthorized, malformed and unconfirmed requests without creating any filesystem state',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const server = yield* serve(f);
        const before = yield* snapshot(f.root);
        for (const route of [
          '/api/dev-skills/catalog',
          '/api/dev-skills/projects',
          '/api/dev-skills/status?agent=codex',
        ])
          expect((yield* server.request(route, undefined, false)).status).toBe(401);
        expect(
          (yield* server.request(
            '/api/dev-skills/apply',
            {action: 'install', selector: {agent: 'codex'}, previewDigest: 'a'.repeat(64), confirm: true},
            false,
          )).status,
        ).toBe(401);
        for (const body of [
          {action: ['install'], selector: {agent: 'codex'}},
          {action: {}, selector: {agent: 'codex'}},
          {action: 'install', selector: {agent: 'codex', profile: ['desktop']}},
          {action: 'install', selector: {agent: 'codex', scope: ['user']}},
          {action: 'install', selector: {agent: 'codex', profile: 'org'}},
          {action: 'install', selector: {agent: 'codex', cwd: f.root}},
        ])
          expect((yield* server.request('/api/dev-skills/preview', body)).status).toBe(400);
        for (const body of [
          {action: 'install', selector: {agent: 'codex'}, confirm: true},
          {action: 'install', selector: {agent: 'codex'}, previewDigest: 'a'.repeat(64)},
          {action: 'install', selector: {agent: 'codex'}, previewDigest: 'not-a-digest', confirm: true},
          {action: 'install', selector: {agent: 'codex'}, previewDigest: 'a'.repeat(64), confirm: 'true'},
        ])
          expect((yield* server.request('/api/dev-skills/apply', body)).status).toBe(400);
        for (const route of [
          '/api/dev-skills/status?agent=codex&agent=claude',
          '/api/dev-skills/status?home=foreign',
          '/api/dev-skills/catalog?cwd=foreign',
          '/api/dev-skills/projects?cwd=foreign',
        ])
          expect((yield* server.request(route)).status).toBe(400);
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
  );
  effectIt.effect.prop(
    'unknown destination/configuration fields never authorize writes',
    {field: Schema.Literals(['home', 'skillRoot', 'destination', 'command', 'manifest', 'lease'])},
    ({field}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const server = yield* serve(f);
        const before = yield* snapshot(f.root);
        for (const body of [
          {action: 'install', selector: {agent: 'codex', [field]: f.root}},
          {action: 'install', selector: {agent: 'codex'}, [field]: f.root},
        ])
          expect((yield* server.request('/api/dev-skills/preview', body)).status).toBe(400);
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    {arbitrary: {runs: 6}},
  );
  effectIt.effect('binds digest to bytes and target and preserves each stale apply', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const server = yield* serve(f);
      const selector = {agent: 'omp'};
      const initial = (yield* server.preview('install', selector)).body;
      f.environment.PI_CODING_AGENT_DIR = f.path.join(f.root, 'changed-host');
      const movedBefore = yield* snapshot(f.root);
      expect(yield* server.apply(initial, selector)).toMatchObject({
        status: 409,
        body: {code: 'stale-preview', recovery: 'preview'},
      });
      expect(yield* snapshot(f.root)).toEqual(movedBefore);
      delete f.environment.PI_CODING_AGENT_DIR;
      const installed = yield* server.apply(initial, selector);
      expect(installed.status).toBe(200);
      const update = (yield* server.preview('update', selector)).body;
      yield* f.fs.writeFileString(f.path.join(update.target.skillRoot, 'dev-plan/SKILL.md'), 'concurrent edit');
      const editedBefore = yield* snapshot(f.root);
      expect((yield* server.apply(update, selector)).status).toBe(409);
      expect(yield* snapshot(f.root)).toEqual(editedBefore);
    }).pipe(provide),
  );
  effectIt.effect(
    'requires explicit registered project selection and permits the same owned target after unregistering',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const project = f.path.join(f.root, 'project');
        yield* f.fs.makeDirectory(project);
        yield* register(f, [project, f.root]);
        const server = yield* serve(f);
        const selector = {agent: 'opencode', scope: 'project', cwd: project} as const;
        const before = yield* snapshot(f.root);
        expect((yield* server.preview('install', {agent: 'roo'})).status).toBe(400);
        expect(
          (yield* server.preview('install', {...selector, cwd: f.path.join(f.root, 'unregistered')})).body,
        ).toMatchObject({code: 'project-not-registered'});
        const preview = yield* server.preview('install', selector);
        expect(preview.status).toBe(200);
        expect(preview.body.target.cwd).toBe(project);
        expect(yield* snapshot(f.root)).toEqual(before);
        expect((yield* server.apply(preview.body, selector)).status).toBe(200);
        yield* register(f, []);
        expect((yield* server.request<ManagerDevSkillsStatus>(statusPath(selector))).body.targets[0].enrolled).toBe(
          true,
        );
        const removal = yield* server.preview('remove', selector);
        expect((yield* server.apply(removal.body, selector)).status).toBe(200);
        expect((yield* server.request<ManagerDevSkillsStatus>(statusPath(selector))).body.targets[0]).toMatchObject({
          enrollmentState: 'removed',
          enabled: false,
        });
        expect((yield* server.preview('install', selector)).body).toMatchObject({code: 'project-not-registered'});
      }).pipe(provide),
  );
  effectIt.effect(
    'reports shared consumers, explicit opt-out and unsupported hosts without inventing operation readiness',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const server = yield* serve(f);
        const selector = {agent: 'codex'};
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        const other = {...f.config, agentContextHome: f.path.join(f.root, 'other-home')};
        yield* f.run(applyDevSkills(other, 'install', selector));
        yield* f.run(
          ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'disabled', operationId: 'manager-disabled'}),
        );
        const before = yield* snapshot(f.root);
        const status = yield* server.request<ManagerDevSkillsStatus>(statusPath(selector));
        expect(status.body.targets[0]).toMatchObject({enabled: false, enrolled: true, enrollmentState: 'enrolled'});
        expect(status.body.targets[0].consumers).toHaveLength(2);
        expect((yield* server.preview('install', selector)).body.canApply).toBe(true);
        expect((yield* server.preview('install', {agent: 'opencode-native'})).status).toBe(400);
        expect((yield* server.preview('install', {agent: 'codex', profile: 'cursor-cloud-personal'})).status).toBe(400);
        const personal = yield* server.preview('install', {agent: 'codex-cloud', profile: 'codex-cloud-personal'});
        if (f.system.platform === 'linux') {
          expect(personal.status).toBe(200);
          expect(personal.body.canApply).toBe(true);
          expect(personal.body.readiness?.planning.state).toBe('blocked');
        } else expect(personal.status).toBe(400);
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
  );
  effectIt.effect('distinguishes pending refresh and historical success from current missing ownership', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'codex'}));
      const second = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'claude-code'}));
      yield* f.fs.writeFileString(f.path.join(first.target.skillRoot, 'dev-plan/SKILL.md'), 'user edit');
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
      const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
      yield* release.activate;
      expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(true);
      const server = yield* serve(f, release.run);
      const pending = yield* server.request<ManagerDevSkillsStatus>(statusPath({agent: 'codex'}));
      expect(pending.body.targets[0]).toMatchObject({
        installationState: 'modified',
        installed: {releaseVersion: '5.3.0-beta.4'},
        lastRefresh: {state: 'pending'},
      });
      yield* f.fs.remove(receiptPath(f.path, second.target.skillRoot));
      const before = yield* snapshot(f.root);
      const incomplete = yield* server.request<ManagerDevSkillsStatus>(statusPath({agent: 'claude-code'}));
      expect(incomplete.status).toBe(200);
      expect(incomplete.body.targets[0]).toMatchObject({
        installationState: 'incomplete',
        lastRefresh: {state: 'current'},
      });
      expect(incomplete.body.targets[0].installed).toBeUndefined();
      expect(incomplete.body.targets[0].issues.some(issue => issue.code === 'incomplete')).toBe(true);
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provide),
  );
  effectIt.effect('preserves whitespace in registered project identity without authorizing its trimmed sibling', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const sibling = f.path.join(f.root, 'project');
      const registered = `${sibling}${f.system.platform === 'win32' ? '\u00a0' : ' '}`;
      yield* f.fs.makeDirectory(registered);
      yield* f.fs.makeDirectory(sibling);
      yield* register(f, [registered]);
      const server = yield* serve(f);
      const selector = {agent: 'opencode', scope: 'project', cwd: sibling} as const;
      const before = yield* snapshot(f.root);
      const projects = yield* server.request<ManagerDevSkillsProjects>('/api/dev-skills/projects');
      expect(projects).toEqual({
        status: 200,
        body: {schemaVersion: 1, projects: [{name: 'project-0', path: registered}]},
      });
      expect((yield* server.preview('install', selector)).body).toMatchObject({code: 'project-not-registered'});
      expect(yield* snapshot(f.root)).toEqual(before);
      const exact = {...selector, cwd: registered};
      const preview = yield* server.preview('install', exact);
      expect(preview.status).toBe(200);
      expect(preview.body.target.cwd).toBe(registered);
      expect((yield* server.apply(preview.body, exact)).status).toBe(200);
      expect(yield* f.fs.readDirectory(sibling)).toEqual([]);
      yield* f.fs.writeFileString(f.config.manifestPath, 'invalid manifest');
      const unreadableBefore = yield* snapshot(f.root);
      expect((yield* server.request('/api/dev-skills/projects')).status).toBe(500);
      expect((yield* server.request('/api/dev-skills/catalog')).status).toBe(200);
      expect((yield* server.preview('install', {agent: 'codex'})).status).toBe(200);
      expect((yield* server.preview('remove', exact)).status).toBe(200);
      expect(yield* snapshot(f.root)).toEqual(unreadableBefore);
    }).pipe(provide),
  );
  effectIt.effect.prop(
    'unsupported control-containing registrations never authorize a display-sanitized alias',
    {suffix: Schema.Literals(['\n', '\t', '\r', '\0'])},
    ({suffix}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const alias = f.path.join(f.root, 'project');
        yield* register(f, [`${alias}${suffix}`]);
        const server = yield* serve(f);
        const before = yield* snapshot(f.root);
        expect((yield* server.request<ManagerDevSkillsProjects>('/api/dev-skills/projects')).body).toEqual({
          schemaVersion: 1,
          projects: [],
        });
        expect(
          (yield* server.preview('install', {agent: 'opencode', scope: 'project', cwd: alias})).body,
        ).toMatchObject({
          code: 'project-not-registered',
        });
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    {arbitrary: {runs: 4}},
  );
});
