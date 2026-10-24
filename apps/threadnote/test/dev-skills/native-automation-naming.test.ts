import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {SystemInfo} from '@threadnote/platform/system';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import type {WorkflowBinding} from '../../src/workflow_memory/protocol.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);

type InitResult = {
  readonly status: 'ok';
  readonly runId: string;
  readonly title: string;
  readonly bindingId: string;
  readonly naming: {readonly policyVersion: 1; readonly slug: string; readonly ordinal: number};
};
type ArtifactResult = {
  readonly status: 'ok';
  readonly operationId: string;
  readonly artifact: {
    readonly uri: string;
    readonly memoryId: string;
    readonly revision: string;
    readonly body: string;
    readonly storageKind: 'durable' | 'handoff';
    readonly state: 'active' | 'archived';
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireInitResult = (value: unknown): InitResult => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    typeof value.runId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.bindingId !== 'string' ||
    !isRecord(value.naming) ||
    value.naming.policyVersion !== 1 ||
    typeof value.naming.slug !== 'string' ||
    typeof value.naming.ordinal !== 'number'
  )
    throw new Error('Expected a native run initialized with a readable name family.');
  return {
    status: 'ok',
    runId: value.runId,
    title: value.title,
    bindingId: value.bindingId,
    naming: {policyVersion: 1, slug: value.naming.slug, ordinal: value.naming.ordinal},
  };
};

const requireArtifactResult = (value: unknown): ArtifactResult => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    typeof value.operationId !== 'string' ||
    !isRecord(value.artifact) ||
    typeof value.artifact.uri !== 'string' ||
    typeof value.artifact.memoryId !== 'string' ||
    typeof value.artifact.revision !== 'string' ||
    typeof value.artifact.body !== 'string' ||
    (value.artifact.storageKind !== 'durable' && value.artifact.storageKind !== 'handoff') ||
    (value.artifact.state !== 'active' && value.artifact.state !== 'archived')
  )
    throw new Error('Expected a native workflow artifact with verified readback.');
  return {
    status: 'ok',
    operationId: value.operationId,
    artifact: {
      uri: value.artifact.uri,
      memoryId: value.artifact.memoryId,
      revision: value.artifact.revision,
      body: value.artifact.body,
      storageKind: value.artifact.storageKind,
      state: value.artifact.state,
    },
  };
};

const initInput = (f: Effect.Success<ReturnType<typeof nativeFixture>>, runId: string, title: string) => ({
  ...f.base('init', runId),
  project: 'fixture',
  featureId: 'feature',
  profile: 'desktop',
  title,
});

const writeInput = (
  f: Effect.Success<ReturnType<typeof nativeFixture>>,
  runId: string,
  values: {
    readonly operationId: string;
    readonly artifactKey: string;
    readonly role: string;
    readonly nameHint: string;
    readonly body: string;
    readonly uri?: string;
    readonly expectedRevision?: string | null;
  },
) => ({
  ...f.base('write', runId),
  action: 'write',
  operationId: values.operationId,
  artifactKey: values.artifactKey,
  role: values.role,
  nameHint: values.nameHint,
  body: values.body,
  ...(values.uri === undefined ? {} : {uri: values.uri}),
  expectedRevision: values.expectedRevision ?? null,
  storageKind: 'durable',
});

const nameRegistryPath = (f: Effect.Success<ReturnType<typeof nativeFixture>>) =>
  f.path.join(f.home, 'workflow-automations', 'names-v1', 'fixture', 'workflow-names.json');

