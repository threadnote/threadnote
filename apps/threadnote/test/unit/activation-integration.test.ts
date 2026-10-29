import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {
  compareAndSetActivationReceiptV1,
  continueActivationV1,
  createActivationPlanV1,
  createActivationReceiptV1,
  initializeActivationStateV1,
  initializeActivationUndoReceiptV1,
  planActivationUndoV1,
  readActivationUndoReceiptV1,
  readActivationStateV1,
  recordActivationUndoCompletionV1,
} from '@threadnote/threadnote/activation/index';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const digest = (character: string) => Effect2.pipe(character, EffectString.repeat(64));
const input = {
  catalogSnapshotHash: digest('a'),
  primarySurfaceId: 'codex-cli',
  publicationMode: 'proposal' as const,
  repositoryIdentityHash: digest('b'),
  secondarySurfaceId: 'claude-code',
  selectedSourceSetHash: digest('c'),
  taskHash: digest('d'),
  teamId: 'default',
  teamShareStateHash: digest('e'),
  threadnoteVersion: '5.0.0-local.test',
};

const now = () => '2026-09-18T08:01:00.000Z';

describe('guided activation integration', () => {
  effectIt.effect('persists only strict plan/receipt files and performs receipt CAS', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-store-'});
        const config = {agentContextHome: home};
        const plan = createActivationPlanV1(input);
        const receipt = createActivationReceiptV1(plan, now());
        const state = yield* initializeActivationStateV1(config, plan, receipt);
        const loaded = yield* readActivationStateV1(config, plan.activationId);
        expect(loaded).toEqual(state);
        const root = path.join(home, 'activation', 'states', plan.activationId);
        expect((yield* fs.readDirectory(root)).sort()).toEqual(['plan.json', 'receipt.json']);
        expect(JSON.stringify(loaded)).not.toContain('/Users/');
        const stale = yield* compareAndSetActivationReceiptV1(config, plan.activationId, digest('f'), receipt);
        expect(stale).toMatchObject({actualRevision: receipt.revision, status: 'conflict'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes after interruption, stops at each approval boundary, and records a prompt first brief', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-resume-'});
        const config = {agentContextHome: home};
        const plan = createActivationPlanV1(input);
        const seen: string[] = [];
        const executor = {
          execute: ({operationId, plan: currentPlan}: {readonly operationId: string; readonly plan: typeof plan}) => {
            seen.push(operationId);
            const operation = EffectOption.getOrUndefined(
              EffectArray.findFirst(currentPlan.operations, candidate => candidate.id === operationId),
            )!;
            return Effect.succeed({
              ownership: 'preexisting' as const,
              status: operation.expectedOutcome,
              subsystemReceiptHash: digest(String(seen.length % 10)),
              undoEligible: false,
            });
          },
        };
        const preview = yield* continueActivationV1(config, {apply: false, now, plan}, executor);
        expect(preview.status).toBe('preview');
        expect(seen).toEqual([]);
        expect(yield* readActivationStateV1(config, plan.activationId)).toBeUndefined();
        yield* continueActivationV1(config, {apply: true, now, plan}, executor);
        const drift = yield* Effect.result(
          continueActivationV1(
            config,
            {apply: false, now, plan: createActivationPlanV1({...input, teamShareStateHash: digest('0')})},
            executor,
          ),
        );
        expect(drift).toMatchObject({_tag: 'Success', success: {status: 'drifted'}});
        const firstRun = yield* continueActivationV1(config, {apply: true, now, plan}, executor);
        expect(firstRun.status).toBe('awaiting-approval');
        expect(seen).toEqual(['surface-primary', 'surface-secondary', 'team-share', 'imports-preview']);
        const imports = yield* continueActivationV1(
          config,
          {apply: true, approval: {operationId: 'imports-review', reviewRevisionHash: digest('1')}, now, plan},
          executor,
        );
        expect(imports.status).toBe('awaiting-approval');
        expect(imports.state.receipt.firstBrief?.durationMilliseconds).toBeLessThan(10 * 60 * 1_000);
        expect(seen).toEqual([
          'surface-primary',
          'surface-secondary',
          'team-share',
          'imports-preview',
          'imports-review',
          'first-brief',
          'decision-review',
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('completes the offline proposal journey with content-free state and a bounded undo plan', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-golden-'});
        const config = {agentContextHome: home};
        const plan = createActivationPlanV1(input);
        let tick = 0;
        const clock = () => new Date(Date.parse('2026-09-18T08:00:00.000Z') + tick++ * 10_000).toISOString();
        let outcomes = 0;
        const executor = {
          execute: ({operationId, plan: currentPlan}: {readonly operationId: string; readonly plan: typeof plan}) => {
            const operation = EffectOption.getOrUndefined(
              EffectArray.findFirst(currentPlan.operations, candidate => candidate.id === operationId),
            )!;
            outcomes += 1;
            return Effect.succeed({
              ownership: operation.reversible ? ('activation-created' as const) : ('preexisting' as const),
              status: operation.expectedOutcome,
              subsystemReceiptHash: digest(String(outcomes % 10)),
              undoEligible: operation.reversible,
            });
          },
        };
        const first = yield* continueActivationV1(config, {apply: true, now: clock, plan}, executor);
        expect(first.status).toBe('awaiting-approval');
        const imports = yield* continueActivationV1(
          config,
          {apply: true, approval: {operationId: 'imports-review', reviewRevisionHash: digest('1')}, now: clock, plan},
          executor,
        );
        expect(imports.status).toBe('awaiting-approval');
        const applied = yield* continueActivationV1(
          config,
          {apply: true, approval: {operationId: 'decision-apply', reviewRevisionHash: digest('2')}, now: clock, plan},
          executor,
        );
        expect(applied.status).toBe('awaiting-approval');
        const completed = yield* continueActivationV1(
          config,
          {apply: true, approval: {operationId: 'decision-propose', reviewRevisionHash: digest('3')}, now: clock, plan},
          executor,
        );
        expect(completed.status).toBe('completed');
        expect(completed.state.receipt.firstBrief?.durationMilliseconds).toBeLessThan(10 * 60 * 1_000);
        expect(EffectArray.map(completed.state.receipt.operations, operation => operation.kind)).toContain(
          'decision.propose',
        );
        expect(EffectArray.map(completed.state.receipt.operations, operation => operation.kind)).not.toContain(
          'decision.publish',
        );
        const root = path.join(home, 'activation', 'states', plan.activationId);
        expect((yield* fs.readDirectory(root)).sort()).toEqual(['plan.json', 'receipt.json']);
        const persisted = `${yield* fs.readFileString(path.join(root, 'plan.json'))}${yield* fs.readFileString(
          path.join(root, 'receipt.json'),
        )}`;
        expect(persisted).not.toContain('Activate Threadnote');
        expect(persisted).not.toContain('/tmp/');
        const undo = planActivationUndoV1(plan, completed.state.receipt);
        expect(EffectArray.map(undo.operations, operation => operation.operationId)).toEqual([
          'decision-apply',
          'imports-review',
          'team-share',
          'surface-secondary',
          'surface-primary',
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('persists content-free undo progress and resumes each completed reversal exactly once', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-undo-'});
        const config = {agentContextHome: home};
        const plan = createActivationPlanV1(input);
        yield* initializeActivationStateV1(config, plan, createActivationReceiptV1(plan, now()));
        const initialized = yield* initializeActivationUndoReceiptV1(config, {
          activationId: plan.activationId,
          operationIds: ['surface-secondary', 'surface-primary'],
          publicationEvidenceHash: digest('e'),
          retainedOperationIds: ['decision-propose'],
          undoPlanHash: digest('f'),
        });
        const partial = yield* recordActivationUndoCompletionV1(config, {
          activationId: plan.activationId,
          expectedRevision: initialized.revision,
          operationId: 'surface-secondary',
        });
        expect(partial).toMatchObject({completedOperationIds: ['surface-secondary'], status: 'in-progress'});
        const completed = yield* recordActivationUndoCompletionV1(config, {
          activationId: plan.activationId,
          expectedRevision: partial.revision,
          operationId: 'surface-primary',
        });
        expect(completed.status).toBe('completed');
        expect(yield* readActivationUndoReceiptV1(config, plan.activationId)).toEqual(completed);
        const raw = yield* fs.readFileString(path.join(home, 'activation', 'states', plan.activationId, 'undo.json'));
        expect(raw).not.toContain('Activate Threadnote');
        expect(raw).not.toContain('/tmp/');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
