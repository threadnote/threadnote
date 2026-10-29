import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as fc from 'fast-check';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  threadnote5LocalAuthorityManifestHash,
  threadnote5ProcedureVerificationReceiptDigest,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-authority';
import {
  canonicalizeThreadnote5CaptureOutputPathsV1,
  canonicalizeThreadnote5ScenarioRuntimeBoundariesV1,
  captureThreadnote5ReleaseCandidateV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-capture';
import {
  APPROVED_THREADNOTE_5_SCENARIOS,
  THREADNOTE_5_RELEASE_SCENARIOS,
  type Threadnote5SourceV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import {
  deriveThreadnote5LocalScenarioClaims,
  threadnote5LocalSubsystemReceiptDigest,
  verifyThreadnote5LocalSubsystemReceipts,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-receipts';
import {renderContextBriefText} from '@threadnote/context/projector';
import {createProcedureVerificationReceipt, parseProcedureManifest} from '@threadnote/context/procedure/contract';
import fixtureJson from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};
import {
  PRODUCTION_CAPTURE_CANDIDATE,
  emptyContextBriefContent,
  productionCaptureFixture,
} from '../helpers/threadnote-5-production-capture-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CANDIDATE: Threadnote5SourceV1 = {
  commit: Effect2.pipe('1', EffectString.repeat(40)),
  executableSha256: Effect2.pipe('2', EffectString.repeat(64)),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${Effect2.pipe('1', EffectString.repeat(40))}`,
};

describe('Threadnote 5 production capture', () => {
  effectIt.effect('freezes the corrected 15-observation and 24-source-record shape', () =>
    Effect.sync(() => {
      expect(APPROVED_THREADNOTE_5_SCENARIOS).toHaveLength(15);
      expect(
        EffectArray.reduce(APPROVED_THREADNOTE_5_SCENARIOS, 0, (sum, scenario) => sum + scenario.subsystems.length),
      ).toBe(24);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(APPROVED_THREADNOTE_5_SCENARIOS, item => item.id === 'solo'))
          ?.subsystems,
      ).toContain('value-report');
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(APPROVED_THREADNOTE_5_SCENARIOS, item => item.id === 'git-shared'),
        )?.subsystems,
      ).toContain('value-report');
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(APPROVED_THREADNOTE_5_SCENARIOS, item => item.id === 'offline'),
        )?.subsystems,
      ).toContain('value-report');
    }),
  );

  effectIt.effect('canonicalizes separately captured runtime boundaries under input permutations', () =>
    Effect.sync(() => {
      const boundaries = runtimeBoundaries();
      const expected = canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(
        CANDIDATE,
        THREADNOTE_5_RELEASE_SCENARIOS,
        boundaries,
      );
      fc.assert(
        fc.property(
          fc.shuffledSubarray(boundaries, {minLength: boundaries.length, maxLength: boundaries.length}),
          shuffled => {
            expect(
              canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(CANDIDATE, THREADNOTE_5_RELEASE_SCENARIOS, shuffled),
            ).toEqual(expected);
          },
        ),
        {numRuns: 30},
      );
    }),
  );

  effectIt.effect('rejects direct and normalized aliases for concurrent capture outputs', () =>
    Effect.sync(() => {
      const resolvePath = (value: string) => new URL(value, 'file:///capture-root/').pathname;
      expect(() =>
        canonicalizeThreadnote5CaptureOutputPathsV1({
          canonicalReceiptsOutputPath: 'capture.json',
          evidenceOutputPath: 'capture.json',
          resolvePath,
        }),
      ).toThrow(/must be different files/u);
      expect(() =>
        canonicalizeThreadnote5CaptureOutputPathsV1({
          canonicalReceiptsOutputPath: 'receipts/../capture.json',
          evidenceOutputPath: './capture.json',
          resolvePath,
        }),
      ).toThrow(/must be different files/u);
    }),
  );

  effectIt.effect('canonicalizes source records through the same derivation used by verification', () =>
    Effect.sync(() => {
      const records = [procedureRecord(), outputBudgetRecord()];
      const authority = authorityForProcedure(records[0]);
      const expected = deriveThreadnote5LocalScenarioClaims({
        authorityManifest: authority,
        candidate: CANDIDATE,
        expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authority),
        retainedRecords: records,
      });
      fc.assert(
        fc.property(fc.boolean(), reverse => {
          const actual = deriveThreadnote5LocalScenarioClaims({
            authorityManifest: authority,
            candidate: CANDIDATE,
            expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authority),
            retainedRecords: reverse ? [...records].reverse() : records,
          });
          expect(actual).toEqual(expected);
        }),
        {numRuns: 20},
      );
    }),
  );

  effectIt.effect('fails closed before sealing incomplete, drifting, or oversized production inputs', () =>
    Effect.sync(() => {
      const authority = {candidate: CANDIDATE, entries: [], version: 1 as const};
      const common = {
        authorityManifest: authority,
        candidate: CANDIDATE,
        expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authority),
        fixture: fixtureJson,
        retainedSubsystemReceipts: [],
      };
      expect(() => captureThreadnote5ReleaseCandidateV1({...common, runtimeBoundaries: runtimeBoundaries()})).toThrow(
        /exactly 15 observations and 24 source records/u,
      );
      const drifting = EffectArray.map(runtimeBoundaries(), (boundary, index) =>
        index === 0
          ? {
              ...boundary,
              postRuntime: {...boundary.postRuntime, executableSha256: Effect2.pipe('9', EffectString.repeat(64))},
            }
          : boundary,
      );
      expect(() => captureThreadnote5ReleaseCandidateV1({...common, runtimeBoundaries: drifting})).toThrow(
        /runtime boundaries are missing, duplicated, mislabeled, or drifting/u,
      );
      const oversized = EffectArray.map(runtimeBoundaries(), (boundary, index) =>
        index === 0 ? {...boundary, padding: Effect2.pipe('x', EffectString.repeat(256 * 1024))} : boundary,
      );
      expect(() => captureThreadnote5ReleaseCandidateV1({...common, runtimeBoundaries: oversized})).toThrow(
        /within size limits/u,
      );
    }),
  );

  effectIt.effect('captures and replays the complete production-shaped matrix canonically', () =>
    Effect.sync(() => {
      const fixture = productionCaptureFixture();
      const authorityHash = threadnote5LocalAuthorityManifestHash(fixture.authorityManifest);
      const boundaries = runtimeBoundaries(PRODUCTION_CAPTURE_CANDIDATE);
      const input = {
        authorityManifest: fixture.authorityManifest,
        candidate: PRODUCTION_CAPTURE_CANDIDATE,
        expectedAuthorityManifestSha256: authorityHash,
        fixture: fixtureJson,
      };
      const expected = captureThreadnote5ReleaseCandidateV1({
        ...input,
        retainedSubsystemReceipts: fixture.records,
        runtimeBoundaries: boundaries,
      });

      expect(expected.evidence.candidateObservations).toHaveLength(15);
      expect(expected.retainedSubsystemReceipts).toHaveLength(24);
      expect(
        verifyThreadnote5LocalSubsystemReceipts({
          authorityManifest: fixture.authorityManifest,
          candidate: PRODUCTION_CAPTURE_CANDIDATE,
          expectedAuthorityManifestSha256: authorityHash,
          observations: expected.evidence.candidateObservations,
          retainedRecords: expected.retainedSubsystemReceipts,
        }),
      ).toMatchObject({receiptCount: 24, state: 'verified'});

      expect(
        captureThreadnote5ReleaseCandidateV1({
          ...input,
          retainedSubsystemReceipts: [...fixture.records].reverse(),
          runtimeBoundaries: [...boundaries].reverse(),
        }),
      ).toEqual(expected);
    }),
  );
});

function runtimeBoundaries(candidate: Threadnote5SourceV1 = CANDIDATE) {
  const runtime = {executableSha256: candidate.executableSha256, sourceCommit: candidate.commit};
  return EffectArray.map(THREADNOTE_5_RELEASE_SCENARIOS, scenario => ({
    postRuntime: runtime,
    preRuntime: runtime,
    scenario,
  }));
}

function procedureRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const artifactText = 'artifact';
  const manifest = parseProcedureManifest({
    artifact: {id: 'team.example/review', semanticVersion: '1.2.3', sha256: sha256HexSync(artifactText)},
    compatible: {capabilities: ['filesystem.read'], surfaceIds: ['terminal']},
    dependencies: [],
    owner: 'owner-opaque-42',
    presentation: {summary: 'Review the repository.', taskKeywords: ['review']},
    relatedDurableMemoryIds: [],
    reviewedOn: '2026-09-17',
    rollout: {channel: 'stable', percentage: 100},
    schemaVersion: 2,
    verification: {commands: [{argv: ['bun', 'test'], id: 'unit'}], fixtures: []},
  });
  const receipt = createProcedureVerificationReceipt(manifest, {
    hostVersion: 'host',
    threadnoteVersion: CANDIDATE.version,
    verifiedAt: '2026-09-17T12:00:00.000Z',
    verifier: 'verifier',
  });
  return record('verified-procedures', 'procedure', {
    attempts: [
      {artifactText, manifest, statusInput: {capabilities: ['filesystem.read'], receipt, surfaceIds: ['terminal']}},
    ],
  });
}

function outputBudgetRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const structuredContent = emptyContextBriefContent();
  return record('output-budgets', 'context-brief', {
    attempts: [
      {
        event: {candidate: CANDIDATE},
        request: {budgetTokens: 1_500, mode: 'brief', scope: {callerCwd: '/repo', kind: 'repository'}, task: 'x'},
        result: {structuredContent, text: renderContextBriefText(structuredContent)},
      },
    ],
  });
}

function authorityForProcedure(record: Threadnote5LocalSubsystemReceiptRecordV1) {
  const attempt = Schema.decodeUnknownSync(
    Schema.Struct({
      attempts: Schema.Array(
        Schema.Struct({manifest: Schema.Unknown, statusInput: Schema.Struct({receipt: Schema.Unknown})}),
      ),
    }),
  )(record.artifact).attempts[0];
  if (!attempt) throw new Error('Procedure fixture must contain one attempt.');
  const manifest = parseProcedureManifest(attempt.manifest);
  const receipt = attempt.statusInput.receipt;
  return {
    candidate: CANDIDATE,
    entries: [
      {
        artifactId: manifest.artifact.id,
        automaticExecutionCount: 0,
        commandResults: EffectArray.map(manifest.verification.commands, command => ({
          commandId: command.id,
          exitCode: 0,
          outputDigest: sha256HexSync(`verified-output:${command.id}`),
        })),
        receiptDigest: threadnote5ProcedureVerificationReceiptDigest(receipt),
        recordDigest: record.digest,
        semanticVersion: manifest.artifact.semanticVersion,
        type: 'procedure-verification' as const,
      },
    ],
    version: 1 as const,
  };
}

function record(
  scenario: Threadnote5LocalSubsystemReceiptRecordV1['scenario'],
  kind: Threadnote5LocalSubsystemReceiptRecordV1['kind'],
  artifact: unknown,
): Threadnote5LocalSubsystemReceiptRecordV1 {
  const unsigned = {artifact, candidate: CANDIDATE, kind, scenario, version: 1 as const};
  return {...unsigned, digest: threadnote5LocalSubsystemReceiptDigest(unsigned)};
}
