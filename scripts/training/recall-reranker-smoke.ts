import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {
  createRecallRerankerDatasetV1,
  RECALL_RERANKER_DATASET_VERSION,
  type RecallRerankerCandidateV1,
  type RecallRerankerDatasetV1,
  type RecallRerankerQueryGroupV1,
  type RecallRerankerSplit,
} from './recall-reranker-contract.js';

const SMOKE_CREATED_AT = '2026-08-03T00:00:00.000Z';
const SMOKE_SEED = 0x4_01_00;
const SOURCE_ID = 'threadnote-owned-reranker-smoke-v1';

interface SmokeScenario {
  readonly answer: string;
  readonly project: string;
  readonly query: string;
  readonly slug: string;
  readonly split: RecallRerankerSplit;
  readonly subject: string;
}

const SCENARIOS: readonly SmokeScenario[] = [
  {
    answer: 'The Aurora scheduler preserves the oldest enqueue timestamp when a delayed task is retried.',
    project: 'aurora-scheduler',
    query: 'How does Aurora keep retry order stable for delayed jobs?',
    slug: 'retry-order',
    split: 'train',
    subject: 'delayed job retry ordering',
  },
  {
    answer: 'Copper deploys a canary to one zone and pauses promotion when its error budget is exhausted.',
    project: 'copper-release',
    query: 'When does Copper stop a canary from reaching every zone?',
    slug: 'canary-budget',
    split: 'train',
    subject: 'canary error-budget promotion',
  },
  {
    answer: 'Delta cache entries are promoted only after the payload and metadata checksums both match.',
    project: 'delta-cache',
    query: 'What must Delta verify before a cache entry becomes readable?',
    slug: 'dual-checksum',
    split: 'train',
    subject: 'cache entry promotion checks',
  },
  {
    answer: 'Elm telemetry samples routine success events but always retains failures and trace boundary events.',
    project: 'elm-telemetry',
    query: 'Which Elm telemetry events bypass ordinary sampling?',
    slug: 'sampling-exceptions',
    split: 'train',
    subject: 'telemetry sampling exceptions',
  },
  {
    answer: 'Flint rotates signing keys by publishing the new verifier set before any producer uses the new key.',
    project: 'flint-identity',
    query: 'How does Flint prevent verification gaps during signing-key rotation?',
    slug: 'key-rotation',
    split: 'train',
    subject: 'signing-key rotation order',
  },
  {
    answer:
      'Harbor compaction copies live segments, verifies their record counts, and swaps the segment map atomically.',
    project: 'harbor-storage',
    query: 'How does Harbor compact storage without exposing a partial segment map?',
    slug: 'segment-compaction',
    split: 'validation',
    subject: 'storage segment compaction',
  },
  {
    answer: 'Iris invalidates a session only after the revocation event is durably appended to its audit stream.',
    project: 'iris-session',
    query: 'What durable step precedes Iris session invalidation?',
    slug: 'session-revocation',
    split: 'validation',
    subject: 'durable session revocation',
  },
  {
    answer: 'Juniper retries a webhook with the same delivery identifier and a bounded exponential delay.',
    project: 'juniper-webhooks',
    query: 'How does Juniper retry a webhook without creating a second delivery identity?',
    slug: 'webhook-retry',
    split: 'test',
    subject: 'webhook delivery retry',
  },
  {
    answer: 'Kite rebuilds a search partition beside the active generation and switches readers after validation.',
    project: 'kite-search',
    query: 'How can Kite rebuild a partition while searches continue?',
    slug: 'partition-rebuild',
    split: 'test',
    subject: 'online search partition rebuild',
  },
] as const;

