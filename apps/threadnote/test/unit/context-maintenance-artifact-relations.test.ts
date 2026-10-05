import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {collectContextHealth} from '@threadnote/threadnote/memory/context/health_commands';
import {
  migrateMaintenanceCases,
  readContextMaintenanceStatus,
  resolveMaintenanceRelationPolicy,
  runContextMaintenance,
  safeRelationRemoval,
  updateMaintenanceCase,
} from '@threadnote/threadnote/memory/context/maintenance';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const ROOT = 'threadnote://user/tester/memories/';
const ARTIFACT = `${ROOT}agent-artifacts/skills/claude/review-pr/SKILL.md`;
const NOW = '2026-10-05T08:00:00.000Z';

function source(shared: boolean, relations: readonly MemoryRelation[]) {
  const uri = `${ROOT}${shared ? 'shared/default/' : ''}durable/projects/threadnote/source.md`;
  return parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        schemaVersion: 2,
        memoryId: 'tn_source',
        project: 'threadnote',
        sourceAgentClient: 'codex',
        topic: 'source',
        timestamp: NOW,
        relations,
      },
      'Synthetic context.',
    ),
  )!;
}

function fixture(shared: boolean, relations: readonly MemoryRelation[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'artifact-relation-maintenance-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    const record = source(shared, relations);
    const file = path.join(root, record.uri.slice(ROOT.length));
    yield* fs.makeDirectory(path.dirname(file), {recursive: true});
    yield* fs.writeFileString(file, record.content);
    const config: RuntimeConfig = {
      account: 'local',
      user: 'tester',
      agentId: 'threadnote',
      agentContextHome: home,
      manifestPath: path.join(home, 'threadnote.json'),
    };
    return {fs, path, home, root, file, record, config};
  });
}

function decision(record: ReturnType<typeof source>, family: string, slot: string) {
  return {
    ...updateMaintenanceCase(
      undefined,
      {
        project: 'threadnote',
        memoryId: 'tn_source',
        family,
        slot,
        disposition: 'needs-decision',
        reason:
          family === 'relation' ? 'relation-target-unresolved' : 'shared-canonical-relations-require-owner-review',
        evidenceRevision: 'legacy-revision',
      },
      NOW,
    ),
    subjectContentHashes: [{uri: record.uri, hash: sha256HexSync(canonicalMemoryDocumentContent(record.content))}],
  };
}

