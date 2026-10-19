import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {
  applyTopicEnrollment,
  inspectTopicEnrollment,
  previewTopicEnrollment,
} from '../../src/memory/maintenance/topic_enrollment.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import baseline from '../evaluation/fixtures/topic-maintenance-v1/baseline.json' with {type: 'json'};

const BODY = baseline.paragraphs.map(paragraph => paragraph.text).join('\n\n');

const fixture = Effect.fn('topicEnrollmentTest.fixture')(function* (
  settings: {
    readonly manifestName?: string;
    readonly scoped?: boolean;
    readonly multiple?: boolean;
    readonly filename?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-enrollment-'});
  const repositoryPath = path.join(home, 'repository');
  yield* fs.makeDirectory(repositoryPath);
  const repository = yield* fs.realPath(repositoryPath);
  for (const source of baseline.sourceFiles)
    yield* fs.writeFileString(path.join(repository, source.path), source.content);
  if (settings.scoped) {
    yield* fs.writeFileString(
      path.join(repository, 'package.json'),
      JSON.stringify({private: true, workspaces: ['apps/*']}),
    );
    yield* fs.makeDirectory(path.join(repository, 'apps/topic'), {recursive: true});
    yield* fs.writeFileString(
      path.join(repository, 'apps/topic/package.json'),
      JSON.stringify({name: '@fixture/topic'}),
    );
  }
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
  yield* git(['init', '--quiet']);
  yield* git(['add', '.']);
  yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial']);
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    manifestPath: path.join(home, settings.manifestName ?? 'manifest.yaml'),
    user: 'tester',
  };
  const project = {
    name: 'fixture',
    path: repository,
    uri: 'threadnote://resources/repos/fixture',
    seed: [],
    ...(settings.scoped
      ? {graph: {roots: ['apps/topic'], include: ['health.ts', 'config.ts'], closure: 'dependencies' as const}}
      : {}),
  };
  yield* fs.writeFileString(
    config.manifestPath,
    JSON.stringify({
      version: 1,
      projects: [
        project,
        ...(settings.multiple ? [{...project, name: 'other', uri: 'threadnote://resources/repos/other'}] : []),
      ],
    }),
  );
  yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false, project});
  const citations = yield* captureMemoryCodeCitations(config, {
    callerCwd: repository,
    ...(settings.multiple ? {project: project.name} : {}),
    refs: ['health.ts', 'config.ts'],
  });
  const uri = `threadnote://user/tester/memories/durable/projects/fixture/${settings.filename ?? 'context-health.md'}`;
  const content = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      memoryId: 'tn_context_health',
      project: 'fixture',
      topic: 'context-health',
      sourceAgentClient: 'test',
      timestamp: '2026-10-16T00:00:00.000Z',
      schemaVersion: 8,
      owner: 'fixture-reviewer',
      authority: 'user_approved',
      trust: 'approved',
      workspaceScope: '.',
      relations: [{type: 'references', uri: 'threadnote://memory/tn_policy'}],
      codeCitations: citations,
    },
    BODY,
  );
  const store = yield* ResourceStore;
  const location = {account: 'local', home, user: 'tester'};
  yield* store.write(location, uri, content, {mode: 'create'});
  const byPath = new Map(citations.map(citation => [citation.path, citation.id]));
  const input = {
    paragraphs: baseline.paragraphs.map(paragraph => ({
      role: paragraph.role,
      support: paragraph.support,
      citationIds: [byPath.get(paragraph.sourcePath)!],
      ...('scope' in paragraph ? {scope: paragraph.scope} : {}),
    })),
    additionalDependencies: baseline.additionalDependencies.map(dependency => ({
      kind: dependency.kind,
      citationId: byPath.get(dependency.sourcePath)!,
    })),
  };
  return {config, options: {uri, callerCwd: repository, input}, content, store, location, fs, path, repository, git};
});

