import {NativeCycleDeliverySchema, nextNativeCycle} from '@threadnote/workflow-automations/cycle';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCommandEffect} from '@threadnote/platform/command';
import {Effect, Array as EffectArray, FileSystem, Path, Predicate, Schema} from 'effect';
import * as Clock from 'effect/Clock';
import * as EffectString from 'effect/String';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {bindNativeCycleDeliveryBase, verifyNativeCycleDeliveryRepository} from './cycle_delivery.js';
import {runWorkflowAutomation} from './index.js';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskView} from './task.js';
import {runNativeWatch} from './watch.js';
import {readNativeWatch, withNativeWatchControlLock} from './watch_store.js';

import type {NativeTaskCycleRuntime, NativeTaskStoredState} from './task_action_helpers.js';
import {cycleRequest, fail, inCheckout, unwrapCycle} from './task_action_helpers.js';
import type {NativeTaskActionRequest} from './task_actions.js';

export const runNativeTaskCommitDelivery = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'deliver-commit'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const state = runtime.state;
    const ref = decodeNativeTaskActionRef(request.validationRef);
    if (
      !ref ||
      (ref.kind !== 'validation' && ref.kind !== 'delivery') ||
      ref.runId !== request.runId ||
      ref.generationHash !== sha256HexSync(stored.state.generation) ||
      !ref.phaseId ||
      !ref.phaseHash ||
      !ref.snapshotId ||
      !ref.sourceHead ||
      !ref.sourceTree ||
      !ref.payloadDigest
    )
      return yield* fail(
        'invalid-validation-ref',
        'Use the current canonical validation reference for commit delivery.',
      );
    if (state.plan.delivery !== 'commit')
      return yield* fail('delivery-scope', 'This task action supports commit delivery only.');
    const proof = state.phases[ref.phaseId];
    const snapshots = EffectArray.filter(
      runtime.snapshots,
      item =>
        item.snapshot.snapshotId === ref.snapshotId &&
        item.snapshot.phaseId === ref.phaseId &&
        item.snapshot.phaseHash === ref.phaseHash &&
        item.snapshot.head === ref.sourceHead &&
        item.snapshot.tree === ref.sourceTree,
    );
    if (snapshots.length !== 1)
      return yield* fail('snapshot-ambiguous', 'Commit delivery needs one unique canonical reviewed snapshot.');
    if (!proof || proof.phaseHash !== ref.phaseHash || proof.tree !== ref.sourceTree)
      return yield* fail('stale-validation-ref', 'The reference does not match current canonical phase validation.');
    const existingReceipt = proof.delivery;
    if (existingReceipt) {
      const existingDigest = sha256HexSync(stableJson(existingReceipt));
      if (
        existingReceipt.delivery !== 'commit' ||
        existingReceipt.phaseId !== ref.phaseId ||
        existingReceipt.phaseHash !== ref.phaseHash ||
        existingReceipt.validatedTree !== ref.sourceTree ||
        existingReceipt.commitEvidence !== request.commitEvidence ||
        (ref.kind === 'delivery' && ref.payloadDigest !== existingDigest)
      )
        return yield* fail('delivery-conflict', 'The phase already has a different canonical delivery receipt.');
      const deliveryRef = encodeNativeTaskActionRef({...ref, kind: 'delivery', payloadDigest: existingDigest});
      return {status: 'delivered', replayed: true, deliveryRef, receipt: existingReceipt, next: nextNativeCycle(state)};
    }
    const validationDigest = proof.validation ? sha256HexSync(stableJson(proof.validation)) : undefined;
    if (
      !proof.validation ||
      proof.head !== ref.sourceHead ||
      (ref.kind === 'validation' && validationDigest !== ref.payloadDigest)
    )
      return yield* fail('stale-validation-ref', 'The reference does not match current canonical phase validation.');
    if (ref.kind === 'delivery')
      return yield* fail('stale-delivery-ref', 'This delivery reference has no matching canonical receipt.');
    const readinessResult = yield* inCheckout(
      runWorkflowAutomation(config, cycleRequest(stored, {command: 'publication-ready', phaseId: ref.phaseId})),
      checkout,
    );
    const readinessValue: unknown = readinessResult;
    const readinessObject = Predicate.isObject(readinessValue) ? readinessValue : undefined;
    const readinessCycle =
      readinessObject && Predicate.isObject(readinessObject.cycle) ? readinessObject.cycle : undefined;
    const readinessHead = readinessCycle && typeof readinessCycle.head === 'string' ? readinessCycle.head : undefined;
    if (
      !readinessObject ||
      readinessObject.status !== 'ok' ||
      !readinessCycle ||
      readinessCycle.revision !== stored.revision ||
      !readinessHead ||
      readinessCycle.tree !== proof.tree
    )
      return yield* fail('source-drift', 'Commit delivery requires the exact clean validated source tree and branch.');
    const readiness = {head: readinessHead};
    const receipt = yield* Schema.decodeEffect(NativeCycleDeliverySchema, {onExcessProperty: 'error'})({
      phaseId: ref.phaseId,
      phaseHash: ref.phaseHash,
      delivery: 'commit',
      headSha: readiness.head,
      validatedTree: proof.tree,
      commitEvidence: request.commitEvidence,
    }).pipe(
      Effect.mapError(() =>
        fail('invalid-commit-receipt', 'The supplied commit evidence is not a valid canonical receipt.'),
      ),
    );
    const deliveryDigest = sha256HexSync(stableJson(receipt));
    const deliveryRef = encodeNativeTaskActionRef({...ref, kind: 'delivery', payloadDigest: deliveryDigest});
    // The cycle executor independently verifies clean source, exact validated tree,
    // declared branch, phase eligibility, and revision before it persists the receipt.
    const result = yield* inCheckout(
      runWorkflowAutomation(
        config,
        cycleRequest(stored, {
          command: 'record-delivery',
          phaseId: ref.phaseId,
          delivery: receipt,
          expectedRevision: stored.revision,
        }),
      ),
      checkout,
    );
    const cycle = unwrapCycle(result);
    const latest = yield* readNativeWorkflowState(config, request.runId);
    const persisted = latest?.state.cycle?.state.phases[ref.phaseId]?.delivery;
    if (!persisted || stableJson(persisted) !== stableJson(receipt))
      return yield* fail('delivery-not-recorded', 'The canonical commit receipt was not persisted exactly.');
    return {status: 'delivered', replayed: false, deliveryRef, receipt: persisted, next: cycle.next};
  });

