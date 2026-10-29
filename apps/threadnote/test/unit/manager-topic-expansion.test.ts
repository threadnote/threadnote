import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Array as EffectArray, DateTime, Effect, FileSystem, Path, Predicate, Scope} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {loadCandidateReview, saveCandidateReview} from '@threadnote/memory/candidate';
import {
  applyTopicDependencyExpansion,
  previewTopicDependencyExpansion,
} from '../../src/memory/maintenance/topic_expansion.js';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  buildTopicMaintenanceObsidianManifest,
  topicMaintenanceObsidianCitationId,
} from '@threadnote/memory/topic-maintenance';
import type {ManagerTopicExpansionPreview} from '@threadnote/manager/attention/topic-expansion-contracts';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {makeTopicExpansionFixture} from '../helpers/topic-expansion.js';
import {managerAttentionProjectRoot} from '../../src/manager/attention.js';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import {
  handleTopicDependencyExpansionTool,
  registerTopicDependencyExpansionTools,
} from '../../src/mcp/server/context/topic_expansion.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type Fixture = Effect.Success<ReturnType<typeof makeTopicExpansionFixture>>;
const selection = (f: Fixture) => {
  const {root: _root, project: _project, ...input} = f.selectedInput;
  return input;
};
const request = (f: Fixture, action: string, extra: Record<string, unknown> = {}) =>
  handleManagerAttentionAction({
    config: f.config,
    method: 'POST',
    url: new URL('http://manager.test/api/attention/topic-expansion'),
    body: Effect.succeed({
      action,
      uri: f.uri,
      project: 'fixture',
      ...(action === 'inspect' ? {} : {selection: selection(f)}),
      ...extra,
    }),
  });
type PreviewApproval = Pick<ManagerTopicExpansionPreview, 'revision' | 'approvalDigest'>;
type PreviewOperation = Pick<
  NonNullable<ManagerTopicExpansionPreview['operation']>,
  'id' | 'generation' | 'predecessorRevision' | 'predecessorApprovalDigest'
>;
type PreviewProjection = {
  readonly operation?: PreviewOperation;
  readonly revision: string;
  readonly approvalDigest: string;
  readonly content: string;
  readonly additions: readonly Pick<ManagerTopicExpansionPreview['additions'][number], 'kind' | 'path'>[];
};
function isPreviewOperation(value: unknown): value is PreviewOperation {
  return (
    Predicate.isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    typeof value.predecessorRevision === 'string' &&
    typeof value.predecessorApprovalDigest === 'string'
  );
}
function isPreviewProjection(value: unknown): value is PreviewProjection {
  return (
    Predicate.isObject(value) &&
    typeof value.revision === 'string' &&
    typeof value.approvalDigest === 'string' &&
    typeof value.content === 'string' &&
    EffectArray.isArray(value.additions) &&
    EffectArray.every(
      value.additions,
      (addition): addition is PreviewProjection['additions'][number] =>
        Predicate.isObject(addition) &&
        (addition.kind === 'configuration' || addition.kind === 'dependency') &&
        typeof addition.path === 'string',
    ) &&
    (value.operation === undefined || isPreviewOperation(value.operation))
  );
}
const previewProjection = (value: unknown): PreviewProjection => {
  if (!isPreviewProjection(value)) throw new Error('Topic expansion preview response is invalid.');
  return value;
};
const args = (p: PreviewApproval) => ({
  revision: p.revision,
  approvalDigest: p.approvalDigest,
  approved: true,
});
const safe = (body: unknown, f: Fixture) => {
  const json = JSON.stringify(body);
  expect(json).not.toContain(f.repository);
  expect(json).not.toMatch(/callerCwd|scopeReceiptJson|sourceFenceDigest/u);
};

effectIt.effect('removes the owned topic-expansion fixture root after normal scope completion', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Effect.scoped(
      Effect.gen(function* () {
        const ownerScope = yield* Effect.scope;
        const fixture = yield* makeTopicExpansionFixture().pipe(
          Scope.provide(ownerScope),
          provideTestLayer(ApplicationLayer),
        );
        expect(yield* fs.exists(fixture.memoryPath)).toBe(true);
        return fixture.home;
      }),
    );
    expect(yield* fs.exists(home)).toBe(false);
  }).pipe(provideTestLayer(BunServices.layer), TestClock.withLive),
);

effectIt.effect('cleans up the topic-expansion fixture when its owned root is already absent', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Effect.scoped(
      Effect.gen(function* () {
        const ownerScope = yield* Effect.scope;
        const fixture = yield* makeTopicExpansionFixture().pipe(
          Scope.provide(ownerScope),
          provideTestLayer(ApplicationLayer),
        );
        expect(yield* fs.exists(fixture.memoryPath)).toBe(true);
        yield* fs.remove(fixture.home, {recursive: true});
        expect(yield* fs.exists(fixture.home)).toBe(false);
        return fixture.home;
      }),
    );
    expect(yield* fs.exists(home)).toBe(false);
  }).pipe(provideTestLayer(BunServices.layer), TestClock.withLive),
);

