import {Array as EffectArray, Record as EffectRecord} from 'effect';
import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {MEMORY_SCHEMA_VERSION, createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {isCodeTopicMaintenanceManifest, proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {recordVerifiedCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphStoreError, type CodeGraphStatus} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';

import {
  boundTopicMaintenanceEvidencePacket,
  buildTopicMaintenanceEvidencePacket,
  observeTopicMaintenanceEvidence,
  projectTopicMaintenanceObservation,
} from '../src/topic_maintenance.js';
import {citationPlatformLayer} from './helpers/citation-platform.js';
import {contextBriefMemoryCandidate} from '../src/memory-evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from '../src/planner.js';
import {parseContextBriefJsonText, parseContextBriefV1, projectContextBrief} from '../src/projector.js';
import {projectContextBriefAgentView} from '../src/projection_view.js';
import {
  CONTEXT_BRIEF_TOPIC_AGENT_VIEW_VERSION,
  CONTEXT_BRIEF_TOPIC_PROJECTOR_VERSION,
  CONTEXT_BRIEF_TOPIC_VERSION,
} from '../src/types.js';
import type {ContextBriefGraphEvidenceV1} from '../src/types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import {Option as EffectOption} from 'effect';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const citation = createMemoryCodeCitation({
  evidenceRetention: 'capsule-retained',
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
  path: 'src/source.ts',
  repositoryId: Effect2.pipe('1', EffectString.repeat(64)),
  repositoryIdentityKind: 'remote',
  sourceCommit: Effect2.pipe('2', EffectString.repeat(40)),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${Effect2.pipe('4', EffectString.repeat(40))}`,
  target: {kind: 'file'},
  version: 1,
});

const source = parseMemoryDocument(
  uri,
  formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      memoryId: 'tn_topic_fixture',
      project: 'threadnote',
      schemaVersion: 8,
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-10-16T00:00:00.000Z',
    },
    'Claim.\n\nClaim.',
  ),
)!;
const enrolled = parseMemoryDocument(
  uri,
  proposeTopicMaintenanceEnrollment(source, {
    paragraphs: [
      {role: 'descriptive', support: 'direct', citationIds: [citation.id]},
      {role: 'historical', support: 'contextual', citationIds: [citation.id]},
    ],
  }).content,
)!;

const currentWithHash = (original: typeof citation, hash: string) => {
  if (hash === original.fileContentHash.value) return original;
  const {id: _id, ...input} = original;
  return createMemoryCodeCitation({...input, fileContentHash: {algorithm: 'sha256' as const, value: hash}});
};
const evidence = (hash: string) => ({
  citationId: citation.id,
  status: 'exact' as const,
  reason: 'exact' as const,
  historicalAvailable: true,
  current: currentWithHash(citation, hash),
  currentFileBytesHash: hash,
});

const acceptComparison = (record: MemoryRecord, accepted: MemoryCodeCitationV1) => {
  const manifest = record.metadata.topicMaintenance!;
  if (!isCodeTopicMaintenanceManifest(manifest)) throw new Error('Expected the code fixture.');
  const declaredIds = [
    ...new Set([
      ...EffectArray.flatMap(manifest.paragraphs, paragraph => paragraph.citationIds),
      ...EffectArray.map(manifest.additionalDependencies, dependency => dependency.citationId),
    ]),
  ].sort();
  return parseMemoryDocument(
    record.uri,
    formatMemoryDocument(
      'MEMORY',
      {
        ...record.metadata,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        codeCitations: [
          ...new Map(
            EffectArray.map([...(record.metadata.codeCitations ?? []), accepted], item => [item.id, item]),
          ).values(),
        ],
        topicMaintenance: {
          ...manifest,
          version: 2,
          originCitationIds: EffectArray.map(record.metadata.codeCitations ?? [], item => item.id).sort(),
          acceptedSources: EffectArray.map(declaredIds, citationId => ({citationId, acceptedCitationId: accepted.id})),
        },
      },
      record.body,
    ),
  )!;
};

describe('accepted topic Context Brief projection', () => {
  it('uses the accepted V2 pin and a single accepted paragraph, retaining origin lineage in storage', () => {
    const current = currentWithHash(citation, Effect2.pipe('b', EffectString.repeat(64)));
    const accepted = acceptComparison(enrolled, current);
    const candidate = contextBriefMemoryCandidate(
      accepted,
      0,
      [
        {anchorOrdinal: 0, anchorPath: 'src/source.ts', citationId: citation.id, matchKind: 'file-path'},
        {anchorOrdinal: 1, anchorPath: 'src/source.ts', citationId: current.id, matchKind: 'file-path'},
      ],
      true,
      {attention: 'pending-review', reviewId: `review-${Effect2.pipe('a', EffectString.repeat(24))}`},
    );
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(accepted.metadata.codeCitations), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, item => item.id),
        ),
      ),
    ).toContain(citation.id);
    expect(EffectArray.map(candidate.codeCitations, item => item.id)).toEqual([current.id]);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(candidate.codeLinkMatches), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, item => item.citationId),
        ),
      ),
    ).toEqual([current.id]);
    expect(candidate.excerpt).toBe('Claim.');
    expect(candidate.topicMaintenance).toMatchObject({
      coverage: 'declared-only',
      excerptOrdinal: 1,
      excerptRole: 'descriptive',
      historicalParagraphs: 1,
      attention: 'pending-review',
    });
  });

  it('V1 compares the original pin and historical-only support never promotes an origin pin', () => {
    expect(EffectArray.map(contextBriefMemoryCandidate(enrolled, 0, undefined).codeCitations, item => item.id)).toEqual(
      [citation.id],
    );
    const historical = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(source, {
        paragraphs: [
          {role: 'historical', support: 'contextual', citationIds: [citation.id]},
          {role: 'historical', support: 'contextual', citationIds: [citation.id]},
        ],
      }).content,
    )!;
    const candidate = contextBriefMemoryCandidate(historical, 0, undefined);
    expect(candidate.codeCitations).toEqual([]);
    expect(candidate.topicMaintenance?.historicalParagraphs).toBe(2);
    const historicalLogical = topicLogical(candidate, []);
    expect(historicalLogical.durableDecisions[0].freshness).toBe('unknown');
    expect(
      EffectArray.some(historicalLogical.stalenessAndConflicts, item =>
        Effect2.pipe(item.summary, EffectString.includes('no active comparison pins')),
      ),
    ).toBe(true);
  });

  it('uses accepted current comparison status and later changed pins become stale', () => {
    const accepted = acceptComparison(enrolled, currentWithHash(citation, Effect2.pipe('b', EffectString.repeat(64))));
    const candidate = contextBriefMemoryCandidate(accepted, 0, undefined);
    expect(topicLogical(candidate, ['exact']).durableDecisions[0].freshness).toBe('fresh');
    expect(topicLogical(candidate, ['changed']).durableDecisions[0].freshness).toBe('stale');
    expect(topicLogical(candidate, ['changed']).stalenessAndConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({kind: 'topic-support', summary: expect.stringContaining('current repository')}),
      ]),
    );
    expect(topicLogical(candidate, ['unknown']).durableDecisions[0].freshness).toBe('unknown');
  });

  it('deduplicates different declarations resolving to one accepted V2 pin', () => {
    fc.assert(
      fc.property(fc.integer({min: 2, max: 8}), count => {
        const pins = Array.from({length: count}, (_, index) =>
          currentWithHash(citation, Effect2.pipe('abcdef12'[index], EffectString.repeat(64))),
        );
        const current = pins.at(-1)!;
        const record = parseMemoryDocument(
          uri,
          formatMemoryDocument(
            'MEMORY',
            {
              ...source.metadata,
              codeCitations: pins,
            },
            'Claim.\n\nClaim.',
          ),
        )!;
        const marked = parseMemoryDocument(
          uri,
          proposeTopicMaintenanceEnrollment(record, {
            paragraphs: [
              {role: 'descriptive', support: 'direct', citationIds: [pins[0].id]},
              {role: 'normative', support: 'direct', citationIds: [current.id]},
            ],
            additionalDependencies: EffectArray.map(pins.slice(1, -1), pin => ({
              kind: 'dependency' as const,
              citationId: pin.id,
            })),
          }).content,
        )!;
        const accepted = acceptComparison(marked, current);
        const candidate = contextBriefMemoryCandidate(accepted, 0, undefined);
        expect(accepted.metadata.codeCitations).toHaveLength(count);
        expect(EffectArray.map(candidate.codeCitations, item => item.id)).toEqual([current.id]);
        expect(topicLogical(candidate, ['exact']).durableDecisions[0].citationSummary).toMatchObject({exact: 1});
      }),
      {numRuns: 20},
    );
  });

  it('versions enrolled wire output and rejects topic fields on an older closed schema', () => {
    const current = acceptComparison(enrolled, currentWithHash(citation, Effect2.pipe('b', EffectString.repeat(64))));
    const enrolledProjection = projectContextBrief(
      topicLogical(contextBriefMemoryCandidate(current, 0, undefined), ['exact']),
      1500,
      'agent',
    );
    expect(enrolledProjection.structuredContent.version).toBe(CONTEXT_BRIEF_TOPIC_VERSION);
    expect(enrolledProjection.structuredContent.output.projectorVersion).toBe(CONTEXT_BRIEF_TOPIC_PROJECTOR_VERSION);
    expect(parseContextBriefV1(enrolledProjection.structuredContent)).toEqual(enrolledProjection.structuredContent);
    const agentView = projectContextBriefAgentView(enrolledProjection.structuredContent);
    expect(parseContextBriefJsonText(JSON.stringify(agentView)).version).toBe(CONTEXT_BRIEF_TOPIC_AGENT_VIEW_VERSION);
    const oldProjection = projectContextBrief(
      topicLogical(contextBriefMemoryCandidate(source, 0, undefined), ['exact']),
      1500,
      'agent',
    );
    expect(oldProjection.structuredContent.version).not.toBe(CONTEXT_BRIEF_TOPIC_VERSION);
    expect(parseContextBriefV1(oldProjection.structuredContent)).toEqual(oldProjection.structuredContent);
    const oldAgentView = projectContextBriefAgentView(oldProjection.structuredContent);
    expect(parseContextBriefJsonText(JSON.stringify(oldAgentView))).toEqual(oldAgentView);
    expect(() =>
      parseContextBriefJsonText(
        JSON.stringify({
          ...oldAgentView,
          durableDecisions: [
            {...oldAgentView.durableDecisions![0], topicMaintenance: agentView.durableDecisions![0].topicMaintenance},
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseContextBriefV1({...enrolledProjection.structuredContent, version: oldProjection.structuredContent.version}),
    ).toThrow();
    expect(() => parseContextBriefJsonText(JSON.stringify({...agentView, version: 1}))).toThrow();
    for (const topicMaintenance of [
      undefined,
      {},
      {coverage: 'complete'},
      {...agentView.durableDecisions![0].topicMaintenance, extra: true},
      {...agentView.durableDecisions![0].topicMaintenance, excerptOrdinal: 65},
      {...agentView.durableDecisions![0].topicMaintenance, unresolvedParagraphs: -1},
      {...agentView.durableDecisions![0].topicMaintenance, normativeParagraphs: 1.5},
      {...agentView.durableDecisions![0].topicMaintenance, excerptRole: 'guessed'},
      {...agentView.durableDecisions![0].topicMaintenance, attention: 'pending-review', reviewId: undefined},
      {
        ...agentView.durableDecisions![0].topicMaintenance,
        attention: 'none',
        reviewId: `review-${Effect2.pipe('a', EffectString.repeat(24))}`,
      },
    ]) {
      expect(() =>
        parseContextBriefV1({
          ...enrolledProjection.structuredContent,
          durableDecisions: [{...enrolledProjection.structuredContent.durableDecisions[0], topicMaintenance}],
        }),
      ).toThrow();
    }
  });

  it('preserves Context Brief field order and citation coverage across wire key permutations', () => {
    const current = acceptComparison(enrolled, currentWithHash(citation, Effect2.pipe('b', EffectString.repeat(64))));
    const projection = projectContextBrief(
      topicLogical(contextBriefMemoryCandidate(current, 0, undefined), ['exact']),
      1500,
      'agent',
    ).structuredContent;
    const agentView = projectContextBriefAgentView(projection);
    const structuredRecord: Record<string, unknown> = JSON.parse(JSON.stringify(projection));
    const agentRecord: Record<string, unknown> = JSON.parse(JSON.stringify(agentView));
    const structuredEntries = EffectRecord.toEntries(structuredRecord);
    const agentEntries = EffectRecord.toEntries(agentRecord);
    const encode = (entries: ReadonlyArray<readonly [string, unknown]>): string =>
      `{${EffectArray.join(
        EffectArray.map(entries, ([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`),
        ',',
      )}}`;

    fc.assert(
      fc.property(
        fc.shuffledSubarray(structuredEntries, {
          minLength: structuredEntries.length,
          maxLength: structuredEntries.length,
        }),
        entries => {
          const parsed = parseContextBriefV1(JSON.parse(encode(entries)));
          expect(EffectRecord.keys(JSON.parse(JSON.stringify(parsed)))).toEqual(
            EffectArray.map(entries, ([key]) => key),
          );
          expect(parsed.durableDecisions[0]?.citationSummary).toEqual(projection.durableDecisions[0]?.citationSummary);
        },
      ),
      {numRuns: 30},
    );
    fc.assert(
      fc.property(
        fc.shuffledSubarray(agentEntries, {minLength: agentEntries.length, maxLength: agentEntries.length}),
        entries => {
          const parsed = parseContextBriefJsonText(encode(entries));
          expect(EffectRecord.keys(JSON.parse(JSON.stringify(parsed)))).toEqual(
            EffectArray.map(entries, ([key]) => key),
          );
          expect(parsed.durableDecisions?.[0]?.citationSummary).toEqual(
            agentView.durableDecisions?.[0]?.citationSummary,
          );
        },
      ),
      {numRuns: 30},
    );
  });

  it('keeps accepted paragraph excerpt deterministic and role-bound across bounded text', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z]{1,80}$/u), phrase => {
        const record = parseMemoryDocument(
          uri,
          formatMemoryDocument('MEMORY', source.metadata, `${phrase}\n\nHistorical claim.`),
        )!;
        const marked = parseMemoryDocument(
          uri,
          proposeTopicMaintenanceEnrollment(record, {
            paragraphs: [
              {role: 'normative', support: 'direct', citationIds: [citation.id]},
              {role: 'historical', support: 'contextual', citationIds: [citation.id]},
            ],
          }).content,
        )!;
        const candidate = contextBriefMemoryCandidate(marked, 0, undefined);
        expect(candidate.excerpt).not.toContain('Historical claim.');
        expect(candidate.topicMaintenance?.excerptRole).toBe('normative');
        expect(contextBriefMemoryCandidate(marked, 0, undefined)).toEqual(candidate);
      }),
      {numRuns: 50},
    );
  });

  it('keeps every retained enrolled excerpt with its status through 800–1500 token projection', () => {
    const accepted = acceptComparison(enrolled, currentWithHash(citation, Effect2.pipe('b', EffectString.repeat(64))));
    const candidate = contextBriefMemoryCandidate(accepted, 0, undefined, true, {
      attention: 'pending-review',
      reviewId: `review-${Effect2.pipe('a', EffectString.repeat(24))}`,
    });
    const graph: ContextBriefGraphEvidenceV1 = {
      cards: [],
      contracts: [],
      coverage: {complete: true, consideredRepositories: 0, readyRepositories: 0, requestedRepositories: 0, states: {}},
      gaps: [],
      resolvedSnapshots: [],
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      warnings: [],
    };
    fc.assert(
      fc.property(fc.integer({min: 800, max: 1500}), budgetTokens => {
        const logical = assembleContextBriefLogicalResult({
          graph,
          memory: {
            candidates: [candidate],
            consideredCandidates: 1,
            gaps: [],
            trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
          },
          observedAt: '2026-10-16T00:00:00.000Z',
          plan: planContextBrief({
            budgetTokens,
            mode: 'brief',
            scope: {callerCwd: '/synthetic/repository', kind: 'repository'},
            task: 'Claim',
          }),
        });
        const projection = projectContextBrief(logical, budgetTokens, 'agent');
        const memory = projection.structuredContent.durableDecisions[0];
        if (memory) {
          expect(memory.topicMaintenance).toEqual(candidate.topicMaintenance);
          expect(projection.structuredContent.version).toBe(CONTEXT_BRIEF_TOPIC_VERSION);
          expect(projection.text).toContain('Topic maintenance');
          expect(projection.text).toContain('pending-review');
        } else {
          expect(projection.structuredContent.coverage.omissions.durableDecisions).toBeGreaterThan(0);
        }
        expect(projectContextBrief(logical, budgetTokens, 'agent').text).toBe(projection.text);
      }),
      {numRuns: 30},
    );
  });
});