export const runNativeTaskPrDelivery = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'deliver-pr'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const state = runtime.state;
    const ref = decodeNativeTaskActionRef(request.validationRef);
    if (
      !ref ||
      (ref.kind !== 'validation' && ref.kind !== 'delivery') ||
      ref.runId !== request.runId ||
      ref.generationHash !== sha256HexSync(stored.state.generation) ||
      !ref.phaseId ||
      !ref.phaseHash ||
      !ref.snapshotId ||
      !ref.sourceHead ||
      !ref.sourceTree ||
      !ref.payloadDigest
    )
      return yield* fail('invalid-validation-ref', 'Use the current canonical validation reference for PR delivery.');
    if (state.plan.delivery !== 'pr')
      return yield* fail('delivery-scope', 'This task action supports PR delivery only.');
    const matchingPhases = EffectArray.filter(state.plan.phases, item => item.id === ref.phaseId);
    const phase = matchingPhases.length === 1 ? matchingPhases[0] : undefined;
    const proof = state.phases[ref.phaseId];
    const validationDigest = proof?.validation ? sha256HexSync(stableJson(proof.validation)) : undefined;
    if (
      !phase ||
      !proof?.validation ||
      proof.phaseHash !== ref.phaseHash ||
      proof.head !== ref.sourceHead ||
      proof.tree !== ref.sourceTree ||
      (ref.kind === 'validation' && validationDigest !== ref.payloadDigest)
    )
      return yield* fail('stale-validation-ref', 'The reference does not match current canonical phase validation.');
    const snapshots = EffectArray.filter(
      runtime.snapshots,
      item =>
        item.snapshot.snapshotId === ref.snapshotId &&
        item.snapshot.phaseId === ref.phaseId &&
        item.snapshot.phaseHash === ref.phaseHash &&
        item.snapshot.head === ref.sourceHead &&
        item.snapshot.tree === ref.sourceTree,
    );
    if (snapshots.length !== 1)
      return yield* fail('snapshot-ambiguous', 'PR delivery needs one unique canonical reviewed snapshot.');
    if (request.pr.headSha !== proof.head || request.pr.branch !== phase.branch)
      return yield* fail('pr-source-mismatch', 'The supplied PR head and branch must match the validated phase.');
    const receipt = yield* Schema.decodeEffect(NativeCycleDeliverySchema, {onExcessProperty: 'error'})({
      phaseId: ref.phaseId,
      phaseHash: ref.phaseHash,
      delivery: 'pr',
      headSha: proof.head,
      validatedTree: proof.tree,
      commitEvidence: request.commitEvidence,
      pr: request.pr,
      publication: request.publication,
    }).pipe(
      Effect.mapError(() => fail('invalid-pr-receipt', 'The supplied PR evidence is not a valid canonical receipt.')),
    );
    const deliveryDigest = sha256HexSync(stableJson(receipt));
    if (proof.delivery) {
      const storedReceipt = proof.delivery;
      const storedPr = storedReceipt.pr;
      const suppliedPr = receipt.pr;
      const samePhysicalReceipt =
        storedPr !== undefined &&
        suppliedPr !== undefined &&
        stableJson({...storedPr, baseRefBinding: undefined}) === stableJson(suppliedPr);
      if (
        !samePhysicalReceipt ||
        storedReceipt.delivery !== receipt.delivery ||
        storedReceipt.phaseId !== receipt.phaseId ||
        storedReceipt.phaseHash !== receipt.phaseHash ||
        storedReceipt.headSha !== receipt.headSha ||
        storedReceipt.validatedTree !== receipt.validatedTree ||
        storedReceipt.commitEvidence !== receipt.commitEvidence ||
        stableJson(storedReceipt.publication) !== stableJson(receipt.publication) ||
        (ref.kind === 'delivery' && ref.payloadDigest !== sha256HexSync(stableJson(storedReceipt)))
      )
        return yield* fail('delivery-conflict', 'The phase already has a different canonical delivery receipt.');
      return {
        status: 'delivered',
        replayed: true,
        deliveryRef: encodeNativeTaskActionRef({
          ...ref,
          kind: 'delivery',
          payloadDigest: sha256HexSync(stableJson(storedReceipt)),
        }),
        receipt: storedReceipt,
        next: 'complete',
      };
    }
    if (ref.kind === 'delivery')
      return yield* fail('stale-delivery-ref', 'This delivery reference has no matching canonical receipt.');
    const task = yield* readNativeTaskView(config, {runId: request.runId, callerCwd: checkout, role: 'delivery'});
    if (task.status !== 'ready' || task.next.action !== 'deliver' || task.next.phaseId !== ref.phaseId)
      return yield* fail('task-not-ready', 'Follow the current delivery task card before publishing this phase.');
    const deliveryRef = encodeNativeTaskActionRef({
      ...ref,
      kind: 'delivery',
      payloadDigest: deliveryDigest,
      delivery: receipt,
    });
    const ready = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'publication-ready',
            phaseId: ref.phaseId,
            publication: request.publication,
          }),
        ),
        checkout,
      ),
    );
    if (ready.head !== proof.head || ready.tree !== proof.tree)
      return yield* fail('source-drift', 'The current source no longer matches the reviewed PR snapshot.');
    if (request.pr.state === 'open') {
      yield* bindNativeCycleDeliveryBase(checkout, phase.baseBranch, receipt);
      return {
        status: 'watch-required',
        replayed: false,
        deliveryRef,
        phaseId: phase.id,
        pr: request.pr,
        publication: request.publication,
        commitEvidence: request.commitEvidence,
        next: {
          action: 'watch-pr',
          runId: request.runId,
          phaseId: phase.id,
          validationRef: request.validationRef,
          prUrl: request.pr.url,
          headSha: proof.head,
          expectedConsumer:
            'A current task-bound watch route must claim this exact PR head before delivery is recorded.',
        },
      };
    }
    const finalReceipt = receipt;
    const result = unwrapCycle(
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'record-delivery',
            phaseId: ref.phaseId,
            delivery: finalReceipt,
            publication: request.publication,
            expectedRevision: stored.revision,
          }),
        ),
        checkout,
      ),
    );
    const latest = yield* readNativeWorkflowState(config, request.runId);
    const persisted = latest?.state.cycle?.state.phases[ref.phaseId]?.delivery;
    if (
      !persisted ||
      !persisted.pr ||
      stableJson({...persisted, pr: {...persisted.pr, baseRefBinding: undefined}}) !== stableJson(finalReceipt)
    )
      return yield* fail('delivery-not-recorded', 'The canonical PR receipt and authority readback do not match.');
    const persistedRef = encodeNativeTaskActionRef({
      ...ref,
      kind: 'delivery',
      payloadDigest: sha256HexSync(stableJson(persisted)),
      delivery: persisted,
    });
    return {status: 'delivered', replayed: false, deliveryRef: persistedRef, receipt: persisted, next: result.next};
  });