describe('native workflow naming integration', () => {
  effectIt.effect(
    'uses readable role names while stable artifact keys preserve version, replacement, and archive identity',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        const runId = 'named-run';
        const initialized = requireInitResult(yield* f.call(initInput(f, runId, 'Platform Refresh')));
        expect(initialized).toMatchObject({
          title: 'Platform Refresh',
          naming: {policyVersion: 1, slug: 'platform-refresh', ordinal: 1},
        });

        const specs = [
          {key: 'opaque-spec-key', op: 'write-spec', role: 'root', hint: 'spec'},
          {key: 'plan-core-key', op: 'write-plan-core', role: 'root', hint: 'plan'},
          {key: 'plan-summary-key', op: 'write-plan-summary', role: 'root', hint: 'plan'},
          {key: 'architecture-key', op: 'write-architecture', role: 'current', hint: 'arch'},
          {key: 'decisions-key', op: 'write-decisions', role: 'decision', hint: 'decisions'},
          {key: 'literal-version-key', op: 'write-literal-version', role: 'root', hint: 'plan-v2'},
        ] as const;
        const artifacts = new Map<string, ArtifactResult>();
        for (const item of specs) {
          const body = `Named ${item.hint} document.\n`;
          const result = requireArtifactResult(
            yield* f.call(
              writeInput(f, runId, {
                operationId: item.op,
                artifactKey: item.key,
                role: item.role,
                nameHint: item.hint,
                body,
              }),
            ),
          );
          artifacts.set(item.key, result);
        }

        for (const item of [
          {key: 'opaque-spec-key', leaf: 'workflow-platform-refresh-spec.md'},
          {key: 'plan-core-key', leaf: 'workflow-platform-refresh-plan.md'},
          {key: 'plan-summary-key', leaf: 'workflow-platform-refresh-plan-v2.md'},
          {key: 'architecture-key', leaf: 'workflow-platform-refresh-arch.md'},
          {key: 'decisions-key', leaf: 'workflow-platform-refresh-decisions.md'},
          {key: 'literal-version-key', leaf: 'workflow-platform-refresh-plan-v2-v2.md'},
        ]) {
          const artifact = artifacts.get(item.key)!.artifact;
          expect(artifact.uri).toBe(`threadnote://user/tester/memories/durable/projects/fixture/${item.leaf}`);
          expect(artifact.memoryId).toMatch(/^tn_[a-f0-9]{20}$/u);
          const content = yield* f.store.read(f.location, artifact.uri);
          const document = parseMemoryDocument(artifact.uri, content);
          expect(document?.metadata.topic).toBe(item.leaf.slice(0, -'.md'.length));
          expect(document?.metadata.sourceSessionId).toBe('native-v1-named-run');
        }

        const firstPlan = artifacts.get('plan-core-key')!.artifact;
        const replacement = writeInput(f, runId, {
          operationId: 'replace-plan-core',
          artifactKey: 'plan-core-key',
          role: 'root',
          nameHint: 'plan',
          body: 'Revised plan body.\n',
          uri: firstPlan.uri,
          expectedRevision: firstPlan.revision,
        });
        const replaced = requireArtifactResult(yield* f.call(replacement));
        expect(replaced.artifact).toMatchObject({
          uri: firstPlan.uri,
          memoryId: firstPlan.memoryId,
          body: replacement.body,
        });
        const stateAfterReplacement = yield* f.fs.readFileString(f.statePath(runId));
        const journalPath = f.journalPath(initialized.bindingId);
        const journalAfterReplacement = yield* f.fs.readFileString(journalPath);
        expect(JSON.parse(journalAfterReplacement).artifacts[firstPlan.uri]).toMatchObject({
          artifactKey: 'plan-core-key',
          naming: {role: 'plan', version: 1},
        });
        expect(yield* f.call(replacement)).toMatchObject(replaced);
        expect(yield* f.fs.readFileString(f.statePath(runId))).toBe(stateAfterReplacement);
        expect(yield* f.fs.readFileString(journalPath)).toBe(journalAfterReplacement);

        const journal = JSON.parse(journalAfterReplacement) as {
          binding: WorkflowBinding;
          artifacts: Record<string, {artifactKey: string; sourceRunId: string; role: string}>;
        };
        const secondPlan = journal.artifacts[artifacts.get('plan-summary-key')!.artifact.uri];
        const system = yield* SystemInfo;
        const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
        const archived = yield* runWorkflowMemory(f.config, {
          protocolVersion: 1,
          action: 'archive',
          bindingId: initialized.bindingId,
          operationId: 'archive-plan-summary',
          artifactKey: secondPlan.artifactKey,
          sourceRunId: 'named-run',
          role: secondPlan.role,
          uri: artifacts.get('plan-summary-key')!.artifact.uri,
          expectedRevision: artifacts.get('plan-summary-key')!.artifact.revision,
        }).pipe(Effect.provideService(SystemInfo, scopedSystem));
        expect(archived).toMatchObject({
          status: 'ok',
          canonicalUri:
            'threadnote://user/tester/memories/durable/archived/fixture/workflow-platform-refresh-plan-v2-archive-1.md',
          state: 'archived',
        });
        const originalAfterArchive = yield* failure(
          f.store.read(f.location, artifacts.get('plan-summary-key')!.artifact.uri),
        );
        expect(originalAfterArchive._tag).toBe('Failure');
        expect(yield* f.store.read(f.location, firstPlan.uri)).toContain('Revised plan body.');
      }).pipe(run),
  );

  effectIt.effect('allocates distinct same-title, normalized, and numeric-suffix families under concurrent init', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const sharedTitle = 'Shared Roadmap';
      const requests = [
        ['name-exact-a', sharedTitle],
        ['name-exact-b', sharedTitle],
        ['name-case', 'SHARED roadmap'],
        ['name-suffix', 'Shared Roadmap-2'],
      ] as const;
      const simultaneousResults = yield* Effect.forEach(
        requests.slice(0, 2),
        ([runId, title]) => f.call(initInput(f, runId, title)),
        {concurrency: 2},
      );
      const initialized = simultaneousResults.map(requireInitResult);
      const remainingResults = yield* Effect.forEach(
        requests.slice(2),
        ([runId, title]) => f.call(initInput(f, runId, title)),
        {concurrency: 2},
      );
      initialized.push(...remainingResults.map(requireInitResult));
      expect(new Set(initialized.map(item => item.bindingId)).size).toBe(requests.length);
      expect(initialized.slice(0, 3).map(item => item.naming.slug)).toEqual([
        'shared-roadmap',
        'shared-roadmap',
        'shared-roadmap',
      ]);
      expect(new Set(initialized.slice(0, 3).map(item => item.naming.ordinal)).size).toBe(3);
      expect(initialized[3].naming).toEqual({policyVersion: 1, slug: 'shared-roadmap-2', ordinal: 2});
    }).pipe(run),
  );

  effectIt.effect('allocates distinct families for titles that collide after truncation', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const longPrefix = 'x'.repeat(100);
      const requests = [
        ['name-long-a', `${longPrefix} left`],
        ['name-long-b', `${longPrefix} right`],
      ] as const;
      const results = yield* Effect.forEach(requests, ([runId, title]) => f.call(initInput(f, runId, title)), {
        concurrency: 2,
      });
      const initialized = results.map(requireInitResult);
      expect(new Set(initialized.map(item => item.bindingId)).size).toBe(2);
      expect(initialized[0].naming.slug).toBe('x'.repeat(80));
      expect(initialized[1].naming.slug).toBe('x'.repeat(80));
      expect(initialized[0].naming.ordinal).not.toBe(initialized[1].naming.ordinal);
    }).pipe(run),
  );

  effectIt.effect('allocates distinct untitled families for Unicode-only titles', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const requests = [
        ['name-unicode-a', '世界'],
        ['name-unicode-b', '計画'],
      ] as const;
      const results = yield* Effect.forEach(requests, ([runId, title]) => f.call(initInput(f, runId, title)), {
        concurrency: 2,
      });
      const initialized = results.map(requireInitResult);
      expect(new Set(initialized.map(item => item.bindingId)).size).toBe(2);
      expect(initialized[0].naming.slug).toBe('untitled');
      expect(initialized[1].naming.slug).toBe('untitled');
      expect(initialized[0].naming.ordinal).not.toBe(initialized[1].naming.ordinal);
    }).pipe(run),
  );

  effectIt.effect('retries an interrupted reservation with the exact reserved family', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      requireInitResult(yield* f.call(initInput(f, 'unrelated-run', 'Unrelated Reservation')));
      const retryTitle = 'Interrupted Reservation';
      const statePath = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'retry-run.json',
      );
      const originalFs = yield* FileSystem.FileSystem;
      let interrupted = false;
      const failingFs = FileSystem.FileSystem.of({
        ...originalFs,
        rename: (from, to) =>
          !interrupted && to === statePath
            ? Effect.sync(() => {
                interrupted = true;
                throw new Error('Synthetic native state commit interruption');
              })
            : originalFs.rename(from, to),
      });
      const failedInit = yield* failure(
        f.call(initInput(f, 'retry-run', retryTitle)).pipe(Effect.provideService(FileSystem.FileSystem, failingFs)),
      );
      expect(failedInit._tag).toBe('Failure');
      expect(interrupted).toBe(true);
      expect(yield* f.fs.exists(statePath)).toBe(false);
      const registryBeforeRetry = yield* f.fs.readFileString(nameRegistryPath(f));
      const reservationsBeforeRetry = JSON.parse(registryBeforeRetry).reservations as {
        title: string;
        family: {slug: string; ordinal: number};
      }[];
      const previous = reservationsBeforeRetry.find(item => item.title === retryTitle)!.family;
      const recovered = requireInitResult(yield* f.call(initInput(f, 'retry-run', retryTitle)));
      expect(recovered.naming).toEqual({...previous, policyVersion: 1});
      expect(JSON.parse(yield* f.fs.readFileString(nameRegistryPath(f))).reservations).toHaveLength(
        reservationsBeforeRetry.length,
      );
      expect(yield* f.fs.readFileString(nameRegistryPath(f))).toBe(registryBeforeRetry);
      expect(yield* f.fs.readFileString(statePath)).toContain(retryTitle);
    }).pipe(run),
  );

  effectIt.effect(
    'skips unowned colliding filenames without overwriting them or authorizing a similar-prefix handoff',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        const durableRoot = 'threadnote://user/tester/memories/durable/projects/fixture';
        const handoffRoot = 'threadnote://user/tester/memories/handoffs/active/fixture';
        const seeded = [
          [`${durableRoot}/workflow-${'a'.repeat(64)}-root.md`, 'legacy document bytes'],
          [`${durableRoot}/workflow-reserved-plan-plan.md`, 'foreign artifact bytes'],
          [`${durableRoot}/workflow-reserved-plan-state.md`, 'foreign state bytes'],
          [`${handoffRoot}/workflow-reserved-plan-foreign.md`, 'foreign handoff bytes'],
        ] as const;
        for (const [uri, bytes] of seeded) yield* f.store.write(f.location, uri, bytes, {mode: 'create'});
        const legacyJournal = f.path.join(f.home, 'workflow-memory', `${'a'.repeat(64)}.json`);
        yield* f.fs.makeDirectory(f.path.dirname(legacyJournal), {recursive: true});
        yield* f.fs.writeFileString(legacyJournal, 'Original beta journal bytes.\n');

        const initialized = requireInitResult(yield* f.call(initInput(f, 'reserved-run', 'Reserved Plan')));
        expect(initialized.naming).toEqual({policyVersion: 1, slug: 'reserved-plan', ordinal: 2});
        const stateUri = `${handoffRoot}/workflow-reserved-plan-2-state.md`;
        expect(yield* f.store.read(f.location, stateUri)).toContain('"slug":"reserved-plan"');
        for (const [uri, bytes] of seeded) expect(yield* f.store.read(f.location, uri)).toBe(bytes);

        const denied = yield* failure(f.call({...f.base('read', 'reserved-run'), uri: seeded[3][0]}));
        expect(denied).toMatchObject({failure: {code: 'out-of-scope'}});
        for (const [uri, bytes] of seeded) expect(yield* f.store.read(f.location, uri)).toBe(bytes);
        expect(yield* f.fs.readFileString(legacyJournal)).toBe('Original beta journal bytes.\n');
      }).pipe(run),
  );

  effectIt.effect('rejects invalid name hints and title changes without adding owned records', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = requireInitResult(yield* f.call(initInput(f, 'invalid-name-run', 'Valid Title')));
      const statePath = f.statePath('invalid-name-run');
      const journalPath = f.journalPath(initialized.bindingId);
      const registryBefore = yield* f.fs.readFileString(nameRegistryPath(f));
      const stateBefore = yield* f.fs.readFileString(statePath);
      const journalBefore = yield* f.fs.readFileString(journalPath);
      const badHint = yield* failure(
        f.call(
          writeInput(f, 'invalid-name-run', {
            operationId: 'bad-name-hint',
            artifactKey: 'stable-key',
            role: 'root',
            nameHint: '../escape',
            body: 'Should not persist.\n',
          }),
        ),
      );
      expect(badHint).toMatchObject({failure: {code: 'invalid-request'}});
      const changedTitle = yield* failure(f.call(initInput(f, 'invalid-name-run', 'Different Title')));
      expect(changedTitle).toMatchObject({failure: {code: 'binding-drift'}});
      expect(yield* f.fs.readFileString(nameRegistryPath(f))).toBe(registryBefore);
      expect(yield* f.fs.readFileString(statePath)).toBe(stateBefore);
      expect(yield* f.fs.readFileString(journalPath)).toBe(journalBefore);
    }).pipe(run),
  );
});