function topicLogical(
  candidate: ReturnType<typeof contextBriefMemoryCandidate>,
  statuses: readonly ('exact' | 'changed' | 'unknown')[],
) {
  const graph: ContextBriefGraphEvidenceV1 = {
    cards: [],
    contracts: [],
    coverage: {complete: true, consideredRepositories: 0, readyRepositories: 0, requestedRepositories: 0, states: {}},
    gaps: [],
    resolvedSnapshots: [],
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
  return assembleContextBriefLogicalResult({
    graph,
    memory: {
      candidates: [candidate],
      consideredCandidates: 1,
      gaps: [],
      citationValidations: [
        {
          uri: candidate.uri,
          receipts: EffectArray.map(candidate.codeCitations, (item, index) => ({
            candidateCount: 1,
            citationId: item.id,
            coverage: 'current-complete' as const,
            kind: item.target.kind,
            observedAt: '2026-10-16T00:00:00.000Z',
            reason:
              statuses[index] === 'exact'
                ? ('exact' as const)
                : statuses[index] === 'changed'
                  ? ('source-changed' as const)
                  : ('validation-error' as const),
            status: statuses[index] ?? 'unknown',
            strategy: 'file-path' as const,
            validatorVersion: 1 as const,
          })),
        },
      ],
      trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    },
    observedAt: '2026-10-16T00:00:00.000Z',
    plan: planContextBrief({
      budgetTokens: 1250,
      mode: 'brief',
      scope: {callerCwd: '/synthetic/repository', kind: 'repository'},
      task: 'Claim',
    }),
  });
}

describe('topic maintenance evidence projection', () => {
  it('coalesces unrelated commits and timestamps when relevant bytes stay equal', () => {
    const baseline = projectTopicMaintenanceObservation(enrolled, [
      evidence(Effect2.pipe('a', EffectString.repeat(64))),
    ]);
    const repeated = projectTopicMaintenanceObservation(enrolled, [
      evidence(Effect2.pipe('a', EffectString.repeat(64))),
    ]);
    expect(repeated.revision).toBe(baseline.revision);
    expect(repeated.outcome).toBe('unchanged');
    expect(repeated.canDraft).toBe(false);
    const revalidated = projectTopicMaintenanceObservation(enrolled, [
      {
        ...evidence(Effect2.pipe('a', EffectString.repeat(64))),
        status: 'relocated',
        observedNodeId: `cgs_${Effect2.pipe('f', EffectString.repeat(40))}`,
      },
    ]);
    expect(revalidated.revision).toBe(baseline.revision);
    expect(revalidated.outcome).toBe('unchanged');
  });

  it('marks changed support for review but never drafts without recovered history or current capture', () => {
    const changed = {...evidence(Effect2.pipe('b', EffectString.repeat(64))), status: 'changed' as const};
    const review = projectTopicMaintenanceObservation(enrolled, [changed]);
    expect(review.outcome).toBe('review-required');
    expect(review.canDraft).toBe(true);
    const lost = projectTopicMaintenanceObservation(enrolled, [{...changed, historicalAvailable: false}]);
    expect(lost.outcome).toBe('unavailable');
    expect(lost.canDraft).toBe(false);
    expect(lost.revision).not.toBe(review.revision);
    const truncated = projectTopicMaintenanceObservation(enrolled, [{...changed, excerptTruncated: true}]);
    expect(truncated.outcome).toBe('unavailable');
    expect(truncated.canDraft).toBe(false);
    const noCurrent = projectTopicMaintenanceObservation(enrolled, [
      {citationId: citation.id, status: 'unknown', reason: 'graph-stale', historicalAvailable: true},
    ]);
    expect(noCurrent.outcome).toBe('unavailable');
    expect(noCurrent.canDraft).toBe(false);
    const {id: _id, ...input} = citation;
    const unretained = createMemoryCodeCitation({...input, evidenceRetention: 'unavailable'});
    expect(() => projectTopicMaintenanceObservation(enrolled, [{...changed, current: unretained}])).toThrow(
      /retention/,
    );
  });

  it('changes revision only for relevant content, support state or target content', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64}), digits => {
        const hash = EffectArray.join(digits, '');
        const first = projectTopicMaintenanceObservation(enrolled, [evidence(hash)]);
        const second = projectTopicMaintenanceObservation(enrolled, [evidence(hash)]);
        expect(first.revision).toBe(second.revision);
        if (hash !== Effect2.pipe('a', EffectString.repeat(64)))
          expect(first.revision).not.toBe(
            projectTopicMaintenanceObservation(enrolled, [evidence(Effect2.pipe('a', EffectString.repeat(64)))])
              .revision,
          );
      }),
      {numRuns: 40},
    );
  });

  it('compares against accepted evidence while preserving original claim support', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64}), digits => {
        const hash = EffectArray.join(digits, '');
        const accepted = acceptComparison(enrolled, currentWithHash(citation, hash));
        expect(accepted.metadata.topicMaintenanceError).toBeUndefined();
        const baseline = projectTopicMaintenanceObservation(accepted, [evidence(hash)]);
        expect(baseline.outcome).toBe('unchanged');
        expect(accepted.metadata.topicMaintenance!.paragraphs).toEqual(enrolled.metadata.topicMaintenance!.paragraphs);
        expect(accepted.metadata.codeCitations).toContainEqual(citation);
        const laterHash =
          hash === Effect2.pipe('f', EffectString.repeat(64))
            ? Effect2.pipe('e', EffectString.repeat(64))
            : Effect2.pipe('f', EffectString.repeat(64));
        const later = projectTopicMaintenanceObservation(accepted, [evidence(laterHash)]);
        expect(later.outcome).toBe('review-required');
        expect(later.revision).not.toBe(baseline.revision);
      }),
      {numRuns: 30},
    );
  });

  it('orders declared sources independently of receipt arrival order', () => {
    const {id: _id, ...secondInput} = citation;
    const second = createMemoryCodeCitation({
      ...secondInput,
      path: 'src/other.ts',
      fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('c', EffectString.repeat(64))},
    });
    const withTwo = parseMemoryDocument(
      uri,
      formatMemoryDocument('MEMORY', {...source.metadata, codeCitations: [citation, second]}, 'Claim.'),
    )!;
    const dual = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(withTwo, {
        paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id, second.id]}],
      }).content,
    )!;
    const firstSource = evidence(Effect2.pipe('a', EffectString.repeat(64)));
    const secondSource = {
      ...evidence(Effect2.pipe('c', EffectString.repeat(64))),
      citationId: second.id,
      current: second,
    };
    expect(projectTopicMaintenanceObservation(dual, [firstSource, secondSource]).revision).toBe(
      projectTopicMaintenanceObservation(dual, [secondSource, firstSource]).revision,
    );
  });

  it('includes additional declared dependencies in coverage without inferring undeclared code', () => {
    const {id: _id, ...secondInput} = citation;
    const dependency = createMemoryCodeCitation({
      ...secondInput,
      path: 'src/config.ts',
      fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('d', EffectString.repeat(64))},
    });
    const withDependency = parseMemoryDocument(
      uri,
      formatMemoryDocument('MEMORY', {...source.metadata, codeCitations: [citation, dependency]}, 'Claim.'),
    )!;
    const declared = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(withDependency, {
        paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id]}],
        additionalDependencies: [{kind: 'configuration', citationId: dependency.id}],
      }).content,
    )!;
    const dependencyEvidence = {
      ...evidence(Effect2.pipe('d', EffectString.repeat(64))),
      citationId: dependency.id,
      current: dependency,
    };
    expect(() =>
      projectTopicMaintenanceObservation(declared, [evidence(Effect2.pipe('a', EffectString.repeat(64)))]),
    ).toThrow(/every declared/);
    const baseline = projectTopicMaintenanceObservation(declared, [
      evidence(Effect2.pipe('a', EffectString.repeat(64))),
      dependencyEvidence,
    ]);
    expect(EffectArray.map(baseline.sources, item => item.citationId)).toContain(dependency.id);
    expect(
      projectTopicMaintenanceObservation(declared, [
        evidence(Effect2.pipe('a', EffectString.repeat(64))),
        {
          ...dependencyEvidence,
          current: currentWithHash(dependency, Effect2.pipe('e', EffectString.repeat(64))),
          currentFileBytesHash: Effect2.pipe('e', EffectString.repeat(64)),
        },
      ]).revision,
    ).not.toBe(baseline.revision);
  });

  it('rejects aggregate packet overflow without silently trimming the accepted body', () => {
    const base = {
      version: 1 as const,
      outcome: 'ready' as const,
      targetUri: uri,
      targetHash: Effect2.pipe('a', EffectString.repeat(64)),
      observationRevision: Effect2.pipe('b', EffectString.repeat(64)),
      coverage: 'declared-only' as const,
      body: Effect2.pipe('x', EffectString.repeat(31 * 1024)),
      paragraphs: [
        {
          ordinal: 0,
          hash: Effect2.pipe('c', EffectString.repeat(64)),
          role: 'descriptive' as const,
          support: 'direct' as const,
          citationIds: [citation.id],
        },
      ],
      sources: [],
    };
    expect(boundTopicMaintenanceEvidencePacket(base).outcome).toBe('ready');
    const oversized = boundTopicMaintenanceEvidencePacket({
      ...base,
      paragraphs: Array.from({length: 64}, (_, ordinal) => ({
        ...base.paragraphs[0],
        ordinal,
        scope: Effect2.pipe('s', EffectString.repeat(512)),
      })),
    });
    expect(oversized.outcome).toBe('unavailable');
    expect(oversized.reason).toBe('packet-overflow');
    expect(oversized.body).toBeUndefined();
  });

  it('coalesces unrelated file edits around a symbol, but detects a changed symbol fragment', () => {
    const {id: _id, ...input} = citation;
    const symbol = createMemoryCodeCitation({
      ...input,
      target: {
        fragmentCanonicalization: 'utf8-source-span-v1',
        fragmentHash: {algorithm: 'sha256', value: Effect2.pipe('f', EffectString.repeat(64))},
        kind: 'symbol',
        language: 'typescript',
        name: 'value',
        qualifiedName: 'value',
        nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
        span: {line: 1, column: 1, endLine: 1, endColumn: 20},
        symbolKind: 'variable',
      },
    });
    const symbolSource = parseMemoryDocument(
      uri,
      formatMemoryDocument('MEMORY', {...source.metadata, codeCitations: [symbol]}, 'Claim.'),
    )!;
    const symbolRecord = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(symbolSource, {
        paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [symbol.id]}],
      }).content,
    )!;
    const sourceEvidence = {
      citationId: symbol.id,
      status: 'exact' as const,
      reason: 'exact',
      historicalAvailable: true,
      current: symbol,
      currentFileBytesHash: Effect2.pipe('1', EffectString.repeat(64)),
      observedPath: symbol.path,
      observedNodeId: symbol.target.kind === 'symbol' ? symbol.target.nodeId : undefined,
    };
    const baseline = projectTopicMaintenanceObservation(symbolRecord, [sourceEvidence]);
    if (symbol.target.kind !== 'symbol') throw new Error('Expected a symbol citation.');
    const {id: _currentId, ...currentInput} = symbol;
    const moved = createMemoryCodeCitation({
      ...currentInput,
      fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('b', EffectString.repeat(64))},
      target: {...symbol.target, nodeId: `cgs_${Effect2.pipe('b', EffectString.repeat(32))}`},
    });
    const unrelated = projectTopicMaintenanceObservation(symbolRecord, [
      {
        ...sourceEvidence,
        status: 'relocated',
        current: moved,
        currentFileBytesHash: Effect2.pipe('2', EffectString.repeat(64)),
        observedNodeId: moved.target.kind === 'symbol' ? moved.target.nodeId : undefined,
      },
    ]);
    expect(unrelated.outcome).toBe('unchanged');
    expect(unrelated.revision).toBe(baseline.revision);
    const edited = createMemoryCodeCitation({
      ...currentInput,
      target: {
        ...symbol.target,
        fragmentHash: {algorithm: 'sha256', value: Effect2.pipe('e', EffectString.repeat(64))},
      },
    });
    const changed = projectTopicMaintenanceObservation(symbolRecord, [
      {
        ...sourceEvidence,
        status: 'changed',
        current: edited,
      },
    ]);
    expect(changed.outcome).toBe('review-required');
    expect(changed.revision).not.toBe(baseline.revision);
  });
});