export const runNativeTaskPrWatch = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'watch-pr'}>,
  stored: NativeTaskStoredState,
  checkout: string,
) =>
  Effect.gen(function* () {
    const validation = decodeNativeTaskActionRef(request.validationRef);
    const deliveryAction = decodeNativeTaskActionRef(request.deliveryRef);
    const embeddedDelivery = deliveryAction?.delivery;
    if (
      !validation ||
      validation.runId !== request.runId ||
      validation.kind !== 'validation' ||
      validation.generationHash !== sha256HexSync(stored.state.generation) ||
      !validation.phaseId ||
      !validation.phaseHash ||
      !validation.snapshotId ||
      !validation.sourceHead ||
      !validation.sourceTree ||
      !deliveryAction ||
      deliveryAction.kind !== 'delivery' ||
      deliveryAction.runId !== request.runId ||
      deliveryAction.phaseId !== validation.phaseId ||
      deliveryAction.generationHash !== validation.generationHash ||
      !deliveryAction.payloadDigest ||
      !embeddedDelivery ||
      sha256HexSync(stableJson(embeddedDelivery)) !== deliveryAction.payloadDigest ||
      embeddedDelivery.delivery !== 'pr' ||
      (embeddedDelivery.pr?.state !== 'open' && embeddedDelivery.pr?.state !== 'merged') ||
      embeddedDelivery.headSha !== validation.sourceHead ||
      embeddedDelivery.validatedTree !== validation.sourceTree
    )
      return yield* fail(
        'invalid-delivery-ref',
        'Use the exact current open-PR delivery reference returned by the task card.',
      );
    const runtime = stored.state.cycle;
    if (!runtime) return yield* fail('cycle-not-found', 'This task has no admitted native cycle.');
    const phase = runtime.state.phases[validation.phaseId];
    const matchingSnapshots = EffectArray.filter(
      runtime.snapshots,
      item =>
        item.snapshot.snapshotId === validation.snapshotId &&
        item.snapshot.phaseId === validation.phaseId &&
        item.snapshot.phaseHash === validation.phaseHash &&
        item.snapshot.head === validation.sourceHead &&
        item.snapshot.tree === validation.sourceTree,
    );
    if (matchingSnapshots.length !== 1)
      return yield* fail('snapshot-ambiguous', 'The watch reference needs one unique canonical reviewed snapshot.');
    if (
      !phase ||
      phase.head !== validation.sourceHead ||
      phase.tree !== validation.sourceTree ||
      phase.phaseHash !== validation.phaseHash ||
      (phase.delivery !== undefined &&
        (phase.delivery.delivery !== 'pr' ||
          phase.delivery.pr?.url !== embeddedDelivery.pr.url ||
          phase.delivery.pr?.headSha !== embeddedDelivery.pr.headSha ||
          phase.delivery.pr?.branch !== embeddedDelivery.pr.branch ||
          phase.delivery.pr?.baseBranch !== embeddedDelivery.pr.baseBranch ||
          phase.delivery.commitEvidence !== embeddedDelivery.commitEvidence ||
          stableJson(phase.delivery.publication) !== stableJson(embeddedDelivery.publication)))
    )
      return yield* fail('stale-delivery-ref', 'The validated PR source changed; reload the current task card.');
    const watchIdentity = EffectString.slice(0, 48)(sha256HexSync(`${request.runId}\n${validation.phaseId}`));
    const watchId = `pr-${watchIdentity}`;
    // This is an internal lease owner key, never an authenticated person or provider identity.
    const consumerId = `task-${watchIdentity}`;
    const wakeupId = `task-${watchIdentity}`;
    const admitProvisionalWatch = () =>
      Effect.gen(function* () {
        if (phase.delivery !== undefined) return;
        if (
          embeddedDelivery.pr?.state !== 'open' ||
          typeof embeddedDelivery.commitEvidence !== 'string' ||
          !embeddedDelivery.publication
        )
          return yield* fail(
            'invalid-delivery-ref',
            'A provisional task watch needs the exact current open-PR delivery evidence.',
          );
        const admitted = yield* runNativeTaskPrDelivery(
          config,
          {
            command: 'deliver-pr',
            runId: request.runId,
            callerCwd: checkout,
            validationRef: request.validationRef,
            commitEvidence: embeddedDelivery.commitEvidence,
            pr: embeddedDelivery.pr,
            publication: embeddedDelivery.publication,
          },
          stored,
          checkout,
          stored.state.cycle!,
        );
        const admittedAction = decodeNativeTaskActionRef(admitted.deliveryRef);
        const deliveryMatches =
          admittedAction?.delivery !== undefined &&
          stableJson(admittedAction.delivery) === stableJson(embeddedDelivery);
        if (admitted.status !== 'watch-required' || admitted.phaseId !== validation.phaseId || !deliveryMatches)
          return yield* fail(
            'stale-delivery-ref',
            'The provisional PR watch reference no longer matches independently revalidated delivery evidence.',
          );
        yield* verifyNativeCycleDeliveryRepository(checkout, admittedAction.delivery);
      });
    if (request.operation === 'start') yield* admitProvisionalWatch();
    if (request.operation === 'start') {
      if (!request.wakeup)
        return yield* fail('host-registration-required', 'Start needs the actual host registration configuration.');
      yield* runNativeWatch(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'start',
        watchId,
        pr: embeddedDelivery.pr.url,
        consumerId,
        wakeupId,
        wakeup: request.wakeup,
        ...(request.takeover === true ? {takeover: true} : {}),
        ...(request.recoverWakeup === true ? {recoverWakeup: true} : {}),
      });
      const readback = yield* readNativeWatch(config, watchId);
      if (
        !readback ||
        readback.envelope.state.pr !== embeddedDelivery.pr.url ||
        readback.envelope.state.consumer?.id !== consumerId ||
        readback.envelope.state.consumer?.wakeupId !== wakeupId ||
        readback.envelope.notification?.target.host !== request.wakeup.host
      )
        return yield* fail(
          'watch-readback-mismatch',
          'The started watch did not retain the exact PR and host consumer binding.',
        );
      const outbox = readback.envelope.notification?.outbox;
      const noticeRef =
        outbox?.key && outbox.attemptId
          ? encodeNativeTaskActionRef({
              version: 1,
              kind: 'delivery',
              runId: request.runId,
              generationHash: sha256HexSync(stored.state.generation),
              watchId,
              consumerId: readback.envelope.state.consumer.id,
              wakeupId: readback.envelope.state.consumer.wakeupId,
              eventKey: outbox.key,
              watchAttemptId: outbox.attemptId,
            })
          : undefined;
      return {
        status: 'watching',
        watchId,
        prUrl: embeddedDelivery.pr.url,
        headSha: readback.envelope.state.head,
        consumerId: readback.envelope.state.consumer.id,
        revision: readback.revision,
        hostReceipt: readback.envelope.notification?.lastReceipt ?? outbox?.receipt ?? null,
        ...(noticeRef ? {noticeRef} : {}),
      };
    }
    const watch = yield* readNativeWatch(config, watchId);
    if (!watch) return yield* fail('watch-not-found', 'Start the task-bound PR watch before using its route.');
    if (watch.envelope.state.pr !== embeddedDelivery.pr.url)
      return yield* fail('watch-identity-conflict', 'The stored watch belongs to another PR.');
    const consumer = watch.envelope.state.consumer;
    if (!consumer)
      return yield* fail('watch-consumer-required', 'Attach the actual task consumer before using the watch.');
    const terminalEmpty =
      watch.envelope.state.prState !== 'open' &&
      watch.envelope.state.events.length === 0 &&
      watch.envelope.state.delivery === null &&
      watch.envelope.state.acknowledged === watch.envelope.state.nextSequence - 1 &&
      !EffectArray.some(watch.envelope.state.work, item => item.status === 'open' || item.status === 'blocked');
    if (
      terminalEmpty &&
      (request.operation === 'relay' || request.operation === 'ack' || request.operation === 'disposition')
    )
      return {status: 'terminal-empty', watchId, prUrl: watch.envelope.state.pr, revision: watch.revision};
    if (
      request.operation === 'relay' ||
      request.operation === 'disposition' ||
      request.operation === 'ack' ||
      request.operation === 'work-disposition'
    )
      yield* admitProvisionalWatch();
    if (request.operation === 'complete') {
      const notification = watch.envelope.notification;
      const now = yield* Clock.currentTimeMillis;
      const terminal = watch.envelope.state.prState === 'merged';
      const requiredSources = ['comments', 'reviews', 'threads', 'checks', 'statuses'];
      const completeSources =
        watch.envelope.state.sources.length === requiredSources.length &&
        EffectArray.every(requiredSources, source =>
          EffectArray.some(
            watch.envelope.state.sources,
            item => item.source === source && item.lastCompleteAt !== undefined && item.error === undefined,
          ),
        );
      if (
        (watch.envelope.state.prState !== 'open' && !terminal) ||
        watch.envelope.state.head !== embeddedDelivery.headSha ||
        (terminal && (watch.envelope.collector?.status !== 'terminal' || !completeSources)) ||
        consumer.leaseUntil <= now ||
        !notification ||
        notification.consumerId !== consumer.id ||
        notification.wakeupId !== consumer.wakeupId ||
        !(notification.lastReceipt || notification.outbox?.receipt)
      )
        return yield* fail(
          'watch-not-ready',
          'Exact PR source-complete watch state and its actual host receipt are required before delivery.',
        );
      const current = yield* readNativeWorkflowState(config, request.runId);
      if (!current?.state.cycle) return yield* fail('cycle-not-found', 'This run no longer has its canonical cycle.');
      const cycleState = current.state.cycle.state;
      const currentProof = cycleState.phases[validation.phaseId];
      const planPhases = EffectArray.filter(cycleState.plan.phases, item => item.id === validation.phaseId);
      if (
        planPhases.length !== 1 ||
        !currentProof ||
        currentProof.phaseHash !== validation.phaseHash ||
        currentProof.head !== validation.sourceHead ||
        currentProof.tree !== validation.sourceTree ||
        currentProof.validation?.snapshotTree !== validation.sourceTree
      )
        return yield* fail(
          'stale-delivery-ref',
          'The historical PR reference no longer matches canonical phase proof.',
        );
      const planPhase = planPhases[0];
      const canonicalReceipt = currentProof.delivery;
      const canonicalPr = canonicalReceipt?.delivery === 'pr' ? canonicalReceipt.pr : undefined;
      if (canonicalReceipt?.delivery === 'pr') {
        const canonicalIdentity = {
          ...canonicalReceipt,
          pr: canonicalPr ? {...canonicalPr, state: 'open' as const, baseRefBinding: undefined} : undefined,
          watch: undefined,
        };
        const suppliedIdentity = {
          ...embeddedDelivery,
          pr: embeddedDelivery.pr
            ? {...embeddedDelivery.pr, state: 'open' as const, baseRefBinding: undefined}
            : undefined,
          watch: undefined,
        };
        if (stableJson(canonicalIdentity) !== stableJson(suppliedIdentity))
          return yield* fail(
            'stale-delivery-ref',
            'The open PR receipt does not match this exact historical delivery reference.',
          );
        if (
          canonicalPr?.state === 'open' &&
          (canonicalReceipt.watch?.state !== 'active' ||
            canonicalReceipt.watch.prUrl !== embeddedDelivery.pr.url ||
            canonicalReceipt.watch.headSha !== validation.sourceHead ||
            canonicalReceipt.watch.consumerId !== consumer.id)
        )
          return yield* fail('stale-delivery-ref', 'The published phase is bound to another PR watch consumer.');
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(config.agentContextHome);
      const stateDir = path.join(home, 'workflow-automations', 'native-watch-v1');
      const hostReceipt = notification.lastReceipt?.receipt ?? notification.outbox?.receipt;
      const evidence = `native-watch-revision:${watch.revision};host-receipt:${hostReceipt}`;
      const watchEvidence = {
        prUrl: embeddedDelivery.pr.url,
        headSha: embeddedDelivery.headSha,
        state: terminal ? ('terminal' as const) : ('active' as const),
        stateDir,
        consumerKind: 'orchestrator' as const,
        consumerId: consumer.id,
        evidence,
      };
      const receiptBase = canonicalReceipt?.delivery === 'pr' ? canonicalReceipt : embeddedDelivery;
      const receiptPr = receiptBase.pr;
      if (!receiptPr) return yield* fail('invalid-watch-receipt', 'The task delivery reference has no PR identity.');
      const finalReceipt = yield* Schema.decodeEffect(NativeCycleDeliverySchema, {onExcessProperty: 'error'})({
        ...receiptBase,
        pr: {...receiptPr, state: terminal ? 'merged' : 'open'},
        watch: watchEvidence,
      }).pipe(Effect.mapError(() => fail('invalid-watch-receipt', 'The canonical watch evidence is malformed.')));
      if (canonicalPr?.state === 'merged') {
        if (stableJson(canonicalReceipt) !== stableJson(finalReceipt))
          return yield* fail(
            'delivery-conflict',
            'The merged PR watch receipt is immutable and does not match this terminal readback.',
          );
        return {
          status: 'delivered',
          replayed: true,
          deliveryRef: encodeNativeTaskActionRef({
            ...deliveryAction,
            kind: 'delivery',
            payloadDigest: sha256HexSync(stableJson(canonicalReceipt)),
            delivery: canonicalReceipt,
          }),
          receipt: canonicalReceipt,
          next: nextNativeCycle(cycleState),
        };
      }
      const previouslyPublished = canonicalReceipt?.delivery === 'pr' && canonicalPr?.state === 'open';
      if (previouslyPublished) {
        const branchHead = yield* runCommandEffect(
          'git',
          [
            '--no-optional-locks',
            '-C',
            checkout,
            'rev-parse',
            '--verify',
            '--end-of-options',
            `refs/heads/${planPhase.branch}^{commit}`,
          ],
          {timeoutMs: 30_000, maxOutputBytes: 4096},
        ).pipe(Effect.mapError(() => fail('source-drift', 'The published phase branch reference is unavailable.')));
        const branchTree = yield* runCommandEffect(
          'git',
          [
            '--no-optional-locks',
            '-C',
            checkout,
            'rev-parse',
            '--verify',
            '--end-of-options',
            `refs/heads/${planPhase.branch}^{tree}`,
          ],
          {timeoutMs: 30_000, maxOutputBytes: 4096},
        ).pipe(Effect.mapError(() => fail('source-drift', 'The published phase tree reference is unavailable.')));
        if (
          EffectString.trim(branchHead.stderr) ||
          EffectString.trim(branchTree.stderr) ||
          EffectString.trim(branchHead.stdout) !== validation.sourceHead ||
          EffectString.trim(branchTree.stdout) !== validation.sourceTree
        )
          return yield* fail(
            'source-drift',
            'The immutable published phase branch no longer matches its reviewed source.',
          );
      } else {
        const ready = unwrapCycle(
          yield* inCheckout(
            runWorkflowAutomation(
              config,
              cycleRequest(current, {
                command: 'publication-ready',
                phaseId: validation.phaseId,
                publication: embeddedDelivery.publication,
              }),
            ),
            checkout,
          ),
        );
        if (ready.head !== validation.sourceHead || ready.tree !== validation.sourceTree)
          return yield* fail('source-drift', 'The current source no longer matches the reviewed PR snapshot.');
      }
      const finalReceiptPr = finalReceipt.pr;
      if (!finalReceiptPr) return yield* fail('invalid-watch-receipt', 'The canonical watch PR identity is missing.');
      const {baseRefBinding: _baseRefBinding, ...unboundReceiptPr} = finalReceiptPr;
      const baseRefReceipt =
        canonicalReceipt?.delivery === 'pr' ? {...finalReceipt, pr: unboundReceiptPr} : finalReceipt;
      const checkedBaseReceipt = yield* bindNativeCycleDeliveryBase(checkout, planPhase.baseBranch, baseRefReceipt);
      if (
        canonicalPr?.baseRefBinding &&
        stableJson(checkedBaseReceipt.pr?.baseRefBinding) !== stableJson(canonicalPr.baseRefBinding)
      )
        return yield* fail(
          'base-ref-unverified',
          'The historical PR base binding no longer matches its canonical receipt.',
        );
      const recorded = yield* withNativeWatchControlLock(
        config,
        watchId,
        Effect.gen(function* () {
          const latestWatch = yield* readNativeWatch(config, watchId);
          if (!latestWatch || latestWatch.revision !== watch.revision)
            return yield* fail('watch-state-conflict', 'The exact watch readback changed before phase delivery.');
          const latest = yield* readNativeWorkflowState(config, request.runId);
          if (!latest?.state.cycle || latest.revision !== current.revision)
            return yield* fail(
              'stale-delivery-ref',
              'Canonical phase state changed before the watch receipt was recorded.',
            );
          const result = unwrapCycle(
            yield* inCheckout(
              runWorkflowAutomation(
                config,
                cycleRequest(latest, {
                  command: 'record-delivery',
                  phaseId: validation.phaseId,
                  delivery: finalReceipt,
                  publication: embeddedDelivery.publication,
                  expectedRevision: latest.revision,
                }),
              ),
              checkout,
            ),
          );
          const persistedState = yield* readNativeWorkflowState(config, request.runId);
          const persisted =
            validation.phaseId === undefined
              ? undefined
              : persistedState?.state.cycle?.state.phases[validation.phaseId]?.delivery;
          if (
            !persisted ||
            !persisted.pr ||
            stableJson({...persisted, pr: {...persisted.pr, baseRefBinding: undefined}}) !==
              stableJson({...finalReceipt, pr: {...finalReceipt.pr, baseRefBinding: undefined}}) ||
            stableJson(persisted.pr.baseRefBinding) !== stableJson(checkedBaseReceipt.pr?.baseRefBinding)
          )
            return yield* fail('delivery-not-recorded', 'The exact watched PR receipt was not persisted.');
          return {result, persisted};
        }),
      );
      return {
        status: 'delivered',
        replayed: false,
        deliveryRef: encodeNativeTaskActionRef({
          ...deliveryAction,
          kind: 'delivery',
          payloadDigest: sha256HexSync(stableJson(recorded.persisted)),
          delivery: recorded.persisted,
        }),
        receipt: recorded.persisted,
        next: recorded.result.next,
      };
    }
    const notice = request.noticeRef ? decodeNativeTaskActionRef(request.noticeRef) : undefined;
    const watchDelivery = request.watchDeliveryRef ? decodeNativeTaskActionRef(request.watchDeliveryRef) : undefined;
    if (
      request.noticeRef &&
      (!notice ||
        notice.kind !== 'delivery' ||
        notice.watchId !== watchId ||
        notice.consumerId !== consumer.id ||
        notice.wakeupId !== consumer.wakeupId ||
        !notice.eventKey ||
        notice.runId !== request.runId ||
        notice.generationHash !== sha256HexSync(stored.state.generation))
    )
      return yield* fail('foreign-notice-route', 'The notice reference does not belong to this exact watch consumer.');
    if (
      request.watchDeliveryRef &&
      (!watchDelivery ||
        watchDelivery.kind !== 'delivery' ||
        watchDelivery.watchId !== watchId ||
        watchDelivery.consumerId !== consumer.id ||
        watchDelivery.wakeupId !== consumer.wakeupId ||
        watchDelivery.runId !== request.runId ||
        watchDelivery.generationHash !== sha256HexSync(stored.state.generation) ||
        !watchDelivery.watchDeliveryId)
    )
      return yield* fail(
        'stale-watch-delivery-ref',
        'Use the current opaque event delivery reference returned by relay.',
      );
    const watchCommand = request.operation === 'inspect' ? 'inspect' : request.operation;
    if (notice) {
      const notification = watch.envelope.notification;
      const outbox = notification?.outbox;
      if (
        !notification ||
        notification.consumerId !== consumer.id ||
        notification.wakeupId !== consumer.wakeupId ||
        !outbox ||
        outbox.key !== notice.eventKey ||
        outbox.attempts < 1 ||
        outbox.status === 'pending' ||
        (notice.watchAttemptId !== undefined && outbox.attemptId !== notice.watchAttemptId) ||
        (notice.watchAttemptId === undefined && outbox.attemptId !== undefined) ||
        notice.runId !== request.runId ||
        notice.generationHash !== sha256HexSync(stored.state.generation)
      )
        return yield* fail(
          'foreign-notice-route',
          'This notice does not belong to the current PR watch consumer and attempt.',
        );
    }
    const dispositions =
      request.dispositions === undefined
        ? undefined
        : EffectArray.map(request.dispositions, item => {
            const eventRef = decodeNativeTaskActionRef(item.eventRef);
            if (
              !eventRef ||
              eventRef.runId !== request.runId ||
              eventRef.generationHash !== sha256HexSync(stored.state.generation) ||
              eventRef.watchId !== watchId ||
              eventRef.consumerId !== consumer.id ||
              eventRef.wakeupId !== consumer.wakeupId ||
              eventRef.watchDeliveryId !== watchDelivery?.watchDeliveryId ||
              !eventRef.watchEventId
            )
              throw fail(
                'stale-watch-event-ref',
                'A disposition must use an event from the current opaque watch delivery.',
              );
            return {
              eventId: eventRef.watchEventId,
              status: item.status,
              reason: item.reason,
              evidence: item.evidence,
            };
          });
    const result = yield* runNativeWatch(config, {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: watchCommand,
      watchId,
      consumerId: consumer.id,
      wakeupId: consumer.wakeupId,
      ...(request.wakeup ? {wakeup: request.wakeup} : {}),
      ...(request.recoverWakeup ? {recoverWakeup: true} : {}),
      expectedRevision: watch.revision,
      ...(watchDelivery?.watchDeliveryId ? {deliveryId: watchDelivery.watchDeliveryId} : {}),
      ...(notice?.eventKey ? {eventKey: notice.eventKey} : {}),
      ...(notice?.watchAttemptId ? {attemptId: notice.watchAttemptId} : {}),
      ...(dispositions ? {dispositions} : {}),
    });
    const after = yield* readNativeWatch(config, watchId);
    if (!after || after.envelope.state.pr !== embeddedDelivery.pr.url)
      return yield* fail('watch-readback-mismatch', 'The canonical watch changed identity during its operation.');
    const resultRecord: Record<string, unknown> | undefined = Predicate.isObject(result) ? result : undefined;
    const delivered = resultRecord && Predicate.isObject(resultRecord.delivery) ? resultRecord.delivery : undefined;
    const watchDeliveryRef =
      delivered && typeof delivered.id === 'string'
        ? encodeNativeTaskActionRef({
            version: 1,
            kind: 'delivery',
            runId: request.runId,
            generationHash: sha256HexSync(stored.state.generation),
            watchId,
            consumerId: consumer.id,
            wakeupId: consumer.wakeupId,
            watchDeliveryId: delivered.id,
          })
        : undefined;
    const eventRefs =
      delivered && EffectArray.isArray(delivered.events)
        ? EffectArray.flatMap(delivered.events, (event: unknown) =>
            Predicate.isObject(event) && typeof event.id === 'string' && watchDeliveryRef
              ? [
                  encodeNativeTaskActionRef({
                    version: 1,
                    kind: 'delivery',
                    runId: request.runId,
                    generationHash: sha256HexSync(stored.state.generation),
                    watchId,
                    consumerId: consumer.id,
                    wakeupId: consumer.wakeupId,
                    watchDeliveryId: String(delivered.id),
                    watchEventId: event.id,
                  }),
                ]
              : [],
          )
        : [];
    const nextNotice = after.envelope.notification?.outbox;
    const noticeRef =
      nextNotice?.key && nextNotice.attemptId
        ? encodeNativeTaskActionRef({
            version: 1,
            kind: 'delivery',
            runId: request.runId,
            generationHash: sha256HexSync(stored.state.generation),
            watchId,
            consumerId: consumer.id,
            wakeupId: consumer.wakeupId,
            eventKey: nextNotice.key,
            watchAttemptId: nextNotice.attemptId,
          })
        : undefined;
    return {
      status: 'watch-updated',
      operation: request.operation,
      watchId,
      prUrl: after.envelope.state.pr,
      headSha: after.envelope.state.head,
      revision: after.revision,
      result,
      ...(watchDeliveryRef ? {watchDeliveryRef} : {}),
      ...(eventRefs.length ? {eventRefs} : {}),
      ...(noticeRef ? {noticeRef} : {}),
    };
  });
