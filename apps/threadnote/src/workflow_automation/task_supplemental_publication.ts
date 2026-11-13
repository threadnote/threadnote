import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {NativeCycleSupplementalPublication} from '@threadnote/workflow-automations/cycle';
import {
  appendNativeCycleSupplementalRecord,
  initializeNativeCycleSupplementalPublication,
  nativeCycleSupplementalRef,
  nativeCycleSupplementalRevision,
} from '@threadnote/workflow-automations/cycle-runtime';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {Effect, FileSystem, Path, Array as EffectArray, Option, String as EffectString} from 'effect';
import * as Clock from 'effect/Clock';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {bindNativeCycleDeliveryBase, verifyNativeCycleDeliveryRepository} from './cycle_delivery.js';
import {nativeWorkflowError} from './memory.js';
import {readNativeWorkflowState, withNativeWorkflowLock, writeNativeWorkflowState} from './store.js';
import type {NativeTaskCycleRuntime, NativeTaskStoredState} from './task_action_helpers.js';
import {fail} from './task_action_helpers.js';
import {verifyNativeWatchBoundPr} from './watch_provider.js';
import {readNativeWatch} from './watch_store.js';
import {runOwnedNativeTaskWatch} from './task_candidate_watch.js';
import {nativeWatchOwnerDigest} from './watch_store.js';
import type {NativeTaskPrWatchFields} from './task_actions.js';