describe('topic maintenance current evidence', () => {
  effectIt.layer(
    Layer.merge(
      citationPlatformLayer,
      Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
    ),
  )(it => {
    it.effect('keeps a committed file unchanged across unrelated commits and reviews changed file bytes', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-topic-evidence-'});
            const repo = path.join(root, 'repo');
            const home = path.join(root, 'home');
            yield* fs.makeDirectory(repo);
            yield* fs.makeDirectory(home);
            const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
            yield* git(['init', '--quiet']);
            yield* git(['config', 'user.name', 'Test']);
            yield* git(['config', 'user.email', 'test@example.invalid']);
            yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const value = 1;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'first']);
            let identity = yield* resolveRepositoryIdentity(repo);
            yield* recordVerifiedCodeGraphLocalAssociation(home, identity);
            const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
            const symbolId = `cgs_${Effect2.pipe('d', EffectString.repeat(40))}`;
            const declaration = 'export const stable = 1;';
            let symbolContent: string | undefined;
            let status: CodeGraphStatus = {
              databasePath: layout.databasePath,
              freshness: 'current',
              identity,
              languagePacks: [],
              stale: false,
              readySnapshot: {
                commit: identity.headCommit,
                dirty: false,
                edgeCount: 0,
                extractorSet: 'test',
                fileCount: 1,
                id: `cgsn_${identity.headCommit}`,
                repositoryId: identity.repositoryId,
                state: 'ready',
                symbolCount: 0,
                worktreeId: identity.worktreeId,
              },
            };
            let statusReads = 0;
            let evidenceReads = 0;
            const tracer = Tracer.make({
              span(options) {
                if (options.name === 'contextHealth.readCitationEvidence') evidenceReads++;
                return new Tracer.NativeSpan(options);
              },
            });
            const queryLayer = Layer.mock(CodeGraphQueryService, {
              withStatusSession: undefined,
              status: () =>
                Effect.sync(() => {
                  statusReads++;
                  return status;
                }),
              statusForPublishedIdentity: () => Effect.succeed(status),
            });
            const storeLayer = Layer.mock(CodeGraphStore, {
              acquireSnapshotLease: () => Effect.succeed('lease'),
              releaseSnapshotLease: () => Effect.void,
              readySnapshotById: () => Effect.as(Effect.void, undefined),
              readySnapshotForCommit: () => Effect.as(Effect.void, undefined),
              effectiveSnapshotCitationEvidence: () =>
                Effect.gen(function* () {
                  const bytes = yield* fs
                    .readFile(path.join(repo, 'source.ts'))
                    .pipe(
                      Effect.mapError(() => CodeGraphStoreError.of('Citation test fixture source could not be read.')),
                    );
                  const symbolBytes = symbolContent === undefined ? undefined : new TextEncoder().encode(symbolContent);
                  const symbolHash = symbolBytes === undefined ? undefined : sha256HexSync(symbolBytes);
                  const symbol =
                    symbolHash === undefined
                      ? undefined
                      : {
                          contentHash: symbolHash,
                          exported: true,
                          id: symbolId,
                          kind: 'variable' as const,
                          language: 'typescript',
                          name: 'stable',
                          path: 'symbol.ts',
                          qualifiedName: 'stable',
                          span: {line: 1, column: 1, endLine: 2, endColumn: 1},
                        };
                  return {
                    fileInventoryCoverage: 'complete',
                    filesByContentHashes: [],
                    filesByPaths: [
                      {
                        path: 'source.ts',
                        file: {
                          blobId: '',
                          contentHash: sha256HexSync(bytes),
                          language: 'typescript',
                          mode: '100644',
                          path: 'source.ts',
                          size: bytes.byteLength,
                          source: 'commit',
                        },
                      },
                      ...(symbolBytes === undefined || symbolHash === undefined
                        ? []
                        : [
                            {
                              path: 'symbol.ts',
                              file: {
                                blobId: '',
                                contentHash: symbolHash,
                                language: 'typescript',
                                mode: '100644',
                                path: 'symbol.ts',
                                size: symbolBytes.byteLength,
                                source: 'commit' as const,
                              },
                            },
                          ]),
                    ],
                    symbolsByIds: symbol === undefined ? [] : [symbol],
                    symbolsBySemanticLocators: [],
                  };
                }),
            });
            const serviceContext = yield* Layer.build(Layer.mergeAll(queryLayer, storeLayer));
            const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.provideContext(effect, serviceContext).pipe(Effect.withTracer(tracer));
            const config = runtimeConfigForTest({
              agentContextHome: home,
              manifestPath: path.join(home, 'threadnote.toml'),
              manifestSource: 'bundled-example',
            });
            const [captured] = yield* provide(
              captureMemoryCodeCitations(config, {callerCwd: repo, refs: ['source.ts']}),
            );
            expect(captured?.evidenceRetention).toBe('capsule-retained');
            const memory = parseMemoryDocument(
              uri,
              formatMemoryDocument(
                'MEMORY',
                {
                  ...source.metadata,
                  codeCitations: [captured],
                },
                'The value comes from source.ts.',
              ),
            )!;
            const enrolledRecord = parseMemoryDocument(
              uri,
              proposeTopicMaintenanceEnrollment(memory, {
                paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [captured.id]}],
              }).content,
            )!;
            const observe = (
              previous?: ReturnType<typeof projectTopicMaintenanceObservation>,
              options?: {readonly allowCapture?: boolean},
            ) => provide(observeTopicMaintenanceEvidence(config, enrolledRecord, repo, previous, options));
            const initial = yield* observe();
            expect(initial.outcome).toBe('unchanged');
            expect(initial.sources[0]?.historicalAvailable).toBe(true);
            statusReads = evidenceReads = 0;
            const unchangedPacket = yield* provide(
              buildTopicMaintenanceEvidencePacket(config, enrolledRecord, repo, initial),
            );
            expect(unchangedPacket.outcome).toBe('ready');
            expect(unchangedPacket.sources?.[0]?.oldExcerpt.provenance).toBe('historical-verified');
            expect(unchangedPacket.sources?.[0]?.newExcerpt.provenance).toBe('current-verified');
            expect(evidenceReads).toBe(1);
            expect(statusReads).toBe(2);
            const readOnlyInitial = yield* observe(initial, {allowCapture: false});
            expect(readOnlyInitial.revision).toBe(initial.revision);
            expect((yield* observe(undefined, {allowCapture: false})).outcome).toBe('unavailable');
            const updateStatus = () =>
              Effect.gen(function* () {
                identity = yield* resolveRepositoryIdentity(repo);
                status = {
                  ...status,
                  identity,
                  readySnapshot: {
                    ...status.readySnapshot!,
                    commit: identity.headCommit,
                    id: `cgsn_${identity.headCommit}`,
                  },
                };
              });
            yield* fs.writeFileString(path.join(repo, 'unrelated.ts'), 'export const other = 2;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'unrelated']);
            yield* updateStatus();
            const unrelated = yield* observe(initial);
            expect(unrelated.outcome).toBe('unchanged');
            expect(unrelated.revision).toBe(initial.revision);
            expect((yield* observe(initial, {allowCapture: false})).revision).toBe(initial.revision);
            status = {
              ...status,
              readySnapshot: {
                ...status.readySnapshot!,
                extractorSet: 'test-v2',
                id: `cgsn_${Effect2.pipe(sha256HexSync('new extractor set'), EffectString.slice(0, 40))}`,
              },
            };
            const changedExtractorReadOnly = yield* observe(unrelated, {allowCapture: false});
            expect(changedExtractorReadOnly.outcome).toBe('unavailable');
            const reextracted = yield* observe(unrelated);
            expect(reextracted.outcome).toBe('unchanged');
            expect(reextracted.revision).toBe(initial.revision);
            expect(reextracted.sources[0]?.current?.extractorSet).toBe('test-v2');
            expect(reextracted.sources[0]?.current?.id).not.toBe(captured.id);
            expect(reextracted.sources[0]?.historicalAvailable).toBe(true);
            expect((yield* observe(reextracted, {allowCapture: false})).sources[0]?.current?.id).toBe(
              reextracted.sources[0]?.current?.id,
            );
            yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const value = 2;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'changed']);
            yield* updateStatus();
            const changedReadOnly = yield* observe(unrelated, {allowCapture: false});
            expect(changedReadOnly.outcome).toBe('unavailable');
            expect(changedReadOnly.sources[0]?.current).toBeUndefined();
            const changed = yield* observe(unrelated);
            expect(changed.outcome).toBe('review-required');
            expect(changed.revision).not.toBe(initial.revision);
            expect(changed.sources[0]?.historicalAvailable).toBe(true);
            statusReads = evidenceReads = 0;
            const changedPacket = yield* provide(
              buildTopicMaintenanceEvidencePacket(config, enrolledRecord, repo, changed),
            );
            expect(changedPacket.outcome).toBe('ready');
            expect(changedPacket.sources?.[0]?.oldExcerpt).toMatchObject({
              provenance: 'historical-verified',
              supportsCitation: true,
              fileBytesHash: sha256HexSync('export const value = 1;\n'),
            });
            expect(changedPacket.sources?.[0]?.newExcerpt).toMatchObject({
              provenance: 'current-verified',
              supportsCitation: true,
              fileBytesHash: sha256HexSync('export const value = 2;\n'),
            });
            expect(evidenceReads).toBe(2);
            expect(statusReads).toBe(2);
            const mismatchedHash = projectTopicMaintenanceObservation(
              enrolledRecord,
              EffectArray.map(changed.sources, item => ({
                ...item,
                currentFileBytesHash: Effect2.pipe('f', EffectString.repeat(64)),
              })),
            );
            expect(
              (yield* provide(buildTopicMaintenanceEvidencePacket(config, enrolledRecord, repo, mismatchedHash)))
                .outcome,
            ).toBe('unavailable');
            const changedCitation = changed.sources[0]?.current;
            if (changedCitation === undefined)
              throw new Error('Changed citation fixture is missing its current citation.');
            const acceptedRecord = acceptComparison(enrolledRecord, changedCitation);
            expect(acceptedRecord.metadata.topicMaintenanceError).toBeUndefined();
            const acceptedInitial = yield* provide(observeTopicMaintenanceEvidence(config, acceptedRecord, repo));
            expect(acceptedInitial.outcome).toBe('unchanged');
            expect(acceptedInitial.sources[0]?.historicalAvailable).toBe(true);
            const acceptedRestart = yield* provide(observeTopicMaintenanceEvidence(config, acceptedRecord, repo));
            expect(acceptedRestart.revision).toBe(acceptedInitial.revision);
            const acceptedReadOnly = yield* provide(
              observeTopicMaintenanceEvidence(config, acceptedRecord, repo, undefined, {allowCapture: false}),
            );
            expect(acceptedReadOnly.outcome).toBe('unchanged');
            expect(acceptedReadOnly.sources[0]?.current?.id).toBe(changed.sources[0]?.current?.id);
            yield* fs.writeFileString(path.join(repo, 'unrelated.ts'), 'export const other = 3;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'unrelated after acceptance']);
            yield* updateStatus();
            const acceptedUnrelated = yield* provide(
              observeTopicMaintenanceEvidence(config, acceptedRecord, repo, acceptedInitial, {allowCapture: false}),
            );
            expect(acceptedUnrelated.revision).toBe(acceptedInitial.revision);
            const acceptedPacket = yield* provide(
              buildTopicMaintenanceEvidencePacket(config, acceptedRecord, repo, acceptedUnrelated),
            );
            expect(acceptedPacket.sources?.[0]?.oldExcerpt?.content).toContain('value = 1');
            expect(acceptedPacket.sources?.[0]?.newExcerpt?.content).toContain('value = 2');
            yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const value = 3;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'new material evidence after acceptance']);
            yield* updateStatus();
            const acceptedLater = yield* provide(
              observeTopicMaintenanceEvidence(config, acceptedRecord, repo, acceptedUnrelated),
            );
            expect(acceptedLater.outcome).toBe('review-required');
            expect(acceptedLater.revision).not.toBe(acceptedInitial.revision);
            expect(acceptedLater.sources[0]?.historicalAvailable).toBe(true);
            yield* fs.writeFileString(
              path.join(repo, 'source.ts'),
              EffectArray.join(
                [...Array.from({length: 10}, (_, index) => `// context ${index}`), 'export const value = 3;', ''],
                '\n',
              ),
            );
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'changed lower line']);
            yield* updateStatus();
            const lowerLine = yield* observe(changed);
            expect(lowerLine.sources[0]?.excerptTruncated).toBe(true);
            expect(lowerLine.outcome).toBe('unavailable');
            expect(lowerLine.canDraft).toBe(false);
            const packet = yield* provide(buildTopicMaintenanceEvidencePacket(config, enrolledRecord, repo, lowerLine));
            expect(packet).toMatchObject({outcome: 'unavailable', reason: 'excerpt-truncated', truncatedExcerpts: 1});

            symbolContent = EffectArray.join(
              [declaration, ...Array.from({length: 12}, (_, index) => `// sibling ${index}`), ''],
              '\n',
            );
            yield* fs.writeFileString(path.join(repo, 'symbol.ts'), symbolContent);
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'symbol']);
            yield* updateStatus();
            const [symbolCitation] = yield* provide(
              captureMemoryCodeCitations(config, {callerCwd: repo, refs: [symbolId]}),
            );
            expect(symbolCitation?.target.kind).toBe('symbol');
            const symbolMemory = parseMemoryDocument(
              uri,
              formatMemoryDocument(
                'MEMORY',
                {...source.metadata, codeCitations: [symbolCitation]},
                'The stable value comes from symbol.ts.',
              ),
            )!;
            const symbolRecord = parseMemoryDocument(
              uri,
              proposeTopicMaintenanceEnrollment(symbolMemory, {
                paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [symbolCitation.id]}],
                additionalDependencies: [{kind: 'configuration', citationId: symbolCitation.id}],
              }).content,
            )!;
            const symbolInitial = yield* provide(observeTopicMaintenanceEvidence(config, symbolRecord, repo));
            expect(symbolInitial.outcome).toBe('unchanged');
            expect(symbolInitial.sources[0]?.excerptTruncated).toBe(false);
            symbolContent = Effect2.pipe(symbolContent, EffectString.replace('// sibling 10', '// sibling edited'));
            yield* fs.writeFileString(path.join(repo, 'symbol.ts'), symbolContent);
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'sibling edit']);
            yield* updateStatus();
            const symbolSibling = yield* provide(
              observeTopicMaintenanceEvidence(config, symbolRecord, repo, symbolInitial),
            );
            expect(symbolSibling.outcome).toBe('unchanged');
            expect(symbolSibling.revision).toBe(symbolInitial.revision);
            expect(symbolSibling.sources[0]?.current?.id).not.toBe(symbolCitation.id);
            expect(symbolSibling.sources[0]?.excerptTruncated).toBe(false);
            symbolContent = Effect2.pipe(symbolContent, EffectString.replace('stable = 1', 'stable = 2'));
            yield* fs.writeFileString(path.join(repo, 'symbol.ts'), symbolContent);
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'symbol edit']);
            yield* updateStatus();
            const symbolChanged = yield* provide(
              observeTopicMaintenanceEvidence(config, symbolRecord, repo, symbolSibling),
            );
            expect(symbolChanged.outcome).toBe('review-required');
            expect(symbolChanged.sources[0]?.excerptTruncated).toBe(false);
            const symbolPacket = yield* provide(
              buildTopicMaintenanceEvidencePacket(config, symbolRecord, repo, symbolChanged),
            );
            expect(symbolPacket.outcome).toBe('ready');
            expect(symbolPacket.additionalDependencies).toEqual([
              {kind: 'configuration', citationId: symbolCitation.id},
            ]);
            expect(symbolPacket.sources?.[0]?.oldExcerpt).toMatchObject({endLine: 1, truncated: false});
            expect(symbolPacket.sources?.[0]?.newExcerpt).toMatchObject({endLine: 1, truncated: false});
          }),
        ),
      ),
    );
  });
});
