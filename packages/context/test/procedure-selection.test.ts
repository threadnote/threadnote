import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {
  createProcedureVerificationReceipt,
  isPublishableProcedureManifest,
  parseProcedureManifest,
  type ProcedureManifestV2,
} from '@threadnote/context/procedure/contract';
import {
  parseVerifiedProcedureEvidenceList,
  selectVerifiedProcedureEvidence,
  selectVerifiedProcedures,
  type PublishedProcedureCandidate,
} from '@threadnote/context/procedure/selection';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function candidate(
  id: string,
  semanticVersion: string,
  dependencies: ProcedureManifestV2['dependencies'] = [],
  overrides: Partial<ProcedureManifestV2> = {},
): PublishedProcedureCandidate {
  const manifest = parseProcedureManifest({
    artifact: {
      id,
      semanticVersion,
      sha256: Effect.pipe(
        Effect.pipe(
          id,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ).toString(16),
        EffectString.padStart(2, '0'),
        EffectString.repeat(32),
      ),
    },
    compatible: {capabilities: ['mcp', 'skills'], surfaceIds: ['codex', 'codex-cli']},
    dependencies,
    owner: 'platform-team',
    presentation: {summary: `Reviewed ${id} workflow.`, taskKeywords: ['deploy']},
    relatedDurableMemoryIds: [],
    reviewedOn: '2026-09-17',
    rollout: {channel: 'stable', percentage: 100},
    schemaVersion: 2,
    verification: {commands: [{argv: ['bun', 'test'], id: 'test'}], fixtures: []},
    ...overrides,
  });
  if (!isPublishableProcedureManifest(manifest)) throw new Error('Expected a procedure manifest v2 fixture.');
  return {
    artifactSha256: manifest.artifact.sha256,
    manifest,
    receipt: createProcedureVerificationReceipt(manifest, {
      hostVersion: 'test-host',
      threadnoteVersion: '5.0.0',
      verifiedAt: '2026-09-17T12:00:00.000Z',
      verifier: 'test-verifier',
    }),
    team: 'default',
  };
}

