import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {reserveWorkflowNameFamily} from '../../src/workflow_automation/naming.js';
import {resolveWorkflowBinding} from '../../src/workflow_memory/profile.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import type {WorkflowBinding} from '../../src/workflow_memory/protocol.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);

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
  storageKind: 'durable' | 'handoff',
) => ({
  ...f.base('write', runId),
  action: 'write',
  operationId: 'write-plan',
  artifactKey: 'opaque-plan-key',
  role: 'root',
  nameHint: 'plan',
  body: 'A plan to archive safely.\n',
  expectedRevision: null,
  storageKind,
});

const readOutcome = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);

describe('native workflow naming corruption boundaries', () => {
  effectIt.effect(
    'rejects a malformed reservation before binding writes and permits retry after restoring its exact registry',
    () =>
      Effect.gen(function* () {
        for (const malformedLevel of ['root', 'reservation', 'family'] as const) {
          const f = yield* nativeFixture();
          const runId = `corrupt-${malformedLevel}`;
          const workflowRunId = `native-v1-${runId}`;
          const title = 'Corrupt Reservation';
          const system = yield* SystemInfo;
          const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
          const baseBinding = yield* resolveWorkflowBinding(f.config, {
            protocolVersion: 1,
            action: 'bind',
            workflowRunId,
            project: 'fixture',
            featureId: 'feature',
            generation: 'skill-generation-v1',
            profile: 'desktop',
          }).pipe(Effect.provideService(SystemInfo, scopedSystem));
          const family = yield* reserveWorkflowNameFamily(f.config, baseBinding, title);
          const registryPath = f.path.join(
            f.home,
            'workflow-automations',
            'names-v1',
            'fixture',
            'workflow-names.json',
          );
          const originalRegistry = yield* f.fs.readFileString(registryPath);
          const corrupt = JSON.parse(originalRegistry) as Record<string, unknown> & {
            reservations: Array<Record<string, unknown> & {family: Record<string, unknown>}>;
          };
          if (malformedLevel === 'root') corrupt.extra = true;
          else if (malformedLevel === 'reservation') corrupt.reservations[0].extra = true;
          else corrupt.reservations[0].family.extra = true;
          yield* f.fs.writeFileString(registryPath, JSON.stringify(corrupt));
          const corruptRegistry = yield* f.fs.readFileString(registryPath);

          const malformedRetry = yield* failure(f.call(initInput(f, runId, title)));
          const registryAfterFailure = yield* f.fs.readFileString(registryPath);
          const journalDirectory = f.path.join(f.home, 'workflow-memory');
          const journalEntries = (yield* f.fs.exists(journalDirectory))
            ? yield* f.fs.readDirectory(journalDirectory)
            : [];
          const journalExists = journalEntries.some(name => name.endsWith('.json'));
          const stateExists = yield* f.fs.exists(f.statePath(runId));
          const manifestUri =
            'threadnote://user/tester/memories/handoffs/active/fixture/workflow-corrupt-reservation-state.md';
          const manifestRead = yield* readOutcome(f.store.read(f.location, manifestUri));

          // Restore exact registry bytes before retrying, even when a no-write check is red.
          yield* f.fs.writeFileString(registryPath, originalRegistry);
          const restoredRetry = yield* failure(f.call(initInput(f, runId, title)));

          expect(malformedRetry._tag).toBe('Failure');
          expect(registryAfterFailure).toBe(corruptRegistry);
          expect(journalExists).toBe(false);
          expect(manifestRead._tag).toBe('Failure');
          expect(stateExists).toBe(false);
          expect(restoredRetry).toMatchObject({_tag: 'Success'});
          if (restoredRetry._tag === 'Success') expect(restoredRetry.success).toMatchObject({naming: family});
        }
      }).pipe(run),
  );

  effectIt.effect(
    'allocates archives in the original storage namespace and replays without replacing an occupied foreign name',
    () =>
      Effect.gen(function* () {
        for (const direction of [
          {original: 'durable', requested: 'handoff'},
          {original: 'handoff', requested: 'durable'},
        ] as const) {
          const f = yield* nativeFixture();
          const runId = `archive-${direction.original}`;
          const title = 'Archive Direction';
          const initialized = yield* f.call(initInput(f, runId, title));
          if (!('bindingId' in initialized)) throw new Error('Expected initialized native run.');
          const created = yield* f.call(writeInput(f, runId, direction.original));
          if (!('artifact' in created)) throw new Error('Expected created plan artifact.');
          const original = created.artifact;
          const originalRoot = direction.original === 'durable' ? 'durable/archived' : 'handoffs/archived';
          const activeUri =
            direction.original === 'durable'
              ? 'threadnote://user/tester/memories/durable/projects/fixture/workflow-archive-direction-plan.md'
              : 'threadnote://user/tester/memories/handoffs/active/fixture/workflow-archive-direction-plan.md';
          expect(original.uri).toBe(activeUri);
          const occupiedUri = `threadnote://user/tester/memories/${originalRoot}/fixture/workflow-archive-direction-plan-archive-1.md`;
          const foreignBytes = 'unowned archive candidate — keep byte-for-byte\n';
          yield* f.store.write(f.location, occupiedUri, foreignBytes, {mode: 'create'});

          const journalPath = f.journalPath(initialized.bindingId);
          const beforeArchiveJournal = JSON.parse(yield* f.fs.readFileString(journalPath)) as {
            binding: WorkflowBinding;
            artifacts: Record<string, {artifactKey: string; sourceRunId: string; role: string}>;
          };
          const source = beforeArchiveJournal.artifacts[original.uri];
          if (!source) throw new Error('Expected the new plan in the binding journal.');
          const system = yield* SystemInfo;
          const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
          const archiveRequest = {
            protocolVersion: 1 as const,
            action: 'archive' as const,
            bindingId: initialized.bindingId,
            operationId: `archive-${direction.original}-plan`,
            artifactKey: source.artifactKey,
            sourceRunId: source.sourceRunId,
            role: source.role,
            uri: original.uri,
            expectedRevision: original.revision,
            storageKind: direction.requested,
          };
          const archived = yield* runWorkflowMemory(f.config, archiveRequest).pipe(
            Effect.provideService(SystemInfo, scopedSystem),
          );
          const expectedUri = `threadnote://user/tester/memories/${originalRoot}/fixture/workflow-archive-direction-plan-archive-2.md`;
          expect(archived).toMatchObject({status: 'ok', canonicalUri: expectedUri, state: 'archived'});
          expect(yield* f.store.read(f.location, occupiedUri)).toBe(foreignBytes);
          expect((yield* readOutcome(f.store.read(f.location, original.uri)))._tag).toBe('Failure');
          expect(yield* f.store.read(f.location, expectedUri)).toContain('A plan to archive safely.');

          const journalAfterArchive = yield* f.fs.readFileString(journalPath);
          const journal = JSON.parse(journalAfterArchive) as {
            manifestUri: string;
          };
          const manifestAfterArchive = yield* f.store.read(f.location, journal.manifestUri);
          const replay = yield* runWorkflowMemory(f.config, archiveRequest).pipe(
            Effect.provideService(SystemInfo, scopedSystem),
          );
          expect(replay).toMatchObject({status: 'ok', canonicalUri: expectedUri, state: 'archived'});
          expect(yield* f.fs.readFileString(journalPath)).toBe(journalAfterArchive);
          expect(yield* f.store.read(f.location, journal.manifestUri)).toBe(manifestAfterArchive);
          expect(yield* f.store.read(f.location, occupiedUri)).toBe(foreignBytes);
        }
      }).pipe(run),
  );
});
