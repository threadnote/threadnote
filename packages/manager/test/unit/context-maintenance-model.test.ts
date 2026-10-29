import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {
  createMemoryCodeCitation,
  formatMemoryCodeCitation,
  preserveMemoryCodeCitationAnchor,
} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import {createReviewedSupportSnapshot} from '@threadnote/memory/reviewed-support';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {ManagerAutomaticReview} from '@threadnote/manager/attention/topic-contracts';
import {buildContextHealthReport} from '@threadnote/context/health';
import {describe, expect, it} from 'vitest';
import {
  automaticReviewMaintenanceReceipts,
  groupMaintenanceCauses,
  maintenanceStatusLabel,
  mergeMaintenanceStatusPage,
  reconcileAppliedMaintenanceCases,
  reconcileAppliedHealthReport,
} from '@threadnote/manager/attention/maintenance';
import type {
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenanceReceiptV2,
  ManagerContextMaintenanceStatusV2,
  ManagerContextHealthResponseV1,
} from '@threadnote/manager/attention/contracts';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const caseAt = (index: number): ManagerContextMaintenanceCaseV2 => ({
  caseId: `case-${index}`,
  project: 'threadnote',
  memoryId: `memory-${index}`,
  family: 'citation',
  slot: `${index}`,
  disposition: 'waiting-evidence',
  evidenceRevision: Effect.pipe('a', EffectString.repeat(64)),
  reason: 'repository-unavailable',
  repositoryId: 'repo-one',
  firstSeen: '2026-10-03',
  lastSeen: '2026-10-03',
  lastChecked: '2026-10-03',
  attemptCount: 1,
  events: [],
});