describe('artifact relation maintenance', () => {
  fcEffectProp(
    effectIt,
    'artifact domains preserve bytes and links without memory-repair decisions',
    {
      shared: fc.boolean(),
      sharedArtifact: fc.boolean(),
      present: fc.boolean(),
      body: fc.string({maxLength: 64}),
      type: fc.constantFrom('depends_on', 'references', 'related_to', 'supersedes', 'evidence_for'),
    },
    ({shared, sharedArtifact, present, body, type}) =>
      Effect.gen(function* () {
        const uri = sharedArtifact ? ARTIFACT.replace('/memories/', '/memories/shared/default/') : ARTIFACT;
        const relation = {type, uri};
        const f = yield* fixture(shared, [relation]);
        const artifact = f.path.join(f.root, uri.slice(ROOT.length));
        const content = `---\nname: synthetic-tool\n---\n${body}`;
        if (present) {
          yield* f.fs.makeDirectory(f.path.dirname(artifact), {recursive: true});
          yield* f.fs.writeFileString(artifact, content);
        }
        expect(resolveMaintenanceRelationPolicy(f.record, relation, [f.record]).state).toBe('unknown');
        expect(safeRelationRemoval(f.record, [f.record])).toEqual([]);
        const health = yield* collectContextHealth(f.config, 'threadnote', [f.record], f.home);
        expect(health.findings.filter(item => item.category.startsWith('relation-target-'))).toEqual([]);
        const result = yield* runContextMaintenance(f.config, {cwd: f.home});
        expect(result.error).toBeUndefined();
        expect(result.preparation).toMatchObject({complete: true, admittedRecords: 1});
        expect(result.cases.filter(item => ['relation', 'shared-owner-proposal'].includes(item.family))).toEqual([]);
        expect(result.receipts).toEqual([]);
        expect(yield* f.fs.readFileString(f.file)).toBe(f.record.content);
        if (present) expect(yield* f.fs.readFileString(artifact)).toBe(content);
        else expect(yield* f.fs.exists(artifact)).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12, seed: 74651}},
  );

  for (const shared of [false, true]) {
    effectIt.effect(
      `cleans stored artifact decisions with a current ${shared ? 'shared' : 'personal'} checkpoint`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(shared, [{type: 'depends_on', uri: ARTIFACT}]);
          const artifact = f.path.join(f.root, ARTIFACT.slice(ROOT.length));
          yield* f.fs.makeDirectory(f.path.dirname(artifact), {recursive: true});
          yield* f.fs.writeFileString(artifact, '---\nname: synthetic-tool\n---\nSynthetic bundle.');
          yield* runContextMaintenance(f.config, {cwd: f.home});
          const stateFile = f.path.join(f.home, 'context-maintenance', 'state-v2.json');
          const state = JSON.parse(yield* f.fs.readFileString(stateFile));
          expect(Object.keys(state.checkpoints)).toHaveLength(1);
          expect(state.workSchedule.nextPhase).toBe('semantic');
          const checkpoints = structuredClone(state.checkpoints);
          state.cases = [
            decision(f.record, 'relation', ARTIFACT),
            ...(shared ? [decision(f.record, 'shared-owner-proposal', 'relations')] : []),
          ];
          state.state = 'needs-decision';
          yield* f.fs.writeFileString(stateFile, JSON.stringify(state));
          const resumed = yield* runContextMaintenance(f.config, {cwd: f.home});
          expect(resumed.cases.filter(item => ['relation', 'shared-owner-proposal'].includes(item.family))).toEqual([]);
          expect(resumed.receipts).toEqual([]);
          expect((yield* readContextMaintenanceStatus(f.config)).cases).toEqual([]);
          expect(JSON.parse(yield* f.fs.readFileString(stateFile)).checkpoints).toEqual(checkpoints);
          expect(yield* f.fs.readFileString(f.file)).toBe(f.record.content);
          expect(yield* f.fs.readFileString(artifact)).toBe('---\nname: synthetic-tool\n---\nSynthetic bundle.');
        }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }

  it('migrates artifact cases idempotently and preserves genuine unknown-memory decisions', () => {
    fc.assert(
      fc.property(fc.constantFrom('', 'depends_on:', 'references:'), prefix => {
        const record = source(true, [{type: 'depends_on', uri: ARTIFACT}]);
        const artifact = decision(record, 'relation', `${prefix}${ARTIFACT}`);
        const unknown = decision(record, 'relation', 'threadnote://memory/tn_unavailable');
        const owner = decision(record, 'shared-owner-proposal', 'relations');
        const migrated = migrateMaintenanceCases([artifact, unknown, owner], [record], undefined, true);
        expect(migrated).toEqual([unknown]);
        expect(migrateMaintenanceCases(migrated, [record])).toEqual(migrated);
        const mixed = source(true, [
          {type: 'depends_on', uri: ARTIFACT},
          {type: 'depends_on', uri: unknown.slot},
        ]);
        const mixedOwner = decision(mixed, 'shared-owner-proposal', 'relations');
        expect(migrateMaintenanceCases([mixedOwner], [mixed], undefined, true)).toEqual([mixedOwner]);
        expect(migrateMaintenanceCases([owner], [mixed], undefined, true)).toEqual([owner]);
        expect(migrateMaintenanceCases([owner])).toEqual([owner]);
        // A cached subject can match its old proof while the canonical inventory is still being refreshed.
        expect(migrateMaintenanceCases([artifact, owner], [record], undefined, false)).toEqual([owner]);
        expect(migrateMaintenanceCases([{...owner, subjectContentHashes: []}], [record], undefined, true)).toEqual([
          {...owner, subjectContentHashes: []},
        ]);
        const staleOwner = {...owner, subjectContentHashes: [{uri: record.uri, hash: 'stale'}]};
        expect(migrateMaintenanceCases([staleOwner], [record], undefined, true)).toEqual([staleOwner]);
        for (const status of ['active', 'archived'] as const) {
          const target = parseMemoryDocument(
            `${ROOT}durable/projects/threadnote/target.md`,
            formatMemoryDocument(
              'MEMORY',
              {...record.metadata, memoryId: 'tn_target', status, relations: []},
              'Target.',
            ),
          )!;
          const mixedResolved = source(true, [
            {type: 'depends_on', uri: ARTIFACT},
            {type: 'references', uri: target.uri},
          ]);
          const resolvedOwner = decision(mixedResolved, 'shared-owner-proposal', 'relations');
          expect(migrateMaintenanceCases([resolvedOwner], [mixedResolved, target], undefined, true)).toEqual([]);
          expect(
            migrateMaintenanceCases([resolvedOwner], [mixedResolved, target, {...target}], undefined, true),
          ).toEqual([resolvedOwner]);
        }
      }),
      {numRuns: 12, seed: 74652},
    );
  });
});