type Pr = NativeCycleSupplementalPublication['initialization']['pr'];
export interface NativeTaskSupplementalPublicationRequest extends Omit<NativeTaskPrWatchFields, 'operation'> {
  readonly command: 'supplemental-publication';
  readonly runId: string;
  readonly operation: 'attach' | NativeTaskPrWatchFields['operation'];
  readonly taskRef?: string;
  readonly supplementalRef?: string;
  readonly pr?: Pr;
  readonly userAuthority?: string;
}
const digest = (value: unknown) => sha256HexSync(stableJson(value));
const source = Effect.fn('workflowTask.supplementalSource')(function* (
  checkout: string,
  init: {head: string; tree: string; pr: Pr},
) {
  const git = (args: string[]) =>
    runCommandEffect('git', ['--no-optional-locks', '-C', checkout, ...args], {
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
  const branch = EffectString.trim((yield* git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout);
  const head = EffectString.trim((yield* git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout);
  const tree = EffectString.trim((yield* git(['rev-parse', '--verify', 'HEAD^{tree}'])).stdout);
  const clean = (yield* git(['status', '--porcelain=v2', '-z', '--ignore-submodules=none'])).stdout.length === 0;
  if (!clean || branch !== init.pr.branch || head !== init.head || tree !== init.tree)
    return yield* fail(
      'supplemental-source-drift',
      'Changed or dirty source requires the ordinary development cycle and fresh validation.',
    );
  return {head, tree, clean};
});
const supplementalRef = (stored: NativeTaskStoredState, publication: NativeCycleSupplementalPublication) => {
  const init = publication.initialization;
  return encodeNativeTaskActionRef({
    version: 1,
    kind: 'supplemental-publication',
    runId: stored.state.runId,
    generationHash: sha256HexSync(stored.state.generation),
    stateRevision: stored.revision,
    phaseId: init.phaseId,
    phaseHash: init.phaseHash,
    snapshotId: init.snapshotId,
    sourceHead: init.head,
    sourceTree: init.tree,
    publicationId: publication.publicationId,
    publicationRef: nativeCycleSupplementalRef(publication),
    payloadDigest: nativeCycleSupplementalRevision(stored.state.cycle!),
  });
};
const output = (stored: NativeTaskStoredState, publication: NativeCycleSupplementalPublication, replayed = false) => ({
  status: 'supplemental-publication-updated' as const,
  replayed,
  publicationId: publication.publicationId,
  supplementalRef: supplementalRef(stored, publication),
  publicationRef: nativeCycleSupplementalRef(publication),
  revision: stored.revision,
  prUrl: publication.initialization.pr.url,
  records: publication.records.length,
  completed: EffectArray.some(publication.records, item => item.event.kind === 'completed'),
});

/** Verify an existing PR and append supplemental proof; original local delivery and closeout are retained. */
export const runNativeTaskSupplementalPublication = (
  config: RuntimeConfig,
  request: NativeTaskSupplementalPublicationRequest,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const publications = runtime.state.supplementalPublications ?? [];
    if (request.operation === 'attach') {
      const ref = request.taskRef ? decodeNativeTaskActionRef(request.taskRef) : undefined;
      if (
        !ref ||
        ref.kind !== 'task' ||
        ref.taskAction !== 'complete' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !request.phaseId ||
        !request.pr ||
        !(request.userAuthority && EffectString.trim(request.userAuthority))
      )
        return yield* fail(
          'invalid-supplemental-authority',
          'Attach requires the completed task reference, phase, existing PR receipt and actual supplied authority.',
        );
      const phaseId = request.phaseId;
      const prior = Option.getOrUndefined(
        EffectArray.findFirst(publications, item => item.initialization.taskRefDigest === digest(request.taskRef)),
      );
      if (prior) {
        const init = prior.initialization;
        const {baseRefBinding: _binding, ...pr} = init.pr;
        if (
          init.phaseId !== phaseId ||
          stableJson(pr) !== stableJson(request.pr) ||
          init.authority !== request.userAuthority
        )
          return yield* fail(
            'supplemental-replay-conflict',
            'The attachment request differs from the immutable supplemental receipt.',
          );
        yield* source(checkout, init);
        const observed = yield* verifyNativeWatchBoundPr(init.pr.url, {
          head: init.head,
          baseBranch: init.pr.baseBranch,
          headBranch: init.pr.branch,
        });
        const merged =
          init.pr.state === 'merged' ||
          EffectArray.some(
            prior.records,
            record =>
              record.event.kind === 'merged' ||
              (record.event.kind === 'provider-verified' && record.event.pr.state === 'merged'),
          );
        if (observed.state === 'closed' || (merged && observed.state !== 'merged'))
          return yield* fail(
            'supplemental-lifecycle-drift',
            'Exact attachment replay permits only retained or forward PR lifecycle state.',
          );
        return output(stored, prior, true);
      }
      if (ref.stateRevision !== stored.revision)
        return yield* fail('stale-task-ref', 'Use the current completed task reference for supplemental attachment.');
      const definition = Option.getOrUndefined(
        EffectArray.findFirst(runtime.state.plan.phases, item => item.id === phaseId),
      );
      const phase = runtime.state.phases[phaseId];
      const snapshot = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === phaseId).at(
        -1,
      )?.snapshot;
      if (!definition || !phase?.validation || phase.delivery?.delivery !== 'local' || !snapshot)
        return yield* fail(
          'supplemental-local-proof-required',
          'Supplemental publication requires exact completed local proof.',
        );
      const receipt = {
        phaseId,
        phaseHash: phase.phaseHash,
        delivery: 'pr' as const,
        headSha: phase.head!,
        validatedTree: phase.tree!,
        pr: request.pr,
      };
      const bound = yield* bindNativeCycleDeliveryBase(checkout, definition.baseBranch, receipt);
      if (!bound.pr) return yield* fail('invalid-pr-receipt', 'The existing PR receipt has no destination.');
      yield* verifyNativeCycleDeliveryRepository(checkout, bound);
      const initialization = {
        version: 1 as const,
        expectedRevision: nativeCycleSupplementalRevision(runtime),
        planDigest: digest(runtime.state.plan),
        phaseId,
        phaseHash: phase.phaseHash,
        snapshotId: snapshot.snapshotId,
        validationDigest: digest(phase.validation),
        localReceiptDigest: digest(phase.delivery),
        head: phase.head!,
        tree: phase.tree!,
        pr: bound.pr,
        authority: request.userAuthority,
        taskRefDigest: digest(request.taskRef),
      };
      yield* source(checkout, initialization);
      const observed = yield* verifyNativeWatchBoundPr(bound.pr.url, {
        head: initialization.head,
        baseBranch: bound.pr.baseBranch,
        headBranch: bound.pr.branch,
        state: bound.pr.state,
      });
      return yield* withNativeWorkflowLock(
        config,
        request.runId,
        false,
        Effect.gen(function* () {
          const current = yield* readNativeWorkflowState(config, request.runId);
          if (!current?.state.cycle || current.revision !== stored.revision)
            return yield* fail('state-conflict', 'The native task changed during supplemental provider verification.');
          const exactSource = yield* source(checkout, initialization);
          let updated = yield* Effect.try({
            try: () => initializeNativeCycleSupplementalPublication(current.state.cycle!, initialization, exactSource),
            catch: nativeWorkflowError,
          });
          const created = updated.state.supplementalPublications!.at(-1)!;
          updated = yield* Effect.try({
            try: () =>
              appendNativeCycleSupplementalRecord(
                updated,
                {
                  publicationId: created.publicationId,
                  publicationRef: nativeCycleSupplementalRef(created),
                  expectedRevision: nativeCycleSupplementalRevision(updated),
                  event: {kind: 'provider-verified', pr: bound.pr, evidence: `github-exact-pr:${digest(observed)}`},
                },
                exactSource,
              ),
            catch: nativeWorkflowError,
          });
          const written = yield* writeNativeWorkflowState(config, {...current.state, cycle: updated}, current.revision);
          return output(written, updated.state.supplementalPublications!.at(-1)!);
        }),
      );
    }
    const ref = request.supplementalRef ? decodeNativeTaskActionRef(request.supplementalRef) : undefined;
    const publication = Option.getOrUndefined(
      EffectArray.findFirst(publications, item => item.publicationId === ref?.publicationId),
    );
    if (
      !ref ||
      ref.kind !== 'supplemental-publication' ||
      ref.runId !== request.runId ||
      ref.generationHash !== sha256HexSync(stored.state.generation) ||
      !publication ||
      ref.phaseId !== publication.initialization.phaseId ||
      ref.phaseHash !== publication.initialization.phaseHash ||
      ref.snapshotId !== publication.initialization.snapshotId ||
      ref.sourceHead !== publication.initialization.head ||
      ref.sourceTree !== publication.initialization.tree
    )
      return yield* fail(
        'invalid-supplemental-ref',
        'Use the opaque supplemental publication reference for this exact owner.',
      );
    const init = publication.initialization;
    const historical = request.operation === 'inspect' || request.operation === 'stop';
    const completed = EffectArray.some(publication.records, item => item.event.kind === 'completed');
    const knownRef =
      ref.publicationRef === nativeCycleSupplementalRef(publication) ||
      EffectArray.some(publication.records, item => item.previousRef === ref.publicationRef);
    if (
      !knownRef ||
      (!historical &&
        !(request.operation === 'complete' && completed) &&
        (ref.stateRevision !== stored.revision || ref.publicationRef !== nativeCycleSupplementalRef(publication)))
    )
      return yield* fail('stale-supplemental-ref', 'Reload the current supplemental publication reference.');

    if (!historical) yield* source(checkout, init);

    const identity = EffectString.slice(0, 48)(sha256HexSync(`${request.runId}\n${publication.publicationId}`));
    const watchId = `sup-${identity}`;
    const consumerId = `sup-task-${identity}`;
    const owner = {
      kind: 'supplemental-publication' as const,
      runId: request.runId,
      generationHash: sha256HexSync(stored.state.generation),
      publicationId: publication.publicationId,
      head: init.head,
      tree: init.tree,
      phaseId: init.phaseId,
      prUrl: init.pr.url,
    };
    const binding = {
      owner,
      watchId,
      consumerId,
      wakeupId: consumerId,
      refBase: {
        version: 1 as const,
        kind: 'delivery' as const,
        runId: request.runId,
        generationHash: owner.generationHash,
        payloadDigest: nativeWatchOwnerDigest(owner),
        watchId,
        consumerId,
        wakeupId: consumerId,
      },
    };
    if (request.operation !== 'complete') {
      if (request.operation === 'renew')
        return yield* fail(
          'unsupported-supplemental-operation',
          'Use the current supplemental start or owned continuation route.',
        );
      if (!historical)
        yield* verifyNativeWatchBoundPr(init.pr.url, {
          head: init.head,
          baseBranch: init.pr.baseBranch,
          headBranch: init.pr.branch,
          ...(request.operation === 'start' ? {state: 'open' as const} : {}),
        });
      if (request.operation === 'inspect' && !(yield* readNativeWatch(config, watchId)))
        return output(stored, publication);
      const result = yield* runOwnedNativeTaskWatch(config, {...request, operation: request.operation}, binding);
      return {...output(stored, publication), ...result};
    }
    const observed = yield* verifyNativeWatchBoundPr(init.pr.url, {
      head: init.head,
      baseBranch: init.pr.baseBranch,
      headBranch: init.pr.branch,
    });
    const watch = yield* readNativeWatch(config, watchId);
    const events: unknown[] = [];
    if (observed.state === 'closed')
      return yield* fail('supplemental-pr-closed', 'A closed unmerged PR cannot complete publication.');
    const merged =
      init.pr.state === 'merged' || EffectArray.some(publication.records, item => item.event.kind === 'merged');
    if (completed && (observed.state === 'open' || merged)) return output(stored, publication, true);
    if (ref.stateRevision !== stored.revision || ref.publicationRef !== nativeCycleSupplementalRef(publication))
      return yield* fail(
        'stale-supplemental-ref',
        'Use the current publication reference for a new merge observation.',
      );
    if (
      observed.state === 'merged' &&
      init.pr.state !== 'merged' &&
      !EffectArray.some(publication.records, item => item.event.kind === 'merged')
    ) {
      if (!observed.mergeCommit)
        return yield* fail('supplemental-merge-proof', 'Merged publication requires the actual provider merge commit.');
      events.push({kind: 'merged', mergeCommit: observed.mergeCommit, evidence: `github-exact-pr:${digest(observed)}`});
    }
    if (observed.state === 'open') {
      const now = yield* Clock.currentTimeMillis;
      const notification = watch?.envelope.notification;
      const consumer = watch?.envelope.state.consumer;
      const hostReceipt = notification?.lastReceipt?.receipt ?? notification?.outbox?.receipt;
      if (
        !watch ||
        stableJson(watch.envelope.owner) !== stableJson(owner) ||
        watch.envelope.state.pr !== init.pr.url ||
        watch.envelope.state.head !== init.head ||
        watch.envelope.state.prState !== 'open' ||
        watch.envelope.stopRequested ||
        !consumer ||
        consumer.id !== consumerId ||
        consumer.wakeupId !== consumerId ||
        consumer.leaseUntil <= now ||
        notification?.consumerId !== consumerId ||
        notification?.wakeupId !== consumerId ||
        !hostReceipt ||
        !['running', 'starting'].includes(watch.envelope.collector?.status ?? '')
      )
        return yield* fail(
          'supplemental-watch-not-ready',
          'Completion requires the exact active supplemental watch and actual host receipt.',
        );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      events.push({
        kind: 'watch',
        watch: {
          prUrl: init.pr.url,
          headSha: init.head,
          state: 'active',
          stateDir: path.join(yield* fs.realPath(config.agentContextHome), 'workflow-automations', 'native-watch-v1'),
          consumerKind: 'orchestrator',
          consumerId,
          evidence: `native-watch-revision:${watch.revision};host-receipt:${hostReceipt}`,
        },
      });
    }
    if (!completed) events.push({kind: 'completed', evidence: `github-exact-pr:${digest(observed)}`});
    const retainedPublication = publication;
    return yield* withNativeWorkflowLock(
      config,
      request.runId,
      false,
      Effect.gen(function* () {
        const current = yield* readNativeWorkflowState(config, request.runId);
        if (!current?.state.cycle || current.revision !== stored.revision)
          return yield* fail('state-conflict', 'The native task changed during supplemental completion.');
        if (watch) {
          const after = yield* readNativeWatch(config, watchId);
          if (after?.revision !== watch.revision)
            return yield* fail('supplemental-watch-conflict', 'The supplemental watch changed during completion.');
        }
        const exactSource = yield* source(checkout, init);
        let updated = current.state.cycle;
        for (const event of events) {
          const currentPublication = Option.getOrUndefined(
            EffectArray.findFirst(
              updated.state.supplementalPublications!,
              item => item.publicationId === retainedPublication.publicationId,
            ),
          )!;
          updated = yield* Effect.try({
            try: () =>
              appendNativeCycleSupplementalRecord(
                updated,
                {
                  publicationId: retainedPublication.publicationId,
                  publicationRef: nativeCycleSupplementalRef(currentPublication),
                  expectedRevision: nativeCycleSupplementalRevision(updated),
                  event,
                },
                exactSource,
              ),
            catch: nativeWorkflowError,
          });
        }
        const written = yield* writeNativeWorkflowState(config, {...current.state, cycle: updated}, current.revision);
        return output(
          written,
          Option.getOrUndefined(
            EffectArray.findFirst(
              updated.state.supplementalPublications!,
              item => item.publicationId === retainedPublication.publicationId,
            ),
          )!,
        );
      }),
    );
  });
