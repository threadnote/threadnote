import {Array as EffectArray, Effect, Option as EffectOption} from 'effect';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {NativeCycleState} from '@threadnote/workflow-automations/cycle';
import type {NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {
  nativeCycleCoverage,
  nativeCycleWaiverFor,
  nativeCycleWaiverId,
  type NativeCycleRuntime,
} from '@threadnote/workflow-automations/cycle-runtime';
import {nativeNext, nativeRefusal, nativeWaivableGateIds} from '@threadnote/workflow-automations/gates';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const required = (value: string | undefined, name: string) =>
  value === undefined ? Effect.fail(fail('invalid-request', 'Provide ' + name + '.')) : Effect.succeed(value);

/** Record, or replay, one audited waiver of a review gate for one exact phase tree. */
export const recordNativeCycleWaiver = Effect.fn('workflowAutomation.cycle.waive')(function* <E, R>(input: {
  readonly repo: string;
  readonly request: {
    readonly runId: string;
    readonly gate?: string;
    readonly reason?: string;
    readonly userAuthority?: string;
  };
  readonly runtime: NativeCycleRuntime;
  readonly revision: string;
  readonly phase: NativeCycleState['plan']['phases'][number];
  readonly snapshot: NativeCycleSnapshot;
  readonly save: (value: NativeCycleRuntime) => Effect.Effect<string, E, R>;
}) {
  const {repo, request, runtime, phase: selected, snapshot} = input;
  const gate = EffectOption.getOrUndefined(EffectArray.findFirst(nativeWaivableGateIds, item => item === request.gate));
  if (!gate)
    return yield* nativeRefusal(
      'invalid-waiver',
      'Only review.required and review.blocking take a waiver; intent changes need a confirmation.',
      {next: nativeNext.view({runId: request.runId, callerCwd: repo})},
    );
  if (snapshot.phaseId !== selected.id)
    return yield* fail('invalid-waiver', 'A waiver covers a snapshot of its own phase.');
  // A review.blocking waiver accepts the findings of the review that covers the tree, so it needs one with blockers.
  const coverage = gate === 'review.blocking' ? nativeCycleCoverage(runtime, snapshot) : undefined;
  if (coverage && (coverage._tag !== 'reviewed' || !coverage.blocked))
    return yield* nativeRefusal(
      'invalid-waiver',
      'A review.blocking waiver accepts the blockers of a recorded review of this tree, and none is recorded.',
      {
        next:
          coverage._tag === 'pending'
            ? nativeNext.review({runId: request.runId, callerCwd: repo})
            : nativeNext.view({runId: request.runId, callerCwd: repo}),
      },
    );
  const target = coverage?._tag === 'reviewed' ? coverage.snapshot : snapshot;
  const fields = {
    gate,
    phaseId: selected.id,
    snapshotId: target.snapshotId,
    tree: target.tree,
    intentHash: target.intentHash ?? target.phaseHash,
    reason: yield* required(request.reason, 'a concrete waiver reason'),
    userAuthority: yield* required(request.userAuthority, 'the explicit human authority'),
  };
  // A waiver that already covers the target replays: a review.required waiver for any snapshot of its tree
  // under the same intent, a review.blocking waiver only for the review it accepted.
  const existing = nativeCycleWaiverFor(runtime, gate, target);
  if (existing) return {status: 'ok', revision: input.revision, replayed: true, waiver: existing};
  const id = nativeCycleWaiverId(fields);
  const waiver = {id, ...fields};
  return {
    status: 'ok',
    revision: yield* input.save({...runtime, waivers: [...(runtime.waivers ?? []), waiver]}),
    replayed: false,
    waiver,
  };
});