effectIt.effect('inspects and previews a configured spaced project without changing the accepted memory', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const project = 'Example Project';
    const f = yield* makeTopicExpansionFixture({project});
    const before = yield* fs.readFileString(f.memoryPath);
    expect(yield* request(f, 'inspect', {project})).toMatchObject({status: 200, body: {project}});
    expect((yield* request(f, 'preview', {project}))?.status).toBe(200);
    expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect(
  'Manager exposes explicit safe choices and exact full preview, then applies and replays without rewriting body or origins',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeTopicExpansionFixture();
      const before = yield* fs.readFileString(f.memoryPath);
      const inspected = yield* request(f, 'inspect');
      expect(inspected?.status).toBe(200);
      safe(inspected?.body, f);
      expect(inspected?.body).toMatchObject({
        sourceKind: 'code',
        seeds: expect.arrayContaining([expect.objectContaining({path: 'src/main.ts'})]),
      });
      const discovered = yield* request(f, 'discover', {selection: {...selection(f), selectedNodeIds: []}});
      expect(discovered?.status).toBe(200);
      safe(discovered?.body, f);
      expect(discovered?.body).toMatchObject({
        choices: {eligible: expect.arrayContaining([expect.objectContaining({path: 'src/dependency.ts'})])},
      });
      expect((yield* request(f, 'preview', {selection: {...selection(f), selectedNodeIds: []}}))?.status).toBe(409);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
      const response = yield* request(f, 'preview');
      expect(response?.status).toBe(200);
      safe(response?.body, f);
      const preview = previewProjection(response?.body);
      expect(preview.additions).toEqual([expect.objectContaining({kind: 'dependency', path: 'src/dependency.ts'})]);
      expect(parseMemoryDocument(f.uri, preview.content)?.body).toBe(f.body);
      expect((yield* request(f, 'apply', {...args(preview), approved: false}))?.status).toBe(400);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
      expect((yield* request(f, 'apply', args(preview)))?.status).toBe(200);
      const accepted = yield* fs.readFileString(f.memoryPath);
      const record = parseMemoryDocument(f.uri, accepted)!;
      expect(record.body).toBe(f.body);
      expect(record.metadata.codeCitations).toContainEqual(f.origin);
      expect(record.metadata.topicMaintenance?.paragraphs).toEqual(f.record.metadata.topicMaintenance?.paragraphs);
      const mtime = (yield* fs.stat(f.memoryPath)).mtime;
      const replay = yield* request(f, 'apply', args(preview));
      expect(replay?.status).toBe(200);
      expect(replay?.body).toMatchObject({status: 'already-expanded'});
      safe(replay?.body, f);
      expect((yield* fs.stat(f.memoryPath)).mtime).toEqual(mtime);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(accepted);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect(
  'Manager refuses bounded neighborhoods and wrong project/config/target/source without widening or writing',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* makeTopicExpansionFixture();
      const before = yield* fs.readFileString(f.memoryPath);
      expect(
        (yield* request(f, 'discover', {selection: {...selection(f), selectedNodeIds: [], nodeLimit: 1, edgeLimit: 1}}))
          ?.status,
      ).toBe(409);
      expect((yield* request(f, 'preview', {selection: {...selection(f), nodeLimit: 1, edgeLimit: 1}}))?.status).toBe(
        409,
      );
      const response = yield* request(f, 'preview');
      const preview = previewProjection(response?.body);
      expect(response?.status).toBe(200);
      expect((yield* request(f, 'apply', {...args(preview), project: 'other'}))?.status).toBe(409);
      expect((yield* request(f, 'preview', {selection: {...selection(f), root: f.repository}}))?.status).toBe(409);
      const configBytes = yield* fs.readFileString(f.config.manifestPath);
      yield* fs.writeFileString(f.config.manifestPath, configBytes + '# same commit, different configuration\n');
      expect((yield* request(f, 'apply', args(preview)))?.status).toBe(409);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
      yield* fs.writeFileString(f.config.manifestPath, configBytes);
      const concurrent = before + '\n\nA concurrent author edit.';
      yield* fs.writeFileString(f.memoryPath, concurrent);
      expect((yield* request(f, 'apply', args(preview)))?.status).toBe(409);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(concurrent);
      yield* fs.writeFileString(f.memoryPath, before);
      yield* fs.writeFileString(path.join(f.repository, 'src/dependency.ts'), 'export const dependency = 48;\n');
      expect((yield* request(f, 'apply', args(preview)))?.status).toBe(409);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect('Manager rejects imported source authority without returning private note data', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const f = yield* makeTopicExpansionFixture();
    const uri = 'threadnote://user/tester/memories/durable/projects/fixture/imported.md';
    const origin = {
      version: 1 as const,
      sourceId: 'notes',
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      vaultHash: Effect2.pipe('a', EffectString.repeat(64)),
      accessHash: Effect2.pipe('b', EffectString.repeat(64)),
      noteId: '22222222-2222-4222-8222-222222222222',
      relativePath: 'PRIVATE_NOTE.md',
      revisionHash: Effect2.pipe('c', EffectString.repeat(64)),
      sanitizerVersion: 'scrubber-redact-v1',
      fragmentHash: Effect2.pipe('d', EffectString.repeat(64)),
      fragmentStart: 0,
      fragmentEnd: 12,
      pinId: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    const metadata = {
      kind: 'durable' as const,
      status: 'active' as const,
      schemaVersion: 10,
      memoryId: 'tn_imported_expansion_refusal',
      project: 'fixture',
      sourceAgentClient: 'test',
      timestamp: '2026-10-18T00:00:00.000Z',
      obsidianEvidence: origin,
    };
    const base = parseMemoryDocument(uri, formatMemoryDocument('MEMORY', metadata, 'PRIVATE_IMPORTED_BODY'))!;
    const manifest = buildTopicMaintenanceObsidianManifest(base, {
      paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [topicMaintenanceObsidianCitationId(origin)]}],
    });
    const file = path.join(path.dirname(f.memoryPath), 'imported.md');
    const content = formatMemoryDocument('MEMORY', {...metadata, topicMaintenance: manifest}, base.body);
    yield* fs.writeFileString(file, content);
    const result = yield* request(f, 'inspect', {uri});
    expect(result?.status).toBe(409);
    expect(JSON.stringify(result?.body)).not.toMatch(/PRIVATE_|pinId|fragment/u);
    expect(yield* fs.readFileString(file)).toBe(content);
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect('MCP registers explicit expansion actions with safe projections and exact approval', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* makeTopicExpansionFixture();
    const adapter = new EffectMcpServerAdapter('test', '1', '');
    registerTopicDependencyExpansionTools(adapter, f.config);
    const call = (action: string, extra: Record<string, unknown> = {}) => {
      const input = {
        action,
        uri: f.uri,
        project: 'fixture',
        callerCwd: f.repository,
        ...(action === 'inspect' ? {} : {inputJson: JSON.stringify(selection(f))}),
        ...extra,
      };
      return action === 'unexpected'
        ? handleTopicDependencyExpansionTool(f.config, input)
        : adapter.invokeTool('context_topic_dependency_expansion', input);
    };
    expect((yield* call('unexpected')).isError).toBe(true);
    const inspected = yield* call('inspect');
    expect(inspected.isError).not.toBe(true);
    safe(inspected.structuredContent, f);
    const previewed = yield* call('preview');
    expect(previewed.isError).not.toBe(true);
    safe(previewed.structuredContent, f);
    const preview = previewProjection(previewed.structuredContent);
    const before = yield* fs.readFileString(f.memoryPath);
    expect((yield* call('apply', {...args(preview), approved: false})).isError).toBe(true);
    expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
    const applied = yield* call('apply', args(preview));
    expect(applied.isError).not.toBe(true);
    safe(applied.structuredContent, f);
    expect(parseMemoryDocument(f.uri, yield* fs.readFileString(f.memoryPath))?.body).toBe(f.body);
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect(
  'Manager and MCP explicitly restart only an exact expired unwritten intent and require fresh approval',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* makeTopicExpansionFixture();
      const response = yield* request(f, 'preview');
      const prior = previewProjection(response?.body);
      const before = yield* fs.readFileString(f.memoryPath);
      const retainedEvidence = () =>
        fs
          .readDirectory(f.home, {recursive: true})
          .pipe(
            Effect.flatMap(files =>
              Effect.forEach(
                EffectArray.filter(
                  files,
                  (file, index) =>
                    index in files &&
                    Effect2.pipe(file, EffectString.includes('citation-evidence')) &&
                    Effect2.pipe(file, EffectString.endsWith('.json')),
                ).sort(),
                file => fs.readFileString(path.join(f.home, file)).pipe(Effect.map(content => [file, content])),
              ),
            ),
          );
      const retained = yield* retainedEvidence();
      expect((yield* request(f, 'restart', args(prior)))?.status).toBe(409);
      const root = yield* managerAttentionProjectRoot(f.config, 'fixture');
      if (root.state !== 'available') throw new Error('Fixture project must be available');
      const exactDomain = yield* previewTopicDependencyExpansion(f.config, {
        uri: f.uri,
        callerCwd: root.cwd,
        input: f.selectedInput,
      });
      expect(exactDomain.preview.revision).toBe(prior.revision);
      const interrupted = yield* applyTopicDependencyExpansion(
        f.config,
        {preview: exactDomain.preview, ...args(prior)},
        {afterIntentSaved: () => Effect.fail('fixture interruption before capture')},
      ).pipe(Effect.result);
      expect(interrupted).toMatchObject({failure: 'fixture interruption before capture'});
      const journal = yield* loadCandidateReview(
        f.home,
        `review-${Effect2.pipe(prior.revision, EffectString.slice(0, 24))}`,
      );
      expect(journal.dependencyExpansion?.stage).toBe('prepared');
      expect((yield* request(f, 'restart', args(prior)))?.status).toBe(409);
      const expiredAt = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, {days: 91}));
      yield* saveCandidateReview(f.home, {...journal, createdAt: expiredAt});
      const adapter = new EffectMcpServerAdapter('test', '1', '');
      registerTopicDependencyExpansionTools(adapter, f.config);
      const call = (action: string, extra: Record<string, unknown> = {}) =>
        handleTopicDependencyExpansionTool(f.config, {
          action,
          uri: f.uri,
          project: 'fixture',
          callerCwd: root.cwd,
          inputJson: JSON.stringify(selection(f)),
          ...extra,
        });
      const blocked = yield* request(f, 'apply', args(prior));
      expect(blocked?.status).toBe(409);
      expect(blocked?.body).toMatchObject({
        recovery: {
          action: 'restart',
          targetUri: f.uri,
          project: 'fixture',
          revision: prior.revision,
          approvalDigest: prior.approvalDigest,
        },
      });
      safe(blocked?.body, f);
      const mcpBlocked = yield* call('apply', args(prior));
      expect(mcpBlocked.isError).toBe(true);
      expect(mcpBlocked.structuredContent).toEqual(blocked?.body);
      safe(mcpBlocked.structuredContent, f);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
      expect((yield* request(f, 'restart', {...args(prior), approved: false}))?.status).toBe(400);
      expect(
        (yield* request(f, 'restart', {...args(prior), approvalDigest: Effect2.pipe('0', EffectString.repeat(64))}))
          ?.status,
      ).toBe(409);
      expect((yield* request(f, 'restart', {...args(prior), project: 'other'}))?.status).toBe(409);
      expect(
        (yield* request(f, 'restart', {
          ...args(prior),
          uri: Effect2.pipe(f.uri, EffectString.replace('limit.md', 'other.md')),
        }))?.status,
      ).toBe(409);
      expect(
        (yield* request(f, 'restart', {...args(prior), selection: {...selection(f), edgeLimit: 63}}))?.status,
      ).toBe(409);
      const restarted = yield* request(f, 'restart', args(prior));
      expect(restarted?.status).toBe(200);
      safe(restarted?.body, f);
      const fresh = previewProjection(restarted?.body);
      expect(fresh.operation).toMatchObject({
        generation: 1,
        predecessorRevision: prior.revision,
        predecessorApprovalDigest: prior.approvalDigest,
      });
      expect(fresh.operation?.id).toMatch(/^[a-f0-9-]{36}$/u);
      expect(fresh.revision).not.toBe(prior.revision);
      expect(fresh.approvalDigest).not.toBe(prior.approvalDigest);
      expect(yield* retainedEvidence()).toEqual(retained);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
      expect((yield* request(f, 'apply', args(prior)))?.status).toBe(409);
      expect((yield* call('restart', {...args(prior), approved: false})).isError).toBe(true);
      const replay = yield* call('restart', args(prior));
      expect(replay.isError).not.toBe(true);
      expect(replay.structuredContent).toEqual(fresh);
      expect((yield* call('apply', {...args(fresh), approved: false})).isError).toBe(true);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
      const applied = yield* call('apply', args(fresh));
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toMatchObject({status: 'expanded'});
      const accepted = yield* fs.readFileString(f.memoryPath);
      const record = parseMemoryDocument(f.uri, accepted)!;
      expect(record.body).toBe(f.body);
      expect(record.metadata.codeCitations).toContainEqual(f.origin);
      expect(record.metadata.topicMaintenance?.paragraphs).toEqual(f.record.metadata.topicMaintenance?.paragraphs);
      const mtime = (yield* fs.stat(f.memoryPath)).mtime;
      expect((yield* request(f, 'apply', args(fresh)))?.body).toMatchObject({status: 'already-expanded'});
      expect((yield* fs.stat(f.memoryPath)).mtime).toEqual(mtime);
      expect(yield* fs.readFileString(f.memoryPath)).toBe(accepted);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  // This real Git/graph restart-and-replay flow takes ~22s alone; allow bounded headroom for parallel files.
  45_000,
);
