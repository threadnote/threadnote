import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  deduplicateLogicalRecallCandidates,
  rankRecallCandidates,
  recallMemoryContentHash,
  type RecallCandidate,
  type RankedRecallCandidate,
} from '@threadnote/recall/rank';
import {mergeRecallHits, RECALL_CATEGORY_ORDER, type RecallCategory, type RecallHit} from '@threadnote/recall/results';

import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const FIXED_NOW = new Date('2026-07-30T00:00:00.000Z');
const MEMORY_KINDS = ['durable', 'handoff', 'incident', 'preference', 'smoke'] as const;
const URI_LABELS = [
  '!bang',
  '-dash',
  '0digit',
  'A-upper',
  '_under',
  'a-lower',
  'é-accent',
  'Ω-greek',
  '中-cjk',
  '😀-emoji',
] as const;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generatedUri(id: number, label = 'generated'): string {
  return `threadnote://user/test/memories/${label}-${Effect.pipe(String(id), EffectString.padStart(3, '0'))}.md`;
}

function expectBoundedRankedCandidate(result: RankedRecallCandidate): void {
  expect(Number.isFinite(result.finalScore)).toBe(true);
  expect(result.finalScore).toBeGreaterThanOrEqual(0);
  expect(result.finalScore).toBeLessThanOrEqual(1);
  expect(Number.isFinite(result.relevanceScore)).toBe(true);
  expect(result.relevanceScore).toBeGreaterThanOrEqual(0);
  expect(result.relevanceScore).toBeLessThanOrEqual(1);

  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  for (const [signal, value] of Object.entries(result.signals)) {
    expect(Number.isFinite(value), `${signal} should be finite`).toBe(true);
    expect(value, `${signal} should be at most 1`).toBeLessThanOrEqual(1);
    expect(value, `${signal} should be non-negative except for feedback`).toBeGreaterThanOrEqual(
      signal === 'feedback' ? -1 : 0,
    );
  }
  for (const reason of result.reasons) {
    expect(Number.isFinite(reason.contribution)).toBe(true);
  }
}

const recallCandidatesArbitrary = FC.uniqueArray(
  FC.record({
    feedbackPercent: FC.integer({max: 200, min: -200}),
    id: FC.integer({max: 999, min: 0}),
    kindIndex: FC.integer({max: MEMORY_KINDS.length - 1, min: 0}),
    rerankerPercent: FC.integer({max: 150, min: -50}),
    semanticPercent: FC.integer({max: 150, min: -50}),
    uriLabel: FC.constantFrom(...URI_LABELS),
  }),
  {
    maxLength: 24,
    minLength: 0,
    selector: value => value.id,
  },
).map(specs =>
  EffectArray.map(specs, (spec): RecallCandidate => ({
    authority: 'agent_generated',
    feedback: spec.feedbackPercent / 100,
    fields: {
      project: 'threadnote',
      title: 'Alpha retry policy',
      topic: 'alpha-retry-policy',
    },
    kind: MEMORY_KINDS[spec.kindIndex],
    reranker: spec.rerankerPercent / 100,
    semantic: spec.semanticPercent / 100,
    status: 'active',
    text: 'Alpha retry policy uses bounded retries.',
    timestamp: '2026-07-29T00:00:00.000Z',
    trust: 'inferred',
    uri: generatedUri(spec.id, spec.uriLabel),
  })),
);

const recallRankingCaseArbitrary = recallCandidatesArbitrary.chain(candidates =>
  FC.shuffledSubarray(candidates, {maxLength: candidates.length, minLength: candidates.length}).map(permutation => ({
    candidates,
    permutation,
  })),
);

interface RecallDocumentSpec {
  readonly category: RecallCategory;
  readonly contextType: string;
  readonly id: number;
  readonly passOffset: number;
  readonly scores: readonly number[];
  readonly uriLabel: string;
}

const recallDocumentsArbitrary: FC.Arbitrary<readonly RecallDocumentSpec[]> = FC.uniqueArray(
  FC.record({
    category: FC.constantFrom(...RECALL_CATEGORY_ORDER),
    contextType: FC.constantFrom('memory', 'resource', 'skill'),
    id: FC.integer({max: 999, min: 0}),
    passOffset: FC.integer({max: 2, min: 0}),
    scores: FC.array(FC.integer({max: 10, min: 0}), {maxLength: 4, minLength: 1}),
    uriLabel: FC.constantFrom(...URI_LABELS),
  }),
  {
    maxLength: 24,
    minLength: 0,
    selector: value => value.id,
  },
);