describe('verified procedure Context Brief selection', () => {
  it('falls back to the highest admitted stable version and excludes stale receipts', () => {
    const previous = candidate('a/root', '1.0.0');
    const phased = candidate('a/root', '2.0.0', [], {
      rollout: {channel: 'stable', percentage: 0},
    });
    const stale = candidate('b/stale', '1.0.0');
    const selected = selectVerifiedProcedures({
      candidates: [
        previous,
        phased,
        {...stale, receipt: {...stale.receipt, manifestSha256: Effect.pipe('f', EffectString.repeat(64))}},
      ],
      cohort: 'cohort-a',
      surface: 'codex',
      task: 'deploy the service',
    });

    expect(EffectArray.map(selected, value => `${value.artifact.id}@${value.artifact.semanticVersion}`)).toEqual([
      'a/root@1.0.0',
    ]);
    expect(selected[0]?.provenance).toMatchObject({kind: 'verified-procedure-git-share', team: 'default'});
    expect(JSON.stringify(selected)).not.toContain('argv');
  });

  fcProp(
    it,
    'dependency admission is invariant to candidate order and emits dependencies before roots',
    {
      order: FC.shuffledSubarray([0, 1, 2], {minLength: 3, maxLength: 3}),
    },
    ({order}) => {
      const values = [
        candidate('a/root', '2.0.0', [
          {artifactId: 'b/prepare', semanticVersion: '1.0.0'},
          {artifactId: 'c/check', semanticVersion: '1.0.0'},
        ]),
        candidate('b/prepare', '1.0.0', [], {presentation: {summary: 'Prepare.', taskKeywords: ['prepare']}}),
        candidate('c/check', '1.0.0', [], {presentation: {summary: 'Check.', taskKeywords: ['check']}}),
      ];
      const selected = selectVerifiedProcedures({
        candidates: EffectArray.map(order, index => values[index]),
        cohort: 'cohort-a',
        surface: 'codex-cli',
        task: 'deploy the service',
      });
      expect(EffectArray.map(selected, value => value.artifact.id)).toEqual(['b/prepare', 'c/check', 'a/root']);
    },
    {fastCheck: {numRuns: 40}},
  );

  it('uses catalog capabilities equivalently for a canonical surface and its alias', () => {
    const procedure = candidate('a/root', '1.0.0', [], {rollout: {channel: 'stable', percentage: 37}});
    const select = (surface: string, cohort: string) =>
      selectVerifiedProcedures({candidates: [procedure], cohort, surface, task: 'deploy'});
    for (const cohort of ['same', 'another', 'test-user', 'release-cohort']) {
      expect(select('codex', cohort)).toEqual(select('codex-cli', cohort));
    }
    expect(select('cursor-cloud-personal', 'same')).toEqual([]);
    expect(
      selectVerifiedProcedureEvidence({
        candidates: [procedure],
        cohort: 'same',
        surface: 'cursor-cloud-personal',
        task: 'deploy',
      }).gaps,
    ).toEqual([]);
  });

  it('chooses only task-relevant versions before applying highest-version admission', () => {
    const relevant = candidate('a/root', '1.0.0');
    const unrelated = candidate('a/root', '2.0.0', [], {
      presentation: {summary: 'Audit the service.', taskKeywords: ['audit']},
    });

    expect(
      EffectArray.map(
        selectVerifiedProcedures({
          candidates: [unrelated, relevant],
          cohort: 'cohort-a',
          surface: 'codex',
          task: 'deploy the service',
        }),
        value => value.artifact.semanticVersion,
      ),
    ).toEqual(['1.0.0']);
  });

  it('fails closed on conflicting same-version evidence and excludes dependent roots', () => {
    const dependency = candidate('b/dependency', '1.0.0', [], {
      presentation: {summary: 'Prepare.', taskKeywords: ['prepare']},
    });
    const conflictingDependency = {
      ...dependency,
      receipt: {...dependency.receipt, verifier: 'different-verifier'},
      team: 'second-team',
    };
    const root = candidate('a/root', '1.0.0', [{artifactId: 'b/dependency', semanticVersion: '1.0.0'}]);
    const selected = selectVerifiedProcedureEvidence({
      candidates: [root, dependency, conflictingDependency],
      cohort: 'cohort-a',
      surface: 'codex',
      task: 'deploy',
    });

    expect(selected).toEqual({gaps: ['procedure-version-conflict'], procedures: []});
  });

  it('reports and excludes a valid procedure shadowed by tampered same-version evidence', () => {
    const valid = candidate('a/root', '1.0.0');
    for (const tampered of [
      {...valid, artifactSha256: Effect.pipe('f', EffectString.repeat(64)), team: 'artifact-tamper'},
      {
        ...valid,
        receipt: {...valid.receipt, manifestSha256: Effect.pipe('f', EffectString.repeat(64))},
        team: 'receipt-tamper',
      },
    ]) {
      expect(
        selectVerifiedProcedureEvidence({
          candidates: [valid, tampered],
          cohort: 'cohort-a',
          surface: 'codex',
          task: 'deploy',
        }),
      ).toEqual({
        gaps: ['procedure-evidence-unavailable', 'procedure-version-conflict'],
        procedures: [],
      });
    }
  });

  fcProp(
    it,
    'rollout and version admission are deterministic across candidate order',
    {
      cohort: FC.string({minLength: 1, maxLength: 64}),
      percentage: FC.integer({min: 0, max: 100}),
      reversed: FC.boolean(),
    },
    ({cohort, percentage, reversed}) => {
      const stable = candidate('a/root', '1.0.0');
      const phased = candidate('a/root', '2.0.0', [], {rollout: {channel: 'stable', percentage}});
      const values = reversed ? [phased, stable] : [stable, phased];
      const input = {candidates: values, cohort, surface: 'codex', task: 'deploy'} as const;
      expect(selectVerifiedProcedures(input)).toEqual(
        selectVerifiedProcedures({...input, candidates: [...values].reverse()}),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('rejects executable or oversized forged public procedure evidence', () => {
    const evidence = selectVerifiedProcedures({
      candidates: [candidate('a/root', '1.0.0')],
      cohort: 'cohort-a',
      surface: 'codex',
      task: 'deploy',
    })[0];
    expect(parseVerifiedProcedureEvidenceList([evidence])).toEqual([evidence]);
    expect(() => parseVerifiedProcedureEvidenceList([{...evidence, commands: [['rm', '-rf', '/']]}])).toThrow();
    expect(() => parseVerifiedProcedureEvidenceList(Array.from({length: 5}, () => evidence))).toThrow();
    expect(() =>
      parseVerifiedProcedureEvidenceList([
        {...evidence, provenance: {...evidence.provenance, artifactSha256: 'invalid'}},
      ]),
    ).toThrow();
  });
});