describe('topic maintenance enrollment', () => {
  for (const manifestName of ['manifest.yaml', 'seed-manifest.yaml']) {
    effectIt.effect(`enrolls exact current configured scope using ${manifestName}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({scoped: true, manifestName});
        const preview = yield* previewTopicEnrollment(f.config, f.options);
        expect(preview.status).toBe('preview');
        if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
        expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
        expect(
          yield* applyTopicEnrollment(f.config, {
            ...f.options,
            approved: true,
            expectedContentHash: preview.proposal.expectedContentHash,
            revision: preview.proposal.revision,
          }),
        ).toMatchObject({status: 'enrolled'});
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('requires an explicit graph selector for multiple scopes without using the memory project tag', () =>
    Effect.gen(function* () {
      const f = yield* fixture({scoped: true, multiple: true});
      yield* (yield* CodeGraphIndexer).index({
        cwd: f.repository,
        threadnoteHome: f.config.agentContextHome,
        ensureVectors: false,
      });
      expect(yield* previewTopicEnrollment(f.config, f.options)).toMatchObject({
        status: 'conflict',
        code: 'evidence-not-current',
      });
      const preview = yield* previewTopicEnrollment(f.config, {...f.options, project: 'fixture'});
      expect(preview.status).toBe('preview');
      expect(yield* previewTopicEnrollment(f.config, {...f.options, project: 'other'})).toMatchObject({
        status: 'conflict',
        code: 'evidence-not-current',
      });
      expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('enrolls a sentence-named topic ending in a period through the public CLI', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        scoped: true,
        multiple: true,
        filename: 'how-source-backed-topic-updates-are-drafted-reviewed-and-safely-accepted..md',
      });
      const system = yield* SystemInfo;
      const inputFile = f.path.join(f.config.agentContextHome, 'support.json');
      yield* f.fs.writeFileString(inputFile, JSON.stringify(f.options.input));
      const binary = system.environment().THREADNOTE_E2E_BINARY;
      const executable = binary ?? system.executablePath;
      const prefix = binary ? [] : [f.path.join(system.currentDirectory(), 'apps/threadnote/src/standalone.ts')];
      const run = (args: readonly string[]) =>
        runCommandEffect(executable, [...prefix, 'context', 'topic', ...args], {
          cwd: f.repository,
          env: {
            ...system.environment(),
            THREADNOTE_HOME: f.config.agentContextHome,
            THREADNOTE_USER: f.config.user,
            THREADNOTE_MANIFEST: f.config.manifestPath,
            NO_COLOR: '1',
          },
          timeoutMs: 60_000,
        });
      const target = [
        '--uri',
        f.options.uri,
        '--cwd',
        f.repository,
        '--project',
        'fixture',
        '--input',
        inputFile,
        '--json',
      ];
      const preview = JSON.parse((yield* run(['preview', ...target])).stdout);
      expect(preview.status).toBe('preview');
      expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
      const applied = JSON.parse(
        (yield* run([
          'enroll',
          ...target,
          '--content-hash',
          preview.proposal.expectedContentHash,
          '--revision',
          preview.proposal.revision,
          '--approved',
        ])).stdout,
      );
      expect(applied.status).toBe('enrolled');
      const inspected = JSON.parse((yield* run(['inspect', '--uri', f.options.uri, '--json'])).stdout);
      expect(inspected).toMatchObject({status: 'enrolled', body: BODY});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses dirty, stale and reindexed changed source under a configured scope', () =>
    Effect.gen(function* () {
      const f = yield* fixture({scoped: true});
      yield* f.fs.writeFileString(f.path.join(f.repository, 'config.ts'), 'export const timeoutSeconds = 60;\n');
      expect(yield* previewTopicEnrollment(f.config, f.options)).toMatchObject({
        status: 'conflict',
        code: 'dirty-source',
      });
      yield* f.git(['add', '.']);
      yield* f.git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'changed source',
      ]);
      expect(yield* previewTopicEnrollment(f.config, f.options)).toMatchObject({
        status: 'conflict',
        code: 'evidence-not-current',
      });
      const manifest = JSON.parse(yield* f.fs.readFileString(f.config.manifestPath));
      yield* (yield* CodeGraphIndexer).index({
        cwd: f.repository,
        threadnoteHome: f.config.agentContextHome,
        project: manifest.projects[0],
        ensureVectors: false,
      });
      expect(yield* previewTopicEnrollment(f.config, f.options)).toMatchObject({
        status: 'conflict',
        code: 'evidence-not-current',
      });
      expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const change of ['scope', 'source'] as const) {
    effectIt.effect(`refuses a ${change} change during the final scoped citation observation`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({scoped: true, multiple: true});
        const store = yield* CodeGraphStore;
        let changed = false;
        const observed = CodeGraphStore.of({
          ...store,
          effectiveSnapshotCitationEvidence: (...args) =>
            store.effectiveSnapshotCitationEvidence(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (changed) return;
                  changed = true;
                  if (change === 'source')
                    yield* f.fs.writeFileString(
                      f.path.join(f.repository, 'health.ts'),
                      'export const changed = true;\n',
                    );
                  else {
                    const manifest = JSON.parse(yield* f.fs.readFileString(f.config.manifestPath));
                    yield* f.fs.writeFileString(
                      f.config.manifestPath,
                      JSON.stringify({
                        ...manifest,
                        projects: manifest.projects.filter((project: {name: string}) => project.name !== 'fixture'),
                      }),
                    );
                  }
                }).pipe(Effect.orDie),
              ),
            ),
        });
        expect(
          yield* previewTopicEnrollment(f.config, {...f.options, project: 'fixture'}).pipe(
            Effect.provideService(CodeGraphStore, observed),
          ),
        ).toMatchObject({status: 'conflict', code: 'evidence-not-current'});
        expect(changed).toBe(true);
        expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect(
    'previews without mutation, enrolls the reviewed evidence, and retries without duplicate writes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const preview = yield* previewTopicEnrollment(f.config, f.options);
        expect(preview.status).toBe('preview');
        if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
        expect(preview.body).toBe(BODY);
        expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
        const approval = {
          ...f.options,
          expectedContentHash: preview.proposal.expectedContentHash,
          revision: preview.proposal.revision,
        };
        expect(yield* applyTopicEnrollment(f.config, approval)).toMatchObject({
          status: 'conflict',
          code: 'approval-required',
        });
        expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
        expect(yield* applyTopicEnrollment(f.config, {...approval, approved: true})).toMatchObject({
          status: 'enrolled',
        });
        const after = yield* f.store.read(f.location, f.options.uri);
        const record = parseMemoryDocument(f.options.uri, after)!;
        expect(record.body).toBe(BODY);
        expect(record.metadata).toMatchObject({
          memoryId: 'tn_context_health',
          owner: 'fixture-reviewer',
          workspaceScope: '.',
          authority: 'user_approved',
          trust: 'approved',
        });
        expect(record.metadata.topicMaintenanceError).toBeUndefined();
        expect(record.metadata.topicMaintenance?.coverage).toBe('declared-only');
        expect(record.metadata.topicMaintenance?.paragraphs.map(p => p.role)).toEqual([
          'descriptive',
          'normative',
          'historical',
          'descriptive',
          'descriptive',
        ]);
        expect(yield* applyTopicEnrollment(f.config, {...approval, approved: true})).toMatchObject({
          status: 'already-enrolled',
        });
        expect(yield* f.store.read(f.location, f.options.uri)).toBe(after);
        expect(yield* inspectTopicEnrollment(f.config, 'tn_context_health')).toMatchObject({
          status: 'enrolled',
          body: BODY,
        });
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a dirty repository and edited support input without changing accepted content', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* previewTopicEnrollment(f.config, f.options);
      if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
      const approval = {
        ...f.options,
        approved: true,
        expectedContentHash: preview.proposal.expectedContentHash,
        revision: preview.proposal.revision,
      };
      const input = {...f.options.input, paragraphs: f.options.input.paragraphs.map(p => ({...p, role: 'historical'}))};
      expect(yield* applyTopicEnrollment(f.config, {...approval, input})).toMatchObject({
        status: 'conflict',
        code: 'revision-changed',
      });
      yield* f.fs.writeFileString(f.path.join(f.repository, 'config.ts'), 'export const timeoutSeconds = 60;\n');
      expect(yield* applyTopicEnrollment(f.config, approval)).toMatchObject({status: 'conflict', code: 'dirty-source'});
      expect(yield* f.store.read(f.location, f.options.uri)).toBe(f.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a target metadata edit after preview', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* previewTopicEnrollment(f.config, f.options);
      if (preview.status !== 'preview') throw new Error(JSON.stringify(preview));
      const changed = f.content.replace('owner: fixture-reviewer', 'owner: another-reviewer');
      yield* f.store.write(f.location, f.options.uri, changed, {mode: 'replace'});
      expect(
        yield* applyTopicEnrollment(f.config, {
          ...f.options,
          approved: true,
          expectedContentHash: preview.proposal.expectedContentHash,
          revision: preview.proposal.revision,
        }),
      ).toMatchObject({status: 'conflict', code: 'target-changed'});
      expect(yield* f.store.read(f.location, f.options.uri)).toBe(changed);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