function recallDocumentHits(document: RecallDocumentSpec): readonly RecallHit[] {
  const uri = `threadnote://${document.category}/${document.uriLabel}-${Effect.pipe(String(document.id), EffectString.padStart(3, '0'))}.md`;
  return EffectArray.map(document.scores, (score, index) => ({
    category: document.category,
    contextType: `${document.contextType}-chunk-${index}`,
    score: score / 10,
    snippet: `generated document ${document.id}, chunk ${index}`,
    uri: `${uri}#chunk_${Effect.pipe(String(index), EffectString.padStart(4, '0'))}`,
  }));
}

function recallPasses(documents: readonly RecallDocumentSpec[]): readonly (readonly RecallHit[])[] {
  const passes: RecallHit[][] = [[], [], []];
  for (const document of documents) {
    EffectArray.forEach(recallDocumentHits(document), (hit, index) => {
      passes[(document.passOffset + index) % passes.length].push(hit);
    });
  }
  return passes;
}

function mergeOracle(documents: readonly RecallDocumentSpec[]): readonly RecallHit[] {
  return EffectArray.map(documents, (document): RecallHit => {
    const winner = [...recallDocumentHits(document)].sort(
      (left, right) => right.score - left.score || compareCodeUnits(left.uri, right.uri),
    )[0];
    return {...winner, uri: Effect.pipe(winner.uri, EffectString.replace(/#.*$/, ''))};
  }).sort(
    (left, right) =>
      RECALL_CATEGORY_ORDER.indexOf(left.category) - RECALL_CATEGORY_ORDER.indexOf(right.category) ||
      right.score - left.score ||
      compareCodeUnits(left.uri, right.uri),
  );
}

const recallMergeCaseArbitrary = recallDocumentsArbitrary.chain(documents => {
  const passes = recallPasses(documents);
  const hits = passes.flat();
  return FC.shuffledSubarray(hits, {maxLength: hits.length, minLength: hits.length}).map(permutation => ({
    documents,
    passes,
    permutation,
  }));
});

const MEMORY_AUTHORITIES = [
  'agent_generated',
  'canonical_repo',
  'external',
  'reviewed_shared',
  'user_approved',
] as const;
const TRUSTED_LEVELS = ['approved', 'inferred'] as const;

const trustDemotionCaseArbitrary = FC.record({
  authority: FC.constantFrom(...MEMORY_AUTHORITIES),
  feedbackPercent: FC.integer({max: 100, min: -100}),
  kindIndex: FC.integer({max: MEMORY_KINDS.length - 1, min: 0}),
  query: FC.constantFrom('code graph snapshot lease', 'alpha retry policy', 'worker lease renewal'),
  rerankerPercent: FC.integer({max: 100, min: 0}),
  semanticPercent: FC.integer({max: 100, min: 10}),
  trustedIndex: FC.integer({max: TRUSTED_LEVELS.length - 1, min: 0}),
});

const structuredIdentifierCaseArbitrary = FC.record({
  component: FC.constantFrom('artifact', 'backup', 'cache', 'index', 'release', 'upload', 'worker'),
  connector: FC.constantFrom('-', '‑', '–', '−'),
  suffix: FC.integer({max: 999, min: 100}),
});

const workspaceHierarchyCaseArbitrary = FC.uniqueArray(
  FC.constantFrom('api', 'apps', 'billing', 'core', 'query', 'search', 'services', 'worker'),
  {maxLength: 4, minLength: 4},
).chain(([root, component, leaf, sibling]) => {
  const current = `${root}/${component}/${leaf}`;
  const candidates: RecallCandidate[] = [
    {
      fields: {title: 'Checkout retry contract', topic: 'checkout-retry-contract', workspaceScope: current},
      text: 'Checkout retry contract uses bounded attempts.',
      uri: 'threadnote://exact.md',
    },
    {
      fields: {
        title: 'Checkout retry contract',
        topic: 'checkout-retry-contract',
        workspaceScope: `${root}/${component}`,
      },
      text: 'Checkout retry contract uses bounded attempts.',
      uri: 'threadnote://ancestor.md',
    },
    {
      fields: {title: 'Checkout retry contract', topic: 'checkout-retry-contract'},
      text: 'Checkout retry contract uses bounded attempts.',
      uri: 'threadnote://repo-wide.md',
    },
    {
      fields: {
        title: 'Checkout retry contract',
        topic: 'checkout-retry-contract',
        workspaceScope: `${root}/${sibling}`,
      },
      text: 'Checkout retry contract uses bounded attempts.',
      uri: 'threadnote://sibling.md',
    },
  ];
  return FC.shuffledSubarray(candidates, {maxLength: candidates.length, minLength: candidates.length}).map(
    permutation => ({current, permutation}),
  );
});

describe('recall ranking properties', () => {
  fcProp(
    it,
    'generated hygiene source sets do not change logical memory identity',
    {
      body: FC.string({maxLength: 80}),
      sources: FC.uniqueArray(FC.stringMatching(/^[a-z]{1,8}$/), {maxLength: 12, minLength: 1}),
    },
    ({body: rawBody, sources}) => {
      const body = Effect.pipe(rawBody, EffectString.replace(/\s+$/u, '')) || 'body';
      const decorated = EffectArray.join(
        [
          body,
          '',
          '<!-- threadnote:hygiene-sources:v1 -->',
          '## Threadnote Hygiene Sources',
          '',
          ...EffectArray.map(
            sources,
            source => `- threadnote://user/me/memories/handoffs/archived/threadnote/source-${source}.md`,
          ),
        ],
        '\n',
      );

      expect(recallMemoryContentHash(decorated)).toBe(recallMemoryContentHash(body));
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'keeps workspace hierarchy ordering stable across valid paths and candidate permutations',
    {hierarchyCase: workspaceHierarchyCaseArbitrary},
    ({hierarchyCase}) => {
      const ranked = rankRecallCandidates('checkout retry contract', hierarchyCase.permutation, {
        workspaceScope: hierarchyCase.current,
      });

      expect(EffectArray.map(ranked.results, result => result.candidate.uri)).toEqual([
        'threadnote://exact.md',
        'threadnote://ancestor.md',
        'threadnote://repo-wide.md',
        'threadnote://sibling.md',
      ]);
      expect(EffectArray.map(ranked.results, result => result.signals.workspace)).toEqual([1, 0.75, 0.5, 0.25]);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'keeps explicit-recency ranking monotone in timestamps and stable across candidate permutations',
    {
      newerAgeDays: FC.integer({max: 90, min: 0}),
      olderOffsetDays: FC.integer({max: 90, min: 1}),
    },
    ({newerAgeDays, olderOffsetDays}) => {
      const candidate = (ageDays: number, uri: string): RecallCandidate => ({
        fields: {project: 'threadnote', title: 'Release status', topic: 'release-status'},
        kind: 'handoff',
        semantic: 0.6,
        status: 'active',
        text: 'Release status and verification evidence.',
        timestamp: new Date(FIXED_NOW.getTime() - ageDays * 86_400_000).toISOString(),
        uri,
      });
      const newer = candidate(newerAgeDays, 'threadnote://newer.md');
      const older = candidate(newerAgeDays + olderOffsetDays, 'threadnote://older.md');
      const context = {now: FIXED_NOW, project: 'threadnote'};
      const forward = rankRecallCandidates('latest release status', [older, newer], context);
      const reverse = rankRecallCandidates('latest release status', [newer, older], context);

      expect(forward).toEqual(reverse);
      expect(EffectArray.map(forward.results, result => result.candidate.uri)).toEqual([newer.uri, older.uri]);
      expect(forward.results[0].finalScore).toBeGreaterThan(forward.results[1].finalScore);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'logical-memory alias deduplication is permutation-invariant and idempotent',
    {
      teams: FC.uniqueArray(FC.stringMatching(/^[a-z]{1,8}$/), {maxLength: 12, minLength: 1}),
    },
    ({teams}) => {
      const body = 'A stable package-scoped recall contract.';
      const aliases: RecallCandidate[] = EffectArray.map(teams, (team, index) => ({
        authority: 'reviewed_shared',
        contentHash: recallMemoryContentHash(body),
        fields: {project: 'threadnote', topic: 'package-scope'},
        kind: 'durable',
        memoryId: index % 2 === 0 ? 'tn_package_scope' : undefined,
        status: 'active',
        text: body,
        trust: 'approved',
        uri: `threadnote://user/test/memories/shared/${team}/durable/projects/threadnote/package-scope.md`,
      }));
      const forward = deduplicateLogicalRecallCandidates(aliases);
      const reverse = deduplicateLogicalRecallCandidates([...aliases].reverse());
      const middle = Math.floor(aliases.length / 2);
      const partitioned = deduplicateLogicalRecallCandidates([
        ...deduplicateLogicalRecallCandidates(aliases.slice(0, middle)),
        ...deduplicateLogicalRecallCandidates(aliases.slice(middle)),
      ]);

      expect(reverse).toEqual(forward);
      expect(partitioned).toEqual(forward);
      expect(deduplicateLogicalRecallCandidates(forward)).toEqual(forward);
      expect(forward).toHaveLength(1);
      expect(forward[0]?.memoryId).toBe('tn_package_scope');
      expect([forward[0].uri, ...(forward[0].equivalentUris ?? [])].sort(compareCodeUnits)).toEqual(
        EffectArray.map(aliases, candidate => candidate.uri).sort(compareCodeUnits),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'requires a structured identifier declaration before components contribute exact evidence',
    {identifierCase: structuredIdentifierCaseArbitrary},
    ({identifierCase}) => {
      const identifier = `${Effect.pipe(identifierCase.component, EffectString.toUpperCase)}${identifierCase.connector}TOKEN${identifierCase.connector}${identifierCase.suffix}`;
      const candidate: RecallCandidate = {
        exactTerms: [identifier],
        fields: {
          project: 'threadnote',
          title: `${identifierCase.component} recovery instructions`,
          topic: `${identifierCase.component}-recovery`,
        },
        semantic: 0.6,
        text: `Body-only identifier: ${identifier}.`,
        uri: 'threadnote://resources/external/body-only-identifier.md',
      };
      const query = `how does ${identifierCase.component} recovery work`;
      const bodyOnly = rankRecallCandidates(query, [candidate]).results[0];
      const declared = rankRecallCandidates(query, [
        {...candidate, fields: {...candidate.fields, identifiers: [identifier]}},
      ]).results[0];

      expect(bodyOnly?.signals.exact).toBe(0);
      expect(declared?.signals.exact).toBe(0.9);
    },
    {fastCheck: {numRuns: 75}},
  );

  fcProp(
    it,
    'never lets an untrusted candidate outrank an otherwise identical trusted candidate',
    {demotionCase: trustDemotionCaseArbitrary},
    ({demotionCase}) => {
      const candidate = (trust: RecallCandidate['trust'], uri: string): RecallCandidate => ({
        authority: demotionCase.authority,
        feedback: demotionCase.feedbackPercent / 100,
        fields: {
          project: 'threadnote',
          title: 'Code graph snapshot lease',
          topic: 'code-graph-snapshot-lease',
        },
        kind: MEMORY_KINDS[demotionCase.kindIndex],
        reranker: demotionCase.rerankerPercent / 100,
        semantic: demotionCase.semanticPercent / 100,
        status: 'active',
        text: 'Code graph snapshot lease retirement for alpha retry policy and worker lease renewal.',
        timestamp: '2026-07-29T00:00:00.000Z',
        trust,
        uri,
      });
      const trusted = candidate(TRUSTED_LEVELS[demotionCase.trustedIndex], 'threadnote://a-trusted.md');
      const untrusted = candidate('untrusted', 'threadnote://a-trusted.md');
      const context = {now: FIXED_NOW, project: 'threadnote'};
      const trustedAlone = rankRecallCandidates(demotionCase.query, [trusted], context).results[0];
      const untrustedAlone = rankRecallCandidates(demotionCase.query, [untrusted], context).results[0];

      expect(untrustedAlone?.finalScore ?? 0).toBeLessThanOrEqual(trustedAlone?.finalScore ?? 0);
      expect(untrustedAlone?.finalScore ?? 0).toBeLessThanOrEqual(untrustedAlone?.relevanceScore ?? 0);

      const together = EffectArray.map(
        rankRecallCandidates(demotionCase.query, [{...untrusted, uri: 'threadnote://a-untrusted.md'}, trusted], context)
          .results,
        result => result.candidate.uri,
      );

      expect(together).toEqual(['threadnote://a-trusted.md', 'threadnote://a-untrusted.md']);
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'keeps finite bounded ranking output stable across candidate permutations',
    {rankingCase: recallRankingCaseArbitrary},
    ({rankingCase}) => {
      const {candidates, permutation} = rankingCase;
      const context = {
        includeInactive: true,
        includeTemporallyInvalid: true,
        now: FIXED_NOW,
        project: 'threadnote',
      };
      const ranked = rankRecallCandidates('alpha retry policy', candidates, context);
      const permuted = rankRecallCandidates('alpha retry policy', permutation, context);

      expect(permuted).toEqual(ranked);
      expect(ranked.results.length).toBeLessThanOrEqual(candidates.length);
      expect(new Set(EffectArray.map(ranked.results, result => result.candidate.uri)).size).toBe(ranked.results.length);
      EffectArray.forEach(ranked.results, expectBoundedRankedCandidate);
      expect(Number.isFinite(ranked.confidence.score)).toBe(true);
      expect(ranked.confidence.score).toBeGreaterThanOrEqual(0);
      expect(ranked.confidence.score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(ranked.confidence.margin)).toBe(true);
      expect(ranked.confidence.margin).toBeGreaterThanOrEqual(0);
      expect(ranked.confidence.margin).toBeLessThanOrEqual(1);
    },
    {fastCheck: {numRuns: 125}},
  );

  fcProp(
    it,
    'uses locale-independent URI ordering as the final tie-break for otherwise equal candidates',
    {
      labels: FC.uniqueArray(FC.constantFrom(...URI_LABELS), {
        maxLength: URI_LABELS.length,
        minLength: 2,
      }),
    },
    ({labels}) => {
      const candidates = EffectArray.map(labels, (label, index): RecallCandidate => ({
        fields: {title: 'Alpha retry policy'},
        kind: 'durable',
        reranker: 0.5,
        semantic: 0.75,
        text: 'Alpha retry policy uses bounded retries.',
        uri: generatedUri(index, label),
      }));
      const expected = EffectArray.map(candidates, candidate => candidate.uri).sort(compareCodeUnits);

      expect(
        EffectArray.map(
          rankRecallCandidates('alpha retry policy', [...candidates].reverse(), {
            now: FIXED_NOW,
            project: 'threadnote',
          }).results,
          result => result.candidate.uri,
        ),
      ).toEqual(expected);
    },
    {fastCheck: {numRuns: 75}},
  );

  fcProp(
    it,
    'matches a document-level merge oracle and is idempotent across pass permutations',
    {mergeCase: recallMergeCaseArbitrary},
    ({mergeCase}) => {
      const {documents, passes, permutation} = mergeCase;
      const expected = mergeOracle(documents);
      const merged = mergeRecallHits(passes);

      expect(merged).toEqual(expected);
      expect(mergeRecallHits([permutation])).toEqual(expected);
      expect(mergeRecallHits([merged])).toEqual(merged);
      expect(new Set(EffectArray.map(merged, hit => hit.uri)).size).toBe(merged.length);
      expect(EffectArray.every(merged, hit => !Effect.pipe(hit.uri, EffectString.includes('#')))).toBe(true);
      expect(EffectArray.every(merged, hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1)).toBe(
        true,
      );
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'orders equal-score merged documents by locale-independent URI across input permutations',
    {
      category: FC.constantFrom(...RECALL_CATEGORY_ORDER),
      labels: FC.uniqueArray(FC.constantFrom(...URI_LABELS), {
        maxLength: URI_LABELS.length,
        minLength: 2,
      }),
      score: FC.integer({max: 10, min: 0}),
    },
    ({category, labels, score}) => {
      const hits = EffectArray.map(labels, (label): RecallHit => ({
        category,
        contextType: 'generated',
        score: score / 10,
        snippet: `generated document ${label}`,
        uri: `threadnote://${category}/${label}.md`,
      }));
      const expectedUris = EffectArray.map(hits, hit => hit.uri).sort(compareCodeUnits);

      expect(EffectArray.map(mergeRecallHits([hits]), hit => hit.uri)).toEqual(expectedUris);
      expect(EffectArray.map(mergeRecallHits([[...hits].reverse()]), hit => hit.uri)).toEqual(expectedUris);
    },
    {fastCheck: {numRuns: 75}},
  );

  fcProp(
    it,
    'chooses a deterministic payload for equal-score chunks of one document',
    {
      category: FC.constantFrom(...RECALL_CATEGORY_ORDER),
      labels: FC.uniqueArray(FC.constantFrom(...URI_LABELS), {
        maxLength: URI_LABELS.length,
        minLength: 2,
      }),
      score: FC.integer({max: 10, min: 0}),
    },
    ({category, labels, score}) => {
      const documentUri = `threadnote://${category}/same-document.md`;
      const hits = EffectArray.map(labels, (label): RecallHit => ({
        category,
        contextType: `context-${label}`,
        score: score / 10,
        snippet: `distinct payload ${label}`,
        uri: `${documentUri}#${label}`,
      }));
      const expectedSource = [...hits].sort((left, right) => compareCodeUnits(left.uri, right.uri))[0];
      const expected = {...expectedSource, uri: documentUri};

      expect(mergeRecallHits([hits])).toEqual([expected]);
      expect(mergeRecallHits([[...hits].reverse()])).toEqual([expected]);
    },
    {fastCheck: {numRuns: 75}},
  );
});
