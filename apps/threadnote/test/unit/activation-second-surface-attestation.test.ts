import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {THREADNOTE_MCP_CLIENT_ENV, THREADNOTE_MCP_SURFACE_ENV} from '@threadnote/threadnote/constants';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {MCP_TOOLSET_ENV} from '@threadnote/threadnote/mcp/toolset';
import {canonicalMemoryDocumentContent, parseMemoryDocument} from '@threadnote/memory/document';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {createActivationPlanV1} from '@threadnote/threadnote/activation/planner';
import {
  observeCurrentActivationSurfaceV1,
  type CurrentActivationSurfaceV1,
} from '@threadnote/threadnote/activation/production/evidence';
import {
  bindActivationApprovalV1,
  createActivationReceiptV1,
  recordActivationOutcomeV1,
} from '@threadnote/threadnote/activation/receipt';
import {
  completeSecondSurfaceProofV1,
  type SecondSurfaceProofContextV1,
  type SecondSurfaceReadObservationV1,
  type SecondSurfaceRecallObservationV1,
} from '@threadnote/threadnote/activation/second/surface';
import {produceSecondSurfaceProofV1} from '@threadnote/threadnote/activation/second/surface_producer';
import {
  completeSecondSurfaceProofChallengeV1,
  issueSecondSurfaceProofChallengeV1,
  secondSurfaceChallengeIdV1,
  verifySecondSurfaceProofAttestationV1,
} from '@threadnote/threadnote/activation/second/surface_store';
import {initializeActivationStateV1} from '@threadnote/threadnote/activation/store';
import {reconcileActivationValueEventsV1} from '@threadnote/threadnote/activation/value';
import {captureThreadnote5ActivationTrialV1} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-receipts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('transport-attested second-surface proof', () => {
  it('keeps the challenge identity stable across only the start timestamp', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 500_000}), offset => {
        const fixture = proofContext(surface('gemini-cli'), surface('qwen-code'));
        const later = new Date(Date.parse(fixture.startedAt) + offset).toISOString();
        expect(secondSurfaceChallengeIdV1({...fixture, startedAt: later})).toBe(secondSurfaceChallengeIdV1(fixture));
      }),
      {numRuns: 32},
    );
  });

  effectIt.effect('captures a completed activation through a real HMAC-backed challenge', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-hmac-capture-'});
        const config = {agentContextHome: home};
        const plan = createActivationPlanV1({
          catalogSnapshotHash: Effect2.pipe('a', EffectString.repeat(64)),
          primarySurfaceId: 'gemini-cli',
          publicationMode: 'direct',
          repositoryIdentityHash: Effect2.pipe('b', EffectString.repeat(64)),
          secondarySurfaceId: 'qwen-code',
          selectedSourceSetHash: Effect2.pipe('c', EffectString.repeat(64)),
          taskHash: Effect2.pipe('d', EffectString.repeat(64)),
          teamId: 'default',
          teamShareStateHash: Effect2.pipe('e', EffectString.repeat(64)),
          threadnoteVersion: '5.0.0-test',
        });
        const activation = activationBeforeSecondSurface(plan);
        const publicationReceiptHash = EffectOption.getOrUndefined(
          EffectArray.findFirst(activation.receipt.operations, operation => operation.kind === 'decision.publish'),
        )!.subsystemReceiptHash!;
        const context = proofContext(surface(plan.primarySurfaceId), surface(plan.secondarySurfaceId), {
          activationId: plan.activationId,
          activationReceiptRevision: activation.receipt.revision,
          publicationReceiptHash,
          repositoryIdentityHash: plan.repositoryIdentityHash,
          startedAt: activation.receipt.updatedAt,
        });
        const challenge = yield* issueSecondSurfaceProofChallengeV1(config, context);
        const observations = proofObservations(context);
        const proofResult = completeSecondSurfaceProofV1(context, observations.recall, observations.read);
        if (proofResult.status !== 'verified') throw new Error(`Proof fixture failed: ${proofResult.code}`);
        const attestation = yield* completeSecondSurfaceProofChallengeV1(config, {
          challengeId: challenge.challengeId,
          proof: proofResult.receipt,
          runtimeFingerprint: context.secondary.mcpServerFingerprint!,
          surfaceId: context.secondary.surfaceId,
        });
        const finalTransition = recordActivationOutcomeV1({
          now: isoAfter(activation.receipt.updatedAt, 3_000),
          operationId: plan.operations.at(-1)!.id,
          outcome: {
            ownership: 'preexisting',
            status: 'verified',
            subsystemReceiptHash: proofResult.receipt.proofHash,
            undoEligible: false,
          },
          plan,
          receipt: activation.receipt,
        });
        if (finalTransition.status !== 'updated') throw new Error('Final activation transition failed.');
        const receiptChain = [...activation.receiptChain, finalTransition.receipt];
        yield* initializeActivationStateV1(config, plan, finalTransition.receipt);
        yield* reconcileActivationValueEventsV1(config, {plan, receipt: finalTransition.receipt});

        const capture = yield* captureThreadnote5ActivationTrialV1(config, {
          activationId: plan.activationId,
          approvals: activation.approvals,
          challengeId: challenge.challengeId,
          receiptChain,
        });
        expect(capture.authorityTrial).toMatchObject({
          activationId: plan.activationId,
          attestationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          finalReceiptRevision: finalTransition.receipt.revision,
        });
        expect(capture.trial.events).toHaveLength(4);
        expect(capture.trial.secondSurface?.challenge.receipt).toEqual(attestation);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects wrong transports and accepts the real managed-surface producer exactly once', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proof-'});
        const userHome = path.join(root, 'user');
        const home = path.join(userHome, '.threadnote');
        const repository = path.join(root, 'repository');
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* command.execute('git', ['init', '--quiet'], {
          cwd: repository,
          maxOutputBytes: 4_096,
          timeoutMs: 5_000,
        });
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const baseEnvironment = {...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')};
        const setupSystem = SystemInfo.of({
          ...system,
          homeDirectory: userHome,
          environment: () => baseEnvironment,
        });
        const [primary, secondary] = yield* Effect.gen(function* () {
          const primaryAdapter = getAgentAdapter('gemini-cli')!;
          const secondaryAdapter = getAgentAdapter('qwen-code')!;
          yield* primaryAdapter.actions.install(config, primaryAdapter, {apply: true});
          yield* secondaryAdapter.actions.install(config, secondaryAdapter, {apply: true});
          return yield* Effect.all([
            observeCurrentActivationSurfaceV1(config, primaryAdapter),
            observeCurrentActivationSurfaceV1(config, secondaryAdapter),
          ]);
        }).pipe(Effect.provideService(SystemInfo, setupSystem));
        const memory = sharedMemory();
        const memoryPath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'threadnote',
          'activation.md',
        );
        yield* fs.makeDirectory(path.dirname(memoryPath), {recursive: true});
        yield* fs.writeFileString(memoryPath, memory.content);
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
        const repositoryIdentity = yield* resolveRepositoryIdentity(repository);
        const context = proofContext(primary, secondary, {
          contentHash: sha256HexSync(canonicalMemoryDocumentContent(memory.content)),
          repositoryIdentityHash: repositoryIdentity.repositoryId,
          startedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const challenge = yield* issueSecondSurfaceProofChallengeV1(config, context);
        const invoke = (environment: NodeJS.ProcessEnv, transport: 'http' | 'stdio' = 'stdio') =>
          produceSecondSurfaceProofV1(config, {
            callerCwd: repository,
            challengeId: challenge.challengeId,
            project: 'threadnote',
            query: 'Prove the activation decision.',
            topic: 'activation-decision',
            transport,
          }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...setupSystem, environment: () => environment})));
        const secondaryEnvironment = {
          ...baseEnvironment,
          [MCP_TOOLSET_ENV]: 'core',
          [THREADNOTE_MCP_CLIENT_ENV]: 'qwen',
          [THREADNOTE_MCP_SURFACE_ENV]: 'qwen-code',
        };
        expect((yield* invoke(secondaryEnvironment, 'http').pipe(Effect.exit))._tag).toBe('Failure');
        expect(
          (yield* invoke({
            ...secondaryEnvironment,
            [THREADNOTE_MCP_CLIENT_ENV]: 'gemini',
            [THREADNOTE_MCP_SURFACE_ENV]: 'gemini-cli',
          }).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        expect((yield* invoke({...secondaryEnvironment, [MCP_TOOLSET_ENV]: 'full'}).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        const unrelatedContext = {
          ...context,
          activationId: Effect2.pipe('8', EffectString.repeat(64)),
          activationReceiptRevision: Effect2.pipe('7', EffectString.repeat(64)),
          queryFingerprint: sha256HexSync(
            canonicalJson({
              project: 'threadnote',
              task: 'Find only the unrelated platypus retention policy.',
              topic: 'platypus-retention',
            }),
          ),
        };
        const unrelatedChallenge = yield* issueSecondSurfaceProofChallengeV1(config, unrelatedContext);
        expect(
          (yield* produceSecondSurfaceProofV1(config, {
            callerCwd: repository,
            challengeId: unrelatedChallenge.challengeId,
            project: 'threadnote',
            query: 'Find only the unrelated platypus retention policy.',
            topic: 'platypus-retention',
            transport: 'stdio',
          }).pipe(
            Effect.provideService(SystemInfo, SystemInfo.of({...setupSystem, environment: () => secondaryEnvironment})),
            Effect.exit,
          ))._tag,
        ).toBe('Failure');
        const receipt = yield* invoke(secondaryEnvironment);
        expect(receipt.surfaceId).toBe('qwen-code');
        expect(receipt.transport).toBe('stdio');
        expect(receipt.proof.decisionMemoryId).toBe('tn_activation_attested');
        expect(yield* invoke(secondaryEnvironment)).toEqual(receipt);
        expect(
          (yield* verifySecondSurfaceProofAttestationV1(config, challenge, {
            ...receipt,
            attestationHash: Effect2.pipe('f', EffectString.repeat(64)),
          }).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        const replayContext = {
          ...context,
          activationId: Effect2.pipe('f', EffectString.repeat(64)),
          activationReceiptRevision: Effect2.pipe('e', EffectString.repeat(64)),
        };
        const replayChallenge = yield* issueSecondSurfaceProofChallengeV1(config, replayContext);
        expect(
          (yield* verifySecondSurfaceProofAttestationV1(config, replayChallenge, receipt).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        const serialized = JSON.stringify(receipt);
        expect(serialized).not.toContain(memory.record.body);
        expect(serialized).not.toContain('Prove the activation decision.');
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

function proofContext(
  primary: CurrentActivationSurfaceV1,
  secondary: CurrentActivationSurfaceV1,
  overrides: Partial<SecondSurfaceProofContextV1['decision']> &
    Partial<
      Pick<
        SecondSurfaceProofContextV1,
        'activationId' | 'activationReceiptRevision' | 'repositoryIdentityHash' | 'startedAt'
      >
    > = {},
): SecondSurfaceProofContextV1 {
  return {
    activationId: overrides.activationId ?? Effect2.pipe('a', EffectString.repeat(64)),
    activationReceiptRevision: overrides.activationReceiptRevision ?? Effect2.pipe('b', EffectString.repeat(64)),
    catalogRevision: 'agent-catalog-v1-test',
    catalogSnapshotHash: Effect2.pipe('c', EffectString.repeat(64)),
    decision: {
      canonicalUri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/activation.md',
      contentHash: overrides.contentHash ?? Effect2.pipe('d', EffectString.repeat(64)),
      memoryId: 'tn_activation_attested',
      publicationReceiptHash: overrides.publicationReceiptHash ?? Effect2.pipe('e', EffectString.repeat(64)),
    },
    primary: primary.snapshot,
    queryFingerprint: sha256HexSync(
      canonicalJson({project: 'threadnote', task: 'Prove the activation decision.', topic: 'activation-decision'}),
    ),
    repositoryIdentityHash: overrides.repositoryIdentityHash ?? Effect2.pipe('1', EffectString.repeat(64)),
    repositoryState: 'clean',
    secondary: secondary.snapshot,
    startedAt: overrides.startedAt ?? '2026-09-18T08:00:00.000Z',
    teamId: 'default',
    teamShareStateHash: Effect2.pipe('2', EffectString.repeat(64)),
  };
}

function activationBeforeSecondSurface(plan: ReturnType<typeof createActivationPlanV1>) {
  let receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
  const approvals: NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[] = [];
  const receiptChain = [receipt];
  for (const [index, operation] of plan.operations.slice(0, -1).entries()) {
    const approval =
      operation.approvalKind === undefined
        ? undefined
        : bindActivationApprovalV1(plan, receipt, operation.id, Effect2.pipe('f', EffectString.repeat(64)));
    if (approval !== undefined) approvals.push(approval);
    const transition = recordActivationOutcomeV1({
      approval,
      now: isoAfter(receipt.updatedAt, 1_000),
      operationId: operation.id,
      outcome: {
        ownership: operation.reversible ? 'activation-created' : 'preexisting',
        status: operation.expectedOutcome,
        subsystemReceiptHash: Effect2.pipe((index + 1).toString(16), EffectString.padStart(64, '0')),
        undoEligible: operation.reversible,
      },
      plan,
      receipt,
    });
    if (transition.status !== 'updated') throw new Error('Activation fixture transition failed.');
    receipt = transition.receipt;
    receiptChain.push(receipt);
  }
  return {approvals, receipt, receiptChain};
}

function proofObservations(context: SecondSurfaceProofContextV1): {
  readonly read: SecondSurfaceReadObservationV1;
  readonly recall: SecondSurfaceRecallObservationV1;
} {
  const common = {
    activationReceiptRevision: context.activationReceiptRevision,
    capabilitiesFingerprint: context.secondary.capabilitiesFingerprint,
    catalogRevision: context.catalogRevision,
    catalogSnapshotHash: context.catalogSnapshotHash,
    mcpConfigFingerprint: context.secondary.mcpConfigFingerprint!,
    mcpReceiptFingerprint: context.secondary.mcpReceiptFingerprint!,
    mcpServerFingerprint: context.secondary.mcpServerFingerprint!,
    repositoryIdentityHash: context.repositoryIdentityHash,
    surfaceId: context.secondary.surfaceId,
    teamShareStateHash: context.teamShareStateHash,
  };
  const recall: SecondSurfaceRecallObservationV1 = {
    ...common,
    complete: true,
    invocationId: Effect2.pipe('1', EffectString.repeat(64)),
    observedAt: isoAfter(context.startedAt, 1_000),
    queryFingerprint: context.queryFingerprint,
    responseFingerprint: Effect2.pipe('2', EffectString.repeat(64)),
    results: [
      {
        canonicalUri: context.decision.canonicalUri,
        identityConflict: false,
        memoryId: context.decision.memoryId,
      },
    ],
    returnedResults: 1,
    totalResults: 1,
    truncated: false,
  };
  return {
    read: {
      ...common,
      canonicalUri: context.decision.canonicalUri,
      complete: true,
      contentHash: context.decision.contentHash,
      invocationId: Effect2.pipe('3', EffectString.repeat(64)),
      memoryId: context.decision.memoryId,
      observedAt: isoAfter(context.startedAt, 2_000),
      readable: true,
      recallResponseFingerprint: recall.responseFingerprint,
      requestedMemoryId: context.decision.memoryId,
      requestedUri: context.decision.canonicalUri,
      resourceCount: 1,
      responseFingerprint: Effect2.pipe('4', EffectString.repeat(64)),
    },
    recall,
  };
}

function isoAfter(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function surface(id: string): CurrentActivationSurfaceV1 {
  const fingerprint = sha256HexSync(
    canonicalJson({installedVersion: '5.0.0', protocol: 'threadnote-mcp-stdio-v1', toolset: 'core'}),
  );
  return {
    evidenceHash: Effect2.pipe('9', EffectString.repeat(64)),
    snapshot: {
      access: 'local-stdio',
      capabilitiesFingerprint: Effect2.pipe('3', EffectString.repeat(64)),
      configurationState: 'current',
      mcpCapability: 'managed',
      mcpConfigFingerprint: Effect2.pipe('4', EffectString.repeat(64)),
      mcpReceiptFingerprint: Effect2.pipe('5', EffectString.repeat(64)),
      mcpServerFingerprint: fingerprint,
      surfaceId: id,
    },
  };
}

function sharedMemory() {
  const content = EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      'topic: activation-decision',
      'source_agent_client: codex',
      'timestamp: 2026-09-18T08:00:00.000Z',
      'memory_id: tn_activation_attested',
      'visibility: shared',
      'authority: user_approved',
      'trust: approved',
      '',
      '# Decision',
      'Use the reviewed activation path.',
    ],
    '\n',
  );
  const record = parseMemoryDocument(
    'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/activation.md',
    content,
  );
  if (record === undefined) throw new Error('Expected valid shared memory fixture.');
  return {content, record};
}