export function createRecallRerankerSmokeDatasetV1(): RecallRerankerDatasetV1 {
  const evaluationFixture = createRecallEvaluationFixtureV2();
  const groups = EffectArray.flatMap(SCENARIOS, scenario => [answerableGroup(scenario), noAnswerGroup(scenario)]);
  const forbiddenTexts = [
    ...EffectArray.map(evaluationFixture.documents, document => document.text),
    ...EffectArray.map(evaluationFixture.queries, query => query.query),
  ];
  return createRecallRerankerDatasetV1(
    {
      createdAt: SMOKE_CREATED_AT,
      description:
        'Small self-authored corpus for validating the training harness end to end. It is not sufficient for model-quality claims.',
      generatorRevision: 'threadnote-recall-reranker-smoke-v1',
      labelMethod: 'Self-authored and manually reviewed deterministic scenarios with explicit graded relevance.',
      name: 'threadnote-recall-reranker-harness-smoke-v1',
      partitionStrategy: 'fictional repository; all queries and documents for one repository stay in one split',
      privacyReviewed: true,
      purpose: 'harness_smoke',
      reservedEvaluations: [
        {
          name: evaluationFixture.metadata.name,
          sha256: sha256HexSync(serializeRecallEvaluationFixtureV2Identity(evaluationFixture)),
        },
      ],
      seed: SMOKE_SEED,
      sources: [
        {
          id: SOURCE_ID,
          kind: 'self_authored_synthetic',
          license: 'AGPL-3.0-or-later',
          licenseUrl: 'https://github.com/threadnote/threadnote/blob/main/LICENSE',
          privacyBasis: 'self_authored',
          provenance:
            'Original fictional engineering scenarios authored for the Threadnote training harness; no user, customer, or repository data.',
          redistributionApproved: true,
          revision: 'threadnote-recall-reranker-smoke-v1',
          sourceUri: 'https://github.com/threadnote/threadnote/blob/main/scripts/training/recall-reranker-smoke.ts',
          trainingApproved: true,
        },
      ],
    },
    groups,
    {forbiddenTexts},
  );
}

function answerableGroup(scenario: SmokeScenario): RecallRerankerQueryGroupV1 {
  return {
    answerability: 'answerable',
    candidates: [
      candidate(scenario, 'approved', scenario.answer, 3),
      candidate(
        scenario,
        'lexical',
        `${scenario.project} discusses ${scenario.subject}, but this draft lists questions without specifying the approved behavior.`,
        0,
        'lexical_hard',
      ),
      candidate(
        scenario,
        'stale',
        `An obsolete ${scenario.project} note proposes a different ${scenario.subject} policy and is explicitly marked superseded.`,
        0,
        'stale',
      ),
      candidate(
        scenario,
        'scope',
        `A neighboring service uses similar terminology for ${scenario.subject}, but its contract does not apply to ${scenario.project}.`,
        0,
        'wrong_scope',
      ),
    ],
    id: `${scenario.slug}-answerable`,
    language: 'en',
    partitionKey: `fictional-repository:${scenario.project}`,
    provenanceRecord: `scripts/training/recall-reranker-smoke.ts#${scenario.slug}`,
    query: scenario.query,
    sourceId: SOURCE_ID,
    split: scenario.split,
    version: RECALL_RERANKER_DATASET_VERSION,
  };
}

function noAnswerGroup(scenario: SmokeScenario): RecallRerankerQueryGroupV1 {
  const query = `What is the approved ${scenario.project} policy for offline satellite archive recovery?`;
  return {
    answerability: 'no_answer',
    candidates: [
      candidate(
        scenario,
        'missing-near',
        `${scenario.project} has an archive overview, but it contains no decision about offline satellite recovery.`,
        0,
        'no_answer_distractor',
      ),
      candidate(
        scenario,
        'missing-semantic',
        `A recovery checklist describes ordinary backups for ${scenario.project} without mentioning satellites or offline archives.`,
        0,
        'semantic_hard',
      ),
      candidate(
        scenario,
        'missing-scope',
        `The Lunar research service documents satellite archive recovery, but its policy does not apply to ${scenario.project}.`,
        0,
        'wrong_scope',
      ),
      candidate(
        scenario,
        'missing-random',
        `The ${scenario.project} contributor guide explains local test naming and formatting conventions.`,
        0,
        'random',
      ),
    ],
    id: `${scenario.slug}-no-answer`,
    language: 'en',
    partitionKey: `fictional-repository:${scenario.project}`,
    provenanceRecord: `scripts/training/recall-reranker-smoke.ts#${scenario.slug}-no-answer`,
    query,
    sourceId: SOURCE_ID,
    split: scenario.split,
    version: RECALL_RERANKER_DATASET_VERSION,
  };
}

function candidate(
  scenario: SmokeScenario,
  suffix: string,
  text: string,
  relevance: number,
  negativeKind?: RecallRerankerCandidateV1['negativeKind'],
): RecallRerankerCandidateV1 {
  return {
    id: `${scenario.slug}-${suffix}`,
    language: 'en',
    ...(negativeKind === undefined ? {} : {negativeKind}),
    provenanceRecord: `scripts/training/recall-reranker-smoke.ts#${scenario.slug}-${suffix}`,
    relevance,
    reviewed: true,
    sourceId: SOURCE_ID,
    text,
    title: `${scenario.project}: ${scenario.subject}`,
  };
}