const automaticCompletion = (hash = Effect.pipe('a', EffectString.repeat(64))): ManagerAutomaticReview => {
  const body = 'The current limit is 9.';
  const source = {
    kind: 'code' as const,
    citation: createMemoryCodeCitation({
      version: 1,
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256', value: hash},
      path: 'limit.ts',
      repositoryId: Effect.pipe('b', EffectString.repeat(64)),
      repositoryIdentityKind: 'local',
      sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}`,
      target: {kind: 'file'},
    }),
  };
  const id = automaticMaintenanceEvidenceId(source);
  const active = createReviewedSupportSnapshot({
    bodyHash: sha256HexSync(body),
    paragraphs: [{ordinal: 0, hash: sha256HexSync(body), role: 'descriptive', support: 'direct', evidenceIds: [id]}],
    sources: [{id, source, scope: 'repository'}],
    acceptance: {
      reviewId: 'review-automatic',
      approvedAt: '2026-10-22T00:00:00.000Z',
      targetBeforeHash: hash,
      preparationDigest: hash,
      sourceVectorDigest: hash,
    },
  });
  const reviewedSupport = {type: 'reviewed-memory-support' as const, version: 1 as const, active};
  const content = `MEMORY\nschema_version: 11\nkind: durable\nproject: threadnote\nmemory_id: memory-0\nreviewed_support: ${JSON.stringify(reviewedSupport)}\n\n${body}`;
  return {
    version: 1,
    kind: 'automatic-memory-review',
    project: 'threadnote',
    reviewId: 'review-automatic',
    revision: 4,
    state: 'applied',
    targetUri: 'threadnote://user/test/memories/durable/projects/threadnote/limit.md',
    targetHash: hash,
    evidenceRevision: hash,
    purpose: 'automatic',
    acceptedBody: 'The current limit is 8.',
    proposal: {
      version: 2,
      kind: 'automatic',
      body,
      finalBodyHash: sha256HexSync(body),
      changedOrdinals: [0],
      draft: {
        version: 2,
        kind: 'automatic',
        purpose: 'automatic',
        targetHash: hash,
        observationRevision: hash,
        packetDigest: hash,
        outcome: 'propose-update',
        operations: [],
        reviewedHandles: [],
        rationale: 'Changed source.',
        unresolvedQuestions: [],
        removedClaims: [],
        paragraphDecisions: [],
      },
    },
    sourceEvidence: [],
    coverage: {
      outcome: 'complete',
      scope: 'recorded-only',
      searchedScopes: [],
      omittedSources: 0,
      omittedParagraphs: 0,
    },
    canApply: false,
    canFinishVerification: false,
    verified: true,
    approval: {
      stage: 'written',
      reviewRevision: 2,
      approvalDigest: hash,
      content,
      contentHash: sha256HexSync(content),
      metadataDiff: [],
      reviewedSupport,
    },
  };
};

describe('maintenance presentation', () => {
  it('binds automatic completion to frozen exact old observations without mutating or hiding newer same-URI evidence', () => {
    fc.assert(
      fc.property(
        fc.record({
          sameProject: fc.boolean(),
          sameMemory: fc.boolean(),
          sameUri: fc.boolean(),
          sameHash: fc.boolean(),
          activeAnchor: fc.boolean(),
          verified: fc.boolean(),
          written: fc.boolean(),
          newer: fc.boolean(),
          sameTargetAtReply: fc.boolean(),
          partial: fc.boolean(),
          reverse: fc.boolean(),
        }),
        flags => {
          const review = automaticCompletion();
          const source = review.approval!.reviewedSupport.active.sources[0].source;
          if (source.kind !== 'code') throw new Error('Fixture requires actual active code support.');
          const oldId = `tncc_${Effect.pipe('1', EffectString.repeat(40))}`;
          const citationId = flags.activeAnchor ? source.citation.id : oldId;
          const observed: ManagerContextMaintenanceCaseV2 = {
            ...caseAt(0),
            project: flags.sameProject ? review.project : 'other',
            memoryId: flags.sameMemory ? 'memory-0' : 'other-memory',
            subjectUri: flags.sameUri ? review.targetUri : 'threadnote://memory/other',
            subjectContentHashes: [
              {
                uri: review.targetUri,
                hash: flags.sameHash ? review.targetHash : Effect.pipe('f', EffectString.repeat(64)),
              },
            ],
            slot: `anchor:${citationId}`,
            disposition: 'needs-decision',
            reason: 'source-changed',
          };
          const completed = {
            ...review,
            verified: flags.verified,
            approval: {...review.approval!, stage: flags.written ? ('written' as const) : ('preview' as const)},
          };
          const activeCase = {
            ...observed,
            caseId: 'active',
            project: review.project,
            memoryId: 'memory-0',
            subjectUri: review.targetUri,
            slot: `anchor:${source.citation.id}`,
          };
          const unrelated = {...observed, caseId: 'same-uri-relation', family: 'relation'};
          const newerTarget = {
            ...observed,
            caseId: 'same-uri-new-target',
            subjectContentHashes: [{uri: review.targetUri, hash: Effect.pipe('e', EffectString.repeat(64))}],
          };
          const frozen = [observed, activeCase, unrelated, newerTarget];
          const current = {
            ...observed,
            evidenceRevision: flags.newer ? 'new-source-revision' : observed.evidenceRevision,
            subjectContentHashes: flags.sameTargetAtReply
              ? observed.subjectContentHashes
              : [{uri: review.targetUri, hash: Effect.pipe('d', EffectString.repeat(64))}],
          };
          const cases = [current, activeCase, unrelated, newerTarget];
          const status: ManagerContextMaintenanceStatusV2 = {
            version: 2,
            generation: 'one',
            state: 'needs-decision',
            paused: true,
            projects: [],
            cases,
            receipts: [],
            omittedCases: flags.partial ? 1 : 0,
            counts: {
              'needs-decision': cases.length,
              decisionMemories: new Set(EffectArray.map(cases, item => item.memoryId)).size,
            },
          };
          const before = JSON.stringify({completed, frozen, status});
          const receipts = automaticReviewMaintenanceReceipts(
            completed,
            flags.reverse ? [...frozen].reverse() : frozen,
          );
          const resolves =
            flags.sameProject &&
            flags.sameMemory &&
            flags.sameUri &&
            flags.sameHash &&
            !flags.activeAnchor &&
            flags.verified &&
            flags.written;
          expect(EffectArray.map(receipts, item => item.caseId)).toEqual(resolves ? [observed.caseId] : []);
          expect(automaticReviewMaintenanceReceipts(completed, [...frozen].reverse())).toEqual(receipts);
          const next = reconcileAppliedMaintenanceCases(status, receipts);
          expect(next.cases).toEqual(resolves && !flags.newer && flags.sameTargetAtReply ? cases.slice(1) : cases);
          expect(next.counts?.['needs-decision']).toBe(
            cases.length - Number(resolves && !flags.newer && flags.sameTargetAtReply),
          );
          expect(reconcileAppliedMaintenanceCases(next, [...receipts, ...receipts])).toEqual(next);
          expect(JSON.stringify({completed, frozen, status})).toBe(before);
        },
      ),
      {numRuns: 80},
    );
  });
  it('uses exact frozen capture/report identities after real anchor-preserving recapture, independent of order and without mutation', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 100_000}),
        fc.constantFrom(
          'exact',
          'project',
          'uri',
          'hash',
          'case',
          'memory',
          'family',
          'anchor',
          'capture',
          'finding',
          'ambiguous',
          'missing-identity',
        ),
        fc.boolean(),
        fc.boolean(),
        (value, mismatch, reverse, partial) => {
          const capture = (n: number) =>
            createMemoryCodeCitation({
              version: 1,
              extractorSet: 'test',
              fileContentHash: {algorithm: 'sha256', value: sha256HexSync(`const limit = ${n};`)},
              path: 'limit.ts',
              repositoryId: Effect.pipe('b', EffectString.repeat(64)),
              repositoryIdentityKind: 'local',
              sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
              sourceDirty: false,
              sourceSnapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}`,
              target: {kind: 'file'},
            });
          const first = capture(value);
          const recaptured = preserveMemoryCodeCitationAnchor(first, capture(value + 1));
          expect(recaptured.id).not.toBe(recaptured.anchorId);
          const uri = automaticCompletion().targetUri;
          const content = `MEMORY\nschema_version: 11\nkind: durable\nproject: threadnote\nmemory_id: memory-0\ncode_citation: ${formatMemoryCodeCitation(recaptured)}\n\nThe limit is ${value}.`;
          const record = parseMemoryDocument(uri, content);
          if (!record) throw new Error('Recaptured record must parse.');
          const hash = sha256HexSync(content);
          const review = automaticCompletion(hash);
          const health = buildContextHealthReport({
            project: 'threadnote',
            records: [record],
            now: new Date('2026-10-22T00:00:00.000Z'),
            includeFindingCategories: ['citation-changed'],
            citationValidations: [
              {
                uri,
                receipts: [
                  {
                    citationId: recaptured.id,
                    candidateCount: 1,
                    coverage: 'current-complete',
                    kind: 'file',
                    observedAt: '2026-10-22T00:00:00.000Z',
                    reason: 'source-changed',
                    status: 'changed',
                    strategy: 'file-path',
                    validatorVersion: 1,
                  },
                ],
              },
            ],
          });
          expect(health.findings).toHaveLength(1);
          const finding = health.findings[0];
          expect(finding.caseIdentity?.slot).toBe(`anchor:${first.id}`);
          const observed: ManagerContextMaintenanceCaseV2 = {
            ...caseAt(0),
            caseId: finding.caseId!,
            slot: finding.caseIdentity!.slot,
            subjectUri: uri,
            subjectContentHashes: [{uri, hash}],
            disposition: 'needs-decision',
          };
          const base: ManagerContextHealthResponseV1 = {
            ...health,
            omittedFindings: partial ? 1 : 0,
            repositoryEvidence: {state: 'available'},
            recordPreviews: [
              {
                uri,
                contentHash: hash,
                title: 'Limit',
                kind: 'durable',
                excerpt: record.body,
                code: [{citationId: recaptured.id, path: recaptured.path, findingIds: [finding.id]}],
              },
            ],
          };
          let proof = base;
          if (mismatch === 'project') proof = {...base, project: 'other'};
          if (mismatch === 'uri' || mismatch === 'hash' || mismatch === 'capture' || mismatch === 'finding')
            proof = {
              ...base,
              recordPreviews: EffectArray.map(base.recordPreviews, item => ({
                ...item,
                ...(mismatch === 'uri' ? {uri: 'threadnote://memory/other'} : {}),
                ...(mismatch === 'hash' ? {contentHash: Effect.pipe('e', EffectString.repeat(64))} : {}),
                code: EffectArray.map(item.code, code => ({
                  ...code,
                  ...(mismatch === 'capture' ? {citationId: first.id} : {}),
                  ...(mismatch === 'finding' ? {findingIds: ['another-finding']} : {}),
                })),
              })),
            };
          if (['case', 'memory', 'family', 'anchor', 'missing-identity'].includes(mismatch))
            proof = {
              ...base,
              findings: EffectArray.map(base.findings, item => ({
                ...item,
                ...(mismatch === 'case' ? {caseId: 'other-case'} : {}),
                caseIdentity:
                  mismatch === 'missing-identity'
                    ? undefined
                    : {
                        ...item.caseIdentity!,
                        ...(mismatch === 'memory' ? {memoryId: 'other-memory'} : {}),
                        ...(mismatch === 'family' ? {family: 'relation'} : {}),
                        ...(mismatch === 'anchor' ? {slot: `anchor:${recaptured.id}`} : {}),
                      },
              })),
            };
          if (mismatch === 'ambiguous') {
            const other = capture(value + 2);
            proof = {
              ...base,
              findings: [
                ...base.findings,
                {...finding, id: 'ambiguous-capture', repair: {...finding.repair, targetUri: `${uri}#${other.id}`}},
              ],
              recordPreviews: EffectArray.map(base.recordPreviews, item => ({
                ...item,
                code: [...item.code, {citationId: other.id, path: other.path, findingIds: ['ambiguous-capture']}],
              })),
            };
          }
          const ordered = reverse
            ? {
                ...proof,
                findings: [...proof.findings].reverse(),
                recordPreviews: EffectArray.map([...proof.recordPreviews].reverse(), item => ({
                  ...item,
                  code: [...item.code].reverse(),
                })),
              }
            : proof;
          const before = JSON.stringify({review, observed, proof, ordered});
          const receipts = automaticReviewMaintenanceReceipts(review, [observed], ordered);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].resolvedCitationIds).toEqual(mismatch === 'exact' ? [recaptured.id] : []);
          expect(automaticReviewMaintenanceReceipts(review, [observed], proof)).toEqual(receipts);
          const next = reconcileAppliedHealthReport(proof, receipts);
          expect(next.findings).toEqual(mismatch === 'exact' ? [] : proof.findings);
          expect(next.maintenance?.affectedMemories).toBe(mismatch === 'exact' && !partial ? 0 : 1);
          expect(reconcileAppliedHealthReport(next, receipts)).toEqual(next);
          expect(JSON.stringify({review, observed, proof, ordered})).toBe(before);
        },
      ),
      {numRuns: 60},
    );
  });
  it('refuses malformed or misbound automatic written proof and retains unloaded attention counts', () => {
    const review = automaticCompletion();
    const citationId = `tncc_${Effect.pipe('1', EffectString.repeat(40))}`;
    const observed: ManagerContextMaintenanceCaseV2 = {
      ...caseAt(0),
      subjectUri: review.targetUri,
      subjectContentHashes: [{uri: review.targetUri, hash: review.targetHash}],
      disposition: 'needs-decision',
      slot: `anchor:${citationId}`,
    };
    const receipts = automaticReviewMaintenanceReceipts(review, [observed]);
    expect(receipts).toHaveLength(1);
    for (const changed of [
      {...observed, subjectContentHashes: [{uri: review.targetUri, hash: Effect.pipe('c', EffectString.repeat(64))}]},
      {...observed, slot: `anchor:tncc_${Effect.pipe('2', EffectString.repeat(40))}`},
      {...observed, memoryId: 'new-memory'},
      {...observed, family: 'relation'},
    ]) {
      const status: ManagerContextMaintenanceStatusV2 = {
        version: 2,
        generation: 'new-target',
        state: 'needs-decision',
        paused: true,
        projects: [],
        cases: [changed],
        receipts: [],
        counts: {'needs-decision': 1, decisionMemories: 1},
      };
      expect(reconcileAppliedMaintenanceCases(status, receipts)).toBe(status);
    }
    for (const bad of [
      {...review, state: 'applying' as const},
      {...review, reviewId: 'review-other'},
      {...review, targetHash: Effect.pipe('b', EffectString.repeat(64))},
      {...review, approval: {...review.approval!, contentHash: Effect.pipe('0', EffectString.repeat(64))}},
      {
        ...review,
        approval: {
          ...review.approval!,
          content: 'MEMORY\nkind: durable\n\nUnbound.',
          contentHash: sha256HexSync('MEMORY\nkind: durable\n\nUnbound.'),
        },
      },
    ])
      expect(automaticReviewMaintenanceReceipts(bad, [observed])).toEqual([]);
    const next = reconcileAppliedMaintenanceCases(
      {
        version: 2,
        generation: 'one',
        state: 'needs-decision',
        paused: true,
        projects: [],
        cases: [observed],
        receipts: [],
        omittedCases: 1,
        counts: {'needs-decision': 2, decisionMemories: 1},
      },
      receipts,
    );
    expect(next.cases).toEqual([]);
    expect(next.counts).toEqual({'needs-decision': 1, decisionMemories: 1});
  });
  it('reconciles only receipt-proven report slots and preserves unrelated findings, hashes and observations', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 12}),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (otherCount, sameProject, sameHash, sameObservation, hasProof) => {
          const uri = 'threadnote://memory/topic';
          const finding = (index: number): ManagerContextHealthResponseV1['findings'][number] => ({
            id: `finding-${index}`,
            category: index % 3 === 1 ? 'semantic-contradiction' : 'citation-changed',
            confidence: 'high',
            severity: 'high',
            classification: 'actionable',
            repairability: 'reviewable',
            summary: 'Review source',
            uris: [index % 3 === 2 ? 'threadnote://memory/other' : uri],
            repair: {
              kind: 'review-memory',
              subjectUri: index % 3 === 2 ? 'threadnote://memory/other' : uri,
              targetUri: `${uri}#citation-${index}`,
              summary: 'Review',
            },
          });
          const findings = Array.from({length: otherCount + 1}, (_, index) => finding(index));
          const base = buildContextHealthReport({project: 'threadnote', records: [], now: new Date('2026-10-01')});
          const original: ManagerContextHealthResponseV1 = {
            ...base,
            findings,
            recordPreviews: [
              {
                uri,
                title: 'Topic',
                kind: 'durable',
                excerpt: 'Claim',
                contentHash: sameHash ? 'old-hash' : 'new-hash',
                code: EffectArray.map(findings, (item, index) => ({
                  citationId: `citation-${index}`,
                  path: 'source.ts',
                  findingIds: [item.id],
                })),
              },
            ],
            repositoryEvidence: {state: 'available'},
            maintenance: {
              ...base.maintenance!,
              actionableFindings: findings.length,
              affectedMemories: new Set(EffectArray.flatMap(findings, item => item.uris)).size,
            },
          };
          const before = JSON.stringify(original);
          const receipts = [
            {
              project: sameProject ? 'threadnote' : 'other',
              caseId: 'case-2',
              evidenceRevision: 'old',
              targetUri: uri,
              targetHash: 'old-hash',
              ...(hasProof ? {resolvedCitationIds: ['citation-0']} : {}),
            },
          ];
          const status: ManagerContextMaintenanceStatusV2 = {
            version: 2,
            paused: false,
            state: 'needs-decision',
            generation: 'one',
            projects: [],
            cases: [{...caseAt(2), evidenceRevision: sameObservation ? 'old' : 'new', disposition: 'needs-decision'}],
            receipts: [],
          };
          const next = reconcileAppliedHealthReport(original, receipts, status);
          const resolves = sameProject && sameHash && sameObservation && hasProof;
          expect(next.findings).toEqual(resolves ? findings.slice(1) : findings);
          expect(next.maintenance?.actionableFindings).toBe(findings.length - Number(resolves));
          expect(next.maintenance?.affectedMemories).toBe(
            new Set(EffectArray.flatMap(resolves ? findings.slice(1) : findings, item => item.uris)).size,
          );
          expect(reconcileAppliedHealthReport(next, receipts, status)).toEqual(next);
          expect(reconcileAppliedHealthReport(original, [{...receipts[0], caseId: undefined}], status)).toBe(original);
          const missingHash = {
            ...original,
            recordPreviews: EffectArray.map(original.recordPreviews, preview => ({...preview, contentHash: undefined})),
          };
          expect(reconcileAppliedHealthReport(missingHash, receipts, status)).toBe(missingHash);
          expect(JSON.stringify(original)).toBe(before);
        },
      ),
      {numRuns: 60},
    );
  });
  it('reconciles exact applied observations idempotently without removing unrelated or newer revisions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({id: fc.integer({min: 0, max: 12}), revision: fc.integer({min: 0, max: 3})}), {
          maxLength: 40,
        }),
        values => {
          const cases = EffectArray.map(values, ({id, revision}) => ({
            ...caseAt(id),
            disposition: 'needs-decision' as const,
            evidenceRevision: `revision-${revision}`,
          }));
          const original: ManagerContextMaintenanceStatusV2 = {
            version: 2,
            generation: 'one',
            state: 'needs-decision',
            paused: false,
            projects: [],
            cases,
            receipts: [],
            counts: {
              'needs-decision': cases.length,
              decisionMemories: new Set(EffectArray.map(cases, item => item.memoryId)).size,
            },
          };
          const before = JSON.stringify(original);
          const applied = [{project: 'threadnote', caseId: 'case-2', evidenceRevision: 'revision-1'}];
          const next = reconcileAppliedMaintenanceCases(original, applied);
          expect(next.cases).toEqual(
            EffectArray.filter(cases, item => item.caseId !== 'case-2' || item.evidenceRevision !== 'revision-1'),
          );
          expect(next.counts?.['needs-decision']).toBe(next.cases.length);
          expect(next.counts?.decisionMemories).toBe(new Set(EffectArray.map(next.cases, item => item.memoryId)).size);
          expect(reconcileAppliedMaintenanceCases(next, applied)).toEqual(next);
          expect(JSON.stringify(original)).toBe(before);
          expect(reconcileAppliedMaintenanceCases(original, [{...applied[0], project: 'another'}])).toBe(original);
        },
      ),
      {numRuns: 50},
    );
  });
  it('groups 200 blocked anchors for one repository into one recovery row', () => {
    const groups = groupMaintenanceCauses(Array.from({length: 200}, (_, index) => caseAt(index)));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({count: 200, repositoryId: 'repo-one', reason: 'repository-unavailable'});
  });
  it('keeps aggregate memory attention conservative while other case details are unloaded', () => {
    const item = {...caseAt(2), disposition: 'needs-decision' as const};
    const original: ManagerContextMaintenanceStatusV2 = {
      version: 2,
      generation: 'one',
      state: 'needs-decision',
      paused: false,
      projects: [],
      cases: [item],
      receipts: [],
      omittedCases: 1,
      counts: {'needs-decision': 2, decisionMemories: 1},
    };
    const next = reconcileAppliedMaintenanceCases(original, [
      {project: item.project, caseId: item.caseId, evidenceRevision: item.evidenceRevision},
    ]);
    expect(next.cases).toEqual([]);
    expect(next.counts).toEqual({'needs-decision': 1, decisionMemories: 1});
  });
  it('is permutation invariant and repeated receipts cannot inflate recovery counts', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 200}), count => {
        const cases = Array.from({length: count}, (_, index) => caseAt(index));
        expect(groupMaintenanceCauses([...cases].reverse().concat(cases))).toEqual(groupMaintenanceCauses(cases));
      }),
      {numRuns: 40},
    );
  });
  it('merges retained pages idempotently and never accepts a different generation', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 100}), count => {
        const cases = Array.from({length: count}, (_, index) => caseAt(index));
        const current = {
          version: 2 as const,
          state: 'idle' as const,
          generation: 'corpus',
          paused: false,
          projects: [],
          cases: cases.slice(0, 10),
          receipts: [],
          omittedCases: Math.max(0, count - 10),
          page: {generation: 'page', receiptNextCursor: 'receipts'},
        };
        const page = {
          ...current,
          cases: cases.slice(10),
          omittedCases: Math.min(count, 10),
          page: {generation: 'page'},
        };
        const merged = mergeMaintenanceStatusPage(current, page, 'cases');
        expect(merged.cases).toEqual(cases);
        expect(merged.omittedCases).toBe(0);
        expect(mergeMaintenanceStatusPage(merged, page, 'cases')).toEqual(merged);
        expect(merged.page?.receiptNextCursor).toBe('receipts');
        expect(() => mergeMaintenanceStatusPage(current, {...page, page: {generation: 'changed'}}, 'cases')).toThrow(
          'Refresh',
        );
      }),
      {numRuns: 40},
    );
  });
  it('never calls incomplete zero-decision evidence verified', () => {
    expect(maintenanceStatusLabel({decisions: 0, coverage: 'partial', paused: false, state: 'idle'})).toBe(
      'No decisions needed; evidence checks are incomplete',
    );
    expect(maintenanceStatusLabel({decisions: 3, coverage: 'partial', paused: false, state: 'waiting-evidence'})).toBe(
      '3 memories need your decision',
    );
  });
  it('clears omissions after loading every retained case and receipt across multiple pages', () => {
    const cases = Array.from({length: 73}, (_, index) => caseAt(index));
    const receipts: ManagerContextMaintenanceReceiptV2[] = Array.from({length: 23}, (_, index) => ({
      receiptId: `receipt-${index}`,
      project: 'threadnote',
      subjectUri: `threadnote://user/tester/memories/handoffs/active/threadnote/record-${index}.md`,
      postHash: Effect.pipe('a', EffectString.repeat(64)),
      timestamp: '2026-10-03',
      state: 'applied',
    }));
    const pageAt = (caseOffset: number, receiptOffset: number): ManagerContextMaintenanceStatusV2 => {
      const selectedCases = cases.slice(caseOffset, caseOffset + 30);
      const selectedReceipts = receipts.slice(receiptOffset, receiptOffset + 10);
      return {
        version: 2,
        state: 'idle',
        generation: 'corpus',
        paused: false,
        projects: [],
        cases: selectedCases,
        receipts: selectedReceipts,
        omittedCases: cases.length - selectedCases.length,
        omittedReceipts: receipts.length - selectedReceipts.length,
        page: {generation: 'page'},
      };
    };
    let loaded = pageAt(0, 0);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(30, 0), 'cases');
    expect(loaded.omittedCases).toBe(13);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(60, 0), 'cases');
    expect(loaded.cases).toEqual(cases);
    expect(loaded.omittedCases).toBe(0);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(0, 10), 'receipts');
    expect(loaded.omittedReceipts).toBe(3);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(0, 20), 'receipts');
    expect(loaded.receipts).toEqual(receipts);
    expect(loaded.omittedReceipts).toBe(0);
    expect(mergeMaintenanceStatusPage(loaded, pageAt(0, 20), 'receipts')).toEqual(loaded);
  });
});
