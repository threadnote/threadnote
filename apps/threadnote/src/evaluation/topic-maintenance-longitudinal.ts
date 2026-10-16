import {sha256HexSync} from '@threadnote/platform/sha256';

export const TOPIC_STUDY_VERSION = 1 as const;
export const TOPIC_STUDY_ARMS = ['scripted-manual', 'maintained-local', 'maintained-alternate', 'naive-local'] as const;
export type TopicStudyArm = (typeof TOPIC_STUDY_ARMS)[number];
export type TopicStudyClass =
  'unchanged' | 'review-required' | 'unavailable' | 'policy-conflict' | 'insufficient-evidence' | 'stale-conflict';
export type TopicStudyStatus = 'observed' | 'failed' | 'unavailable';
const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9-]{1,63}$/u;
const MAX_CORPUS_BYTES = 256 * 1024;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

export interface TopicStudyProbeV1 {
  readonly id: string;
  readonly question: string;
  /** Null means the independent oracle requires an explicit abstention. */
  readonly answer: string | null;
}

export interface TopicStudyEventV1 {
  readonly index: number;
  readonly id: string;
  readonly operation: string;
  readonly expectedClass: TopicStudyClass;
  readonly declaredPositive: boolean;
  readonly expectedBodyHash: string | null;
  readonly sourceHistoryAvailable: boolean;
  /** Complete file bytes after this event, or null for deletion; never a model-derived patch. */
  readonly changes: readonly {readonly path: string; readonly content: string | null}[];
  readonly postReviewChanges: readonly {readonly path: string; readonly content: string | null}[];
  /** Independently authored allowed paragraph edits; all other paragraphs must remain exact. */
  readonly allowedEditOrdinals: readonly number[];
  readonly commit: boolean;
  readonly indexGraph: boolean;
  readonly fault:
    | 'none'
    | 'graph-outage'
    | 'dirty-source'
    | 'target-race'
    | 'metadata-race'
    | 'source-race'
    | 'duplicate-restart'
    | 'reviewer-edit'
    | 'reject'
    | 'defer-resume'
    | 'packet-overflow'
    | 'shared-conflict'
    | 'semantic-ambiguity'
    | 'history-missing'
    | 'validity-window';
  readonly probes: readonly TopicStudyProbeV1[];
}

export interface TopicStudyCorpusV1 {
  readonly version: typeof TOPIC_STUDY_VERSION;
  readonly id: string;
  readonly initialFixtureHash: string;
  readonly events: readonly TopicStudyEventV1[];
}

export interface TopicStudyProbeObservationV1 {
  readonly id: string;
  readonly answer: string | null;
  readonly evidence: string | null;
  readonly judged: 'correct' | 'incorrect' | 'unavailable' | 'adjudication-required';
}

export interface TopicStudyObservationV1 {
  readonly status: TopicStudyStatus;
  readonly reason: string | null;
  readonly actualClass: TopicStudyClass | null;
  readonly sourceCommit: string | null;
  readonly sourceTreeHash: string | null;
  readonly targetBeforeHash: string | null;
  readonly targetAfterHash: string | null;
  readonly detected: boolean | null;
  readonly draftAttempted: boolean;
  readonly draftCompleted: boolean;
  readonly accepted: boolean;
  readonly approved: boolean;
  readonly identityPreserved: boolean | null;
  readonly provenancePreserved: boolean | null;
  readonly unrelatedBodyPreserved: boolean | null;
  readonly model: {
    readonly backend: string;
    readonly id: string;
    readonly digest: string | null;
    readonly settingsHash: string | null;
    readonly modelVersion: string | null;
    readonly promptVersion: string | null;
    readonly attempts: number | null;
  } | null;
  readonly downstreamModel: TopicStudyObservationV1['model'];
  readonly downstreamPromptHash: string | null;
  readonly retrievalHash: string | null;
  readonly promptHash: string | null;
  readonly providerInputTokens: number | null;
  readonly providerOutputTokens: number | null;
  readonly providerChargeMicros: number | null;
  readonly computeMilliseconds: number | null;
  readonly reviewerMilliseconds: number | null;
  readonly evidenceOpens: number | null;
  readonly correctionBytes: number | null;
  readonly setupMilliseconds: number | null;
  readonly scanMilliseconds: number | null;
  readonly evidenceMilliseconds: number | null;
  readonly downstreamMilliseconds: number | null;
  readonly retainedBytes: number | null;
  readonly commandReceiptHashes: readonly string[];
  readonly probes: readonly TopicStudyProbeObservationV1[];
  readonly adjudication: string | null;
}

export interface TopicStudyLedgerRowV1 {
  readonly version: 1;
  readonly corpusHash: string;
  readonly runNonce: string;
  readonly arm: TopicStudyArm;
  readonly repetition: number;
  readonly eventIndex: number;
  readonly eventId: string;
  readonly observation: TopicStudyObservationV1;
  readonly previousHash: string | null;
  readonly hash: string;
}

export function topicStudyCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(topicStudyCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${topicStudyCanonicalJson(item)}`).join(',')}}`;
  }
  if (value === undefined) throw new Error('Undefined is not canonical JSON.');
  return JSON.stringify(value);
}

export function topicStudyHash(domain: string, value: unknown): string {
  return sha256HexSync(`${domain}\n${topicStudyCanonicalJson(value)}`);
}

export function parseTopicStudyCorpusV1(input: unknown): TopicStudyCorpusV1 {
  const corpus = record(input, 'corpus', ['version', 'id', 'initialFixtureHash', 'events']);
  if (corpus.version !== 1) fail('corpus version must be 1');
  const events = list(corpus.events, 'events').map((item, offset) => {
    const event = record(item, `event ${offset + 1}`, [
      'index',
      'id',
      'operation',
      'expectedClass',
      'declaredPositive',
      'expectedBodyHash',
      'sourceHistoryAvailable',
      'changes',
      'postReviewChanges',
      'allowedEditOrdinals',
      'commit',
      'indexGraph',
      'fault',
      'probes',
    ]);
    if (event.index !== offset + 1 || !Number.isSafeInteger(event.index)) fail('event indices must be sequential');
    const probes = list(event.probes, 'probes').map(item => {
      const probe = record(item, 'probe', ['id', 'question', 'answer']);
      return {id: identifier(probe.id), question: nonempty(probe.question), answer: nullableString(probe.answer)};
    });
    if (probes.length < 7 || new Set(probes.map(probe => probe.id)).size !== probes.length)
      fail('each event needs seven or more unique probes');
    const parseChanges = (input: unknown) =>
      list(input, 'source changes').map(item => {
        const change = record(item, 'source change', ['path', 'content']);
        const path = nonempty(change.path);
        if (
          !/^[a-zA-Z0-9._/-]+$/u.test(path) ||
          path.startsWith('/') ||
          path.split('/').some(segment => ['', '.', '..', '.git'].includes(segment))
        )
          fail('unsafe source path');
        if (change.content !== null && (typeof change.content !== 'string' || change.content.length > 32_768))
          fail('source content must be bounded bytes or deletion');
        return {path, content: change.content};
      });
    const changes = parseChanges(event.changes);
    const postReviewChanges = parseChanges(event.postReviewChanges);
    if (new Set(changes.map(change => change.path)).size !== changes.length) fail('duplicate source change path');
    if (new Set(postReviewChanges.map(change => change.path)).size !== postReviewChanges.length)
      fail('duplicate post-review source change path');
    const commit = bool(event.commit);
    const indexGraph = bool(event.indexGraph);
    if (indexGraph && !commit) fail('graph index requires a committed transition');
    return {
      index: event.index,
      id: identifier(event.id),
      operation: identifier(event.operation),
      expectedClass: member(event.expectedClass, [
        'unchanged',
        'review-required',
        'unavailable',
        'policy-conflict',
        'insufficient-evidence',
        'stale-conflict',
      ] as const),
      declaredPositive: bool(event.declaredPositive),
      expectedBodyHash: nullableHash(event.expectedBodyHash),
      sourceHistoryAvailable: bool(event.sourceHistoryAvailable),
      changes,
      postReviewChanges,
      allowedEditOrdinals: list(event.allowedEditOrdinals, 'allowed paragraph edits').map(value =>
        integer(value, 0, 63),
      ),
      commit,
      indexGraph,
      fault: member(event.fault, [
        'none',
        'graph-outage',
        'dirty-source',
        'target-race',
        'metadata-race',
        'source-race',
        'duplicate-restart',
        'reviewer-edit',
        'reject',
        'defer-resume',
        'packet-overflow',
        'shared-conflict',
        'semantic-ambiguity',
        'history-missing',
        'validity-window',
      ] as const),
      probes,
    };
  });
  if (events.length < 30 || events.length > 64 || new Set(events.map(event => event.id)).size !== events.length)
    fail('corpus needs 30-64 unique sequential events');
  const recurring = events[0].probes.slice(0, 7).map(probe => `${probe.id}\0${probe.question}`);
  for (const event of events) {
    if (
      event.probes
        .slice(0, 7)
        .map(probe => `${probe.id}\0${probe.question}`)
        .some((probe, index) => probe !== recurring[index])
    )
      fail('all recurring probes must be asked after every event');
  }
  return {version: 1, id: identifier(corpus.id), initialFixtureHash: hash(corpus.initialFixtureHash), events};
}

export function topicStudyCorpusHashV1(input: unknown): string {
  return topicStudyHash('topic-study-corpus-v1', parseTopicStudyCorpusV1(input));
}

export function parseTopicStudyCorpusJsonV1(json: string): TopicStudyCorpusV1 {
  if (new TextEncoder().encode(json).byteLength > MAX_CORPUS_BYTES) fail('corpus exceeds 256 KiB');
  return parseTopicStudyCorpusV1(JSON.parse(json) as unknown);
}

export function topicStudyLedgerRowV1(input: Omit<TopicStudyLedgerRowV1, 'hash' | 'version'>): TopicStudyLedgerRowV1 {
  const withoutHash = {...input, version: 1 as const};
  return {...withoutHash, hash: topicStudyHash('topic-study-ledger-row-v1', withoutHash)};
}

export function assertTopicStudyLedgerV1(input: string, corpusInput: unknown): readonly TopicStudyLedgerRowV1[] {
  if (new TextEncoder().encode(input).byteLength > MAX_LEDGER_BYTES) fail('ledger exceeds 16 MiB');
  const corpus = parseTopicStudyCorpusV1(corpusInput);
  const corpusHash = topicStudyCorpusHashV1(corpus);
  let previous: string | null = null;
  let runKey = '';
  let runNonce = '';
  const seenRuns = new Set<string>();
  const rows =
    input.trim() === ''
      ? []
      : input
          .trimEnd()
          .split('\n')
          .map((line, offset) => {
            const row = record(JSON.parse(line) as unknown, `ledger row ${offset + 1}`, [
              'version',
              'corpusHash',
              'runNonce',
              'arm',
              'repetition',
              'eventIndex',
              'eventId',
              'observation',
              'previousHash',
              'hash',
            ]);
            if (row.version !== 1 || row.corpusHash !== corpusHash || row.previousHash !== previous)
              fail('ledger hash chain mismatch');
            const arm = member(row.arm, TOPIC_STUDY_ARMS);
            const repetition = integer(row.repetition, 1, 100);
            const eventIndex = integer(row.eventIndex, 1, corpus.events.length);
            const expectedIndex = (offset % corpus.events.length) + 1;
            if (eventIndex !== expectedIndex || row.eventId !== corpus.events[eventIndex - 1].id)
              fail('ledger event order mismatch');
            const key = `${arm}/${repetition}`;
            const nonce = nonempty(row.runNonce);
            if (eventIndex === 1) {
              if (seenRuns.has(key)) fail('duplicate run');
              seenRuns.add(key);
              runKey = key;
              runNonce = nonce;
            } else if (key !== runKey || nonce !== runNonce) fail('arm/repetition/nonce changed within sequential run');
            const observation = parseObservation(row.observation, corpus.events[eventIndex - 1]);
            const withoutHash = {
              version: 1 as const,
              corpusHash,
              runNonce: nonce,
              arm,
              repetition,
              eventIndex,
              eventId: corpus.events[eventIndex - 1].id,
              observation,
              previousHash: previous,
            };
            const parsedHash = hash(row.hash);
            if (parsedHash !== topicStudyHash('topic-study-ledger-row-v1', withoutHash))
              fail('ledger row hash mismatch');
            previous = parsedHash;
            return {...withoutHash, hash: parsedHash};
          });
  return rows;
}

function parseObservation(input: unknown, event: TopicStudyEventV1): TopicStudyObservationV1 {
  const source = record(input, 'observation', [
    'status',
    'reason',
    'actualClass',
    'sourceCommit',
    'sourceTreeHash',
    'targetBeforeHash',
    'targetAfterHash',
    'detected',
    'draftAttempted',
    'draftCompleted',
    'accepted',
    'approved',
    'identityPreserved',
    'provenancePreserved',
    'unrelatedBodyPreserved',
    'model',
    'downstreamModel',
    'downstreamPromptHash',
    'retrievalHash',
    'promptHash',
    'providerInputTokens',
    'providerOutputTokens',
    'providerChargeMicros',
    'computeMilliseconds',
    'reviewerMilliseconds',
    'evidenceOpens',
    'correctionBytes',
    'setupMilliseconds',
    'scanMilliseconds',
    'evidenceMilliseconds',
    'downstreamMilliseconds',
    'retainedBytes',
    'commandReceiptHashes',
    'probes',
    'adjudication',
  ]);
  const status = member(source.status, ['observed', 'failed', 'unavailable'] as const);
  const parseModel = (input: unknown): TopicStudyObservationV1['model'] => {
    if (input === null) return null;
    const value = record(input, 'model', [
      'backend',
      'id',
      'digest',
      'settingsHash',
      'modelVersion',
      'promptVersion',
      'attempts',
    ]);
    return {
      backend: nonempty(value.backend),
      id: nonempty(value.id),
      digest: nullableHash(value.digest),
      settingsHash: nullableHash(value.settingsHash),
      modelVersion: nullableString(value.modelVersion),
      promptVersion: nullableString(value.promptVersion),
      attempts: value.attempts === null ? null : integer(value.attempts, 1, 2),
    };
  };
  const model = parseModel(source.model);
  const probes = list(source.probes, 'observed probes').map(item => {
    const probe = record(item, 'observed probe', ['id', 'answer', 'evidence', 'judged']);
    return {
      id: identifier(probe.id),
      answer: nullableString(probe.answer),
      evidence: nullableString(probe.evidence),
      judged: member(probe.judged, ['correct', 'incorrect', 'unavailable', 'adjudication-required'] as const),
    };
  });
  if (probes.length !== event.probes.length || probes.some((probe, index) => probe.id !== event.probes[index].id))
    fail('every authored probe must have one observation');
  return {
    status,
    reason: nullableString(source.reason),
    actualClass:
      source.actualClass === null
        ? null
        : member(source.actualClass, [
            'unchanged',
            'review-required',
            'unavailable',
            'policy-conflict',
            'insufficient-evidence',
            'stale-conflict',
          ] as const),
    sourceCommit: nullableString(source.sourceCommit),
    sourceTreeHash: nullableGitObject(source.sourceTreeHash),
    targetBeforeHash: nullableHash(source.targetBeforeHash),
    targetAfterHash: nullableHash(source.targetAfterHash),
    detected: source.detected === null ? null : bool(source.detected),
    draftAttempted: bool(source.draftAttempted),
    draftCompleted: bool(source.draftCompleted),
    accepted: bool(source.accepted),
    approved: bool(source.approved),
    identityPreserved: source.identityPreserved === null ? null : bool(source.identityPreserved),
    provenancePreserved: source.provenancePreserved === null ? null : bool(source.provenancePreserved),
    unrelatedBodyPreserved: source.unrelatedBodyPreserved === null ? null : bool(source.unrelatedBodyPreserved),
    model,
    downstreamModel: parseModel(source.downstreamModel),
    downstreamPromptHash: nullableHash(source.downstreamPromptHash),
    retrievalHash: nullableHash(source.retrievalHash),
    promptHash: nullableHash(source.promptHash),
    providerInputTokens: nullableCount(source.providerInputTokens),
    providerOutputTokens: nullableCount(source.providerOutputTokens),
    providerChargeMicros: nullableCount(source.providerChargeMicros),
    computeMilliseconds: nullableCount(source.computeMilliseconds),
    reviewerMilliseconds: nullableCount(source.reviewerMilliseconds),
    evidenceOpens: nullableCount(source.evidenceOpens),
    correctionBytes: nullableCount(source.correctionBytes),
    setupMilliseconds: nullableCount(source.setupMilliseconds),
    scanMilliseconds: nullableCount(source.scanMilliseconds),
    evidenceMilliseconds: nullableCount(source.evidenceMilliseconds),
    downstreamMilliseconds: nullableCount(source.downstreamMilliseconds),
    retainedBytes: nullableCount(source.retainedBytes),
    commandReceiptHashes: list(source.commandReceiptHashes, 'receipt hashes').map(hash),
    probes,
    adjudication: nullableString(source.adjudication),
  };
}

export function topicStudyUnavailableObservationV1(event: TopicStudyEventV1, reason: string): TopicStudyObservationV1 {
  return {
    status: 'unavailable',
    reason,
    actualClass: null,
    sourceCommit: null,
    sourceTreeHash: null,
    targetBeforeHash: null,
    targetAfterHash: null,
    detected: null,
    draftAttempted: false,
    draftCompleted: false,
    accepted: false,
    approved: false,
    identityPreserved: null,
    provenancePreserved: null,
    unrelatedBodyPreserved: null,
    model: null,
    downstreamModel: null,
    downstreamPromptHash: null,
    retrievalHash: null,
    promptHash: null,
    providerInputTokens: null,
    providerOutputTokens: null,
    providerChargeMicros: null,
    computeMilliseconds: null,
    reviewerMilliseconds: null,
    evidenceOpens: null,
    correctionBytes: null,
    setupMilliseconds: null,
    scanMilliseconds: null,
    evidenceMilliseconds: null,
    downstreamMilliseconds: null,
    retainedBytes: null,
    commandReceiptHashes: [],
    probes: event.probes.map(probe => ({id: probe.id, answer: null, evidence: null, judged: 'unavailable'})),
    adjudication: null,
  };
}

export interface TopicStudyGateEvidenceV1 {
  readonly realTopicPilot: {
    readonly topicId: string;
    readonly corpusHash: string;
    readonly receiptHash: string;
    readonly observations: readonly {
      readonly hash: string;
      readonly sourceCommit: string;
      readonly targetBeforeHash: string | null;
      readonly targetAfterHash: string | null;
      readonly identityPreserved: boolean | null;
      readonly provenancePreserved: boolean | null;
      readonly unrelatedBodyPreserved: boolean | null;
      readonly correct: number;
      readonly incorrect: number;
      readonly unavailable: number;
    }[];
  } | null;
  readonly alternatePermission: {
    readonly modelId: string;
    readonly receiptHash: string;
    readonly rowHashes: readonly string[];
  } | null;
  readonly humanPairs: readonly {
    readonly manualRowHash: string;
    readonly candidateRowHash: string;
    readonly receiptHash: string;
  }[];
  readonly costProfile: {
    readonly rowHashes: readonly string[];
    readonly receiptHash: string;
    readonly reuseCounts: readonly number[];
    readonly computeMicrosPerSecond: number;
    readonly reviewerMicrosPerMinute: number;
  } | null;
  readonly adjudications: readonly {
    readonly rowHash: string;
    readonly probeId: string;
    readonly receiptHash: string;
    readonly judged: 'correct' | 'incorrect';
  }[];
}

export interface TopicStudyGateInputV1 {
  readonly evidence?: TopicStudyGateEvidenceV1;
  readonly realTopicPilotObserved: boolean;
  readonly alternatePermittedAndMeasured: boolean;
  readonly pairedHumanMedianReduction: number | null;
  readonly totalCostMeasured: boolean;
  readonly disagreementsAdjudicated: boolean;
  readonly downstreamNoRegression: boolean | null;
}

export function parseTopicStudyGateInputV1(input: unknown): TopicStudyGateInputV1 {
  const hasEvidence = input !== null && typeof input === 'object' && Object.hasOwn(input, 'evidence');
  const gate = record(input, 'gate evidence', [
    ...(hasEvidence ? ['evidence'] : []),
    'realTopicPilotObserved',
    'alternatePermittedAndMeasured',
    'pairedHumanMedianReduction',
    'totalCostMeasured',
    'disagreementsAdjudicated',
    'downstreamNoRegression',
  ]);
  const reduction = gate.pairedHumanMedianReduction;
  if (
    reduction !== null &&
    (typeof reduction !== 'number' || !Number.isFinite(reduction) || reduction < -1 || reduction > 1)
  )
    fail('paired human median reduction must be a measured fraction or null');
  return {
    ...(hasEvidence ? {evidence: parseGateEvidence(gate.evidence)} : {}),
    realTopicPilotObserved: bool(gate.realTopicPilotObserved),
    alternatePermittedAndMeasured: bool(gate.alternatePermittedAndMeasured),
    pairedHumanMedianReduction: reduction,
    totalCostMeasured: bool(gate.totalCostMeasured),
    disagreementsAdjudicated: bool(gate.disagreementsAdjudicated),
    downstreamNoRegression: gate.downstreamNoRegression === null ? null : bool(gate.downstreamNoRegression),
  };
}

export function summarizeTopicStudyV1(
  rows: readonly TopicStudyLedgerRowV1[],
  corpusInput: unknown,
  gate: TopicStudyGateInputV1,
) {
  const corpus = parseTopicStudyCorpusV1(corpusInput);
  const runKeys = new Set(rows.map(row => `${row.arm}/${row.repetition}`));
  const completeRuns = [...runKeys].filter(
    key => rows.filter(row => `${row.arm}/${row.repetition}` === key).length === corpus.events.length,
  );
  const repetitions = Math.max(1, ...rows.map(row => row.repetition));
  const expectedRows = corpus.events.length * TOPIC_STUDY_ARMS.length * repetitions;
  const probes = rows.flatMap(row => row.observation.probes);
  const declared = rows.filter(row => corpus.events[row.eventIndex - 1].declaredPositive);
  const truePositive = declared.filter(row => row.observation.detected === true).length;
  const falseNegative = declared.filter(row => row.observation.detected === false).length;
  const falsePositive = rows.filter(
    row => !corpus.events[row.eventIndex - 1].declaredPositive && row.observation.detected === true,
  ).length;
  const reviewerTimes = rows
    .map(row => row.observation.reviewerMilliseconds)
    .filter((value): value is number => value !== null);
  const candidateRows = rows.filter(row => row.arm.startsWith('maintained'));
  const outcomeDisagreements = rows.filter(
    row =>
      row.observation.status === 'observed' &&
      row.observation.actualClass !== corpus.events[row.eventIndex - 1].expectedClass,
  );
  const hardFailures = rows.filter(row => {
    const obs = row.observation;
    return (
      (obs.accepted && !obs.approved) ||
      obs.identityPreserved === false ||
      obs.provenancePreserved === false ||
      obs.unrelatedBodyPreserved === false ||
      (obs.status === 'observed' &&
        (corpus.events[row.eventIndex - 1].expectedClass === 'stale-conflict' ||
          corpus.events[row.eventIndex - 1].expectedClass === 'unavailable') &&
        obs.accepted) ||
      obs.probes.some(probe => probe.judged === 'incorrect' && probe.answer !== null)
    );
  });
  const gradingMismatches = candidateRows.filter(row =>
    row.observation.probes.some(probe => {
      const grade = gradeTopicStudyAnswerV1(
        corpus.events[row.eventIndex - 1].probes.find(item => item.id === probe.id)!,
        probe.answer,
      );
      return grade === 'incorrect' || (probe.judged === 'correct' && grade !== 'correct');
    }),
  );
  const candidateHardFailures = [
    ...new Set([...hardFailures.filter(row => row.arm.startsWith('maintained')), ...gradingMismatches]),
  ];
  const candidateDisagreements = outcomeDisagreements.filter(row => row.arm.startsWith('maintained'));
  const reasons: string[] = [];
  if (
    rows.length !== expectedRows ||
    TOPIC_STUDY_ARMS.some(arm =>
      Array.from({length: repetitions}, (_, offset) => `${arm}/${offset + 1}`).some(key => !completeRuns.includes(key)),
    )
  )
    reasons.push('incomplete synthetic arm coverage');
  if (
    rows.some(
      row =>
        row.observation.status !== 'observed' &&
        (row.arm !== 'naive-local' || row.observation.status === 'unavailable'),
    )
  )
    reasons.push('failed or unavailable candidate/manual events or unavailable comparator');
  if (
    candidateRows.some(row =>
      row.observation.probes.some(
        probe =>
          probe.judged === 'unavailable' ||
          gradeTopicStudyAnswerV1(
            corpus.events[row.eventIndex - 1].probes.find(item => item.id === probe.id)!,
            probe.answer,
          ) === 'unavailable',
      ),
    )
  )
    reasons.push('downstream probe observations unavailable');
  if (candidateDisagreements.length) reasons.push('observed event class disagrees with authored oracle');
  if (gradingMismatches.length) reasons.push('candidate answers or labels disagree with independent grading');
  if (candidateHardFailures.length) reasons.push('hard safety or false-current failure');
  if (!gate.realTopicPilotObserved) reasons.push('real-topic pilot missing');
  if (!gate.alternatePermittedAndMeasured) reasons.push('permitted measured alternate arm missing');
  if (gate.pairedHumanMedianReduction === null || gate.pairedHumanMedianReduction < 0.25)
    reasons.push('paired human reviewer median benefit below 25% or unmeasured');
  if (!gate.totalCostMeasured) reasons.push('total-cost profile unmeasured');
  if (!gate.disagreementsAdjudicated) reasons.push('answer disagreements not adjudicated');
  if (gate.downstreamNoRegression !== true) reasons.push('downstream answer quality unproven or regressed');
  validateGateMeasurements(rows, corpus, gate, reasons);
  return {
    decision: reasons.length === 0 ? ('GO' as const) : ('HOLD' as const),
    reasons,
    phase7Blocked: reasons.length > 0,
    denominators: {
      plannedEvents: expectedRows,
      recordedEvents: rows.length,
      observedEvents: rows.filter(row => row.observation.status === 'observed').length,
      failedEvents: rows.filter(row => row.observation.status === 'failed').length,
      unavailableEvents: rows.filter(row => row.observation.status === 'unavailable').length,
      declaredPositiveEvents: declared.length,
      detectionAttempted: rows.filter(row => row.observation.detected !== null).length,
      draftAttempted: rows.filter(row => row.observation.draftAttempted).length,
      draftCompleted: rows.filter(row => row.observation.draftCompleted).length,
      accepted: rows.filter(row => row.observation.accepted).length,
      probePlanned: rows.reduce((total, row) => total + corpus.events[row.eventIndex - 1].probes.length, 0),
      probeAnswered: probes.filter(probe => probe.answer !== null).length,
      probeAbstained: probes.filter(
        probe => gradeTopicStudyAnswerV1({id: probe.id, question: '', answer: null}, probe.answer) === 'correct',
      ).length,
      probeUnavailable: probes.filter(probe => probe.judged === 'unavailable').length,
    },
    detection: {
      truePositive,
      falsePositive,
      falseNegative,
      unknownPositive: declared.filter(row => row.observation.detected === null).length,
      conditionalRecall: truePositive + falseNegative === 0 ? null : truePositive / (truePositive + falseNegative),
      precision: truePositive + falsePositive === 0 ? null : truePositive / (truePositive + falsePositive),
      recall: declared.length === 0 ? null : truePositive / declared.length,
    },
    reviewerMillisecondsMedian: median(reviewerTimes),
    measuredProviderChargeMicros: rows.reduce((total, row) => total + (row.observation.providerChargeMicros ?? 0), 0),
    providerChargeUnknownEvents: rows.filter(row => row.observation.providerChargeMicros === null).length,
    byArm: TOPIC_STUDY_ARMS.map(arm => {
      const armRows = rows.filter(row => row.arm === arm);
      const elapsed = armRows
        .map(row => row.observation.computeMilliseconds)
        .filter((value): value is number => value !== null);
      return {
        arm,
        rows: armRows.length,
        observed: armRows.filter(row => row.observation.status === 'observed').length,
        unavailable: armRows.filter(row => row.observation.status === 'unavailable').length,
        failed: armRows.filter(row => row.observation.status === 'failed').length,
        detection: {
          declaredPositive: armRows.filter(row => corpus.events[row.eventIndex - 1].declaredPositive).length,
          truePositive: armRows.filter(
            row => corpus.events[row.eventIndex - 1].declaredPositive && row.observation.detected === true,
          ).length,
          falseNegative: armRows.filter(
            row => corpus.events[row.eventIndex - 1].declaredPositive && row.observation.detected === false,
          ).length,
          unknownPositive: armRows.filter(
            row => corpus.events[row.eventIndex - 1].declaredPositive && row.observation.detected === null,
          ).length,
        },
        hardFailures: (arm.startsWith('maintained') ? candidateHardFailures : hardFailures).filter(
          row => row.arm === arm,
        ).length,
        outcomeDisagreements: outcomeDisagreements.filter(row => row.arm === arm).length,
        correctProbes: armRows.reduce(
          (count, row) =>
            count +
            row.observation.probes.filter(
              probe =>
                gradeTopicStudyAnswerV1(
                  corpus.events[row.eventIndex - 1].probes.find(item => item.id === probe.id)!,
                  probe.answer,
                ) === 'correct',
            ).length,
          0,
        ),
        incorrectProbes: armRows.reduce(
          (count, row) =>
            count +
            row.observation.probes.filter(
              probe =>
                gradeTopicStudyAnswerV1(
                  corpus.events[row.eventIndex - 1].probes.find(item => item.id === probe.id)!,
                  probe.answer,
                ) === 'incorrect',
            ).length,
          0,
        ),
        adjudicationRequiredProbes: armRows.reduce(
          (count, row) =>
            count +
            row.observation.probes.filter(
              probe =>
                gradeTopicStudyAnswerV1(
                  corpus.events[row.eventIndex - 1].probes.find(item => item.id === probe.id)!,
                  probe.answer,
                ) === 'adjudication-required',
            ).length,
          0,
        ),
        computeMillisecondsMedian: median(elapsed),
        computeMillisecondsMaximum: elapsed.length ? Math.max(...elapsed) : null,
      };
    }),
    hardFailureCount: candidateHardFailures.length,
    comparatorHardFailureCount: hardFailures.filter(row => !row.arm.startsWith('maintained')).length,
    outcomeDisagreementCount: candidateDisagreements.length,
    comparatorOutcomeDisagreementCount: outcomeDisagreements.length - candidateDisagreements.length,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fail(message: string): never {
  throw new Error(`Invalid topic study: ${message}`);
}
function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== [...keys].sort().join(',')) fail(`${name} has unknown or missing keys`);
  return result;
}
function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail('expected bounded nonempty string');
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : nonempty(value);
}
function identifier(value: unknown): string {
  const parsed = nonempty(value);
  if (!ID.test(parsed)) fail('invalid identifier');
  return parsed;
}
function hash(value: unknown): string {
  const parsed = nonempty(value);
  if (!HASH.test(parsed)) fail('invalid hash');
  return parsed;
}
function nullableHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}
function nullableGitObject(value: unknown): string | null {
  if (value === null) return null;
  const parsed = nonempty(value);
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(parsed)) fail('invalid Git object identity');
  return parsed;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('expected boolean');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('invalid integer');
  return value as number;
}
function nullableCount(value: unknown): number | null {
  return value === null ? null : integer(value, 0, Number.MAX_SAFE_INTEGER);
}
function member<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) fail('invalid enum member');
  return value;
}

/** Exact/typed independent oracle. Unrecognized prose requires an explicit adjudication. */
export function gradeTopicStudyAnswerV1(
  probe: TopicStudyProbeV1,
  answer: string | null,
): TopicStudyProbeObservationV1['judged'] {
  if (answer === null || !answer.trim() || answer.length > 4096) return 'unavailable';
  const normalize = (text: string) =>
    text
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[.!]+$/u, '')
      .replace(/\s+/gu, ' ');
  const value = normalize(answer);
  const abstentions = ['unknown', 'unavailable', 'insufficient evidence', 'cannot verify', 'abstain'];
  if (probe.answer === null) return abstentions.includes(value) ? 'correct' : 'incorrect';
  const gold = normalize(probe.answer);
  if (value === gold) return 'correct';
  if (abstentions.includes(value) || /\b(?:not|never|unknown|unavailable|insufficient|cannot|abstain)\b/u.test(value))
    return 'incorrect';
  if (/^\d+ seconds?$/u.test(gold)) {
    if (/^\d+ seconds?$/u.test(value))
      return value.replace(/ seconds?$/u, '') === gold.replace(/ seconds?$/u, '') ? 'correct' : 'incorrect';
    return 'adjudication-required';
  }
  if (/^(?:yes|no)(?:;|$)/u.test(gold)) {
    const polarity = gold.startsWith('no') ? 'no' : 'yes';
    if (value === polarity) return 'correct';
    if (value === (polarity === 'no' ? 'yes' : 'no')) return 'incorrect';
  }
  return 'adjudication-required';
}

interface StudyDocument {
  readonly fields: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
  readonly paragraphs: readonly string[];
  readonly citations: readonly Record<string, unknown>[];
  readonly manifest: Record<string, unknown> | null;
}

/** Deliberately independent of production memory/manifest acceptance validators. */
function studyDocument(text: string): StudyDocument | null {
  const normalized = text.replace(/\r\n/gu, '\n').trim();
  const boundary = normalized.indexOf('\n\n');
  if (!normalized.startsWith('MEMORY\n') || boundary < 0) return null;
  const fields = new Map<string, string[]>();
  for (const line of normalized.slice(7, boundary).split('\n')) {
    const match = /^([a-z_]+): (.*)$/u.exec(line);
    if (!match) return null;
    fields.set(match[1], [...(fields.get(match[1]) ?? []), match[2]]);
  }
  try {
    const citations = (fields.get('code_citation') ?? []).map(value => JSON.parse(value) as Record<string, unknown>);
    const manifest = fields.get('topic_maintenance');
    if (manifest && manifest.length !== 1) return null;
    return {
      fields,
      citations,
      body: normalized.slice(boundary + 2),
      manifest: manifest ? (JSON.parse(manifest[0]) as Record<string, unknown>) : null,
      paragraphs: normalized
        .slice(boundary + 2)
        .split(/\n\s*\n/u)
        .map(value => value.trim()),
    };
  } catch {
    return null;
  }
}

export function topicStudyBodyV1(document: string): string {
  return studyDocument(document)?.body ?? document;
}

export function measureTopicStudyPreservationV1(before: string, after: string, allowedEditOrdinals: readonly number[]) {
  const previous = studyDocument(before);
  const current = studyDocument(after);
  if (!previous || !current) return {identityPreserved: null, provenancePreserved: null, unrelatedBodyPreserved: null};
  const same = (a: unknown, b: unknown) => topicStudyCanonicalJson(a ?? null) === topicStudyCanonicalJson(b ?? null);
  const identityPreserved =
    previous.fields.has('memory_id') && same(previous.fields.get('memory_id'), current.fields.get('memory_id'));
  const mutable = new Set([
    'schema_version',
    'code_citation',
    'topic_maintenance',
    'consolidation',
    'updated_at',
    'last_reviewed',
  ]);
  const protectedFields = [...new Set([...previous.fields.keys(), ...current.fields.keys()])].filter(
    key => !mutable.has(key),
  );
  let provenancePreserved = protectedFields.every(key => same(previous.fields.get(key), current.fields.get(key)));
  const old = previous.manifest;
  const next = current.manifest;
  if (old) {
    if (!next || ![1, 2].includes(old.version as number) || ![1, 2].includes(next.version as number))
      provenancePreserved = false;
    else {
      if (!studyManifestPinsMatch(previous) || !studyManifestPinsMatch(current)) provenancePreserved = false;
      if (previous.body !== current.body && next.version !== 2) provenancePreserved = false;
      const oldParagraphs = old.paragraphs as readonly Record<string, unknown>[];
      const newParagraphs = next.paragraphs as readonly Record<string, unknown>[];
      if (!Array.isArray(oldParagraphs) || !Array.isArray(newParagraphs)) provenancePreserved = false;
      else {
        for (const key of ['memoryId', 'repositoryId', 'coverage', 'additionalDependencies'])
          if (!same(old[key], next[key])) provenancePreserved = false;
        if (oldParagraphs.length !== newParagraphs.length) provenancePreserved = false;
        for (const [ordinal, paragraph] of oldParagraphs.entries()) {
          const updated = newParagraphs[ordinal];
          if (!updated) {
            provenancePreserved = false;
            continue;
          }
          for (const key of ['ordinal', 'role', 'support', 'scope', 'validity'])
            if (!same(paragraph[key], updated[key])) provenancePreserved = false;
          if (!allowedEditOrdinals.includes(ordinal) && !same(paragraph.citationIds, updated.citationIds))
            provenancePreserved = false;
        }
        const oldOrigins =
          old.version === 2 ? old.originCitationIds : previous.citations.map(citation => citation.id).sort();
        if (next.version === 2 && !same(oldOrigins, next.originCitationIds)) provenancePreserved = false;
        if (old.version === 2 && next.version !== 2) provenancePreserved = false;
        const priorAccepted =
          old.version === 2 && Array.isArray(old.acceptedSources)
            ? new Set(old.acceptedSources.map((item: {acceptedCitationId: string}) => item.acceptedCitationId))
            : new Set();
        const declaredAfter = new Set(newParagraphs.flatMap(paragraph => paragraph.citationIds as string[]));
        if (Array.isArray(next.additionalDependencies))
          for (const dependency of next.additionalDependencies) declaredAfter.add(dependency.citationId);
        for (const citation of previous.citations) {
          const required =
            !priorAccepted.has(citation.id) ||
            declaredAfter.has(citation.id as string) ||
            (Array.isArray(oldOrigins) && oldOrigins.includes(citation.id));
          if (required && !current.citations.some(item => item.id === citation.id && same(item, citation)))
            provenancePreserved = false;
        }
        const ids = new Set(current.citations.map(citation => citation.id));
        const declared = new Set(
          newParagraphs.flatMap(paragraph => (Array.isArray(paragraph.citationIds) ? paragraph.citationIds : [])),
        );
        if (Array.isArray(next.additionalDependencies))
          for (const dependency of next.additionalDependencies) declared.add(dependency.citationId);
        if ([...declared].some(id => !ids.has(id))) provenancePreserved = false;
        if (next.version === 2) {
          const accepted = next.acceptedSources as readonly {citationId: string; acceptedCitationId: string}[];
          if (
            !Array.isArray(accepted) ||
            accepted.length !== declared.size ||
            new Set(accepted.map(item => item.citationId)).size !== declared.size ||
            accepted.some(item => !declared.has(item.citationId) || !ids.has(item.acceptedCitationId))
          )
            provenancePreserved = false;
        }
      }
    }
  } else if (next) provenancePreserved = false;
  if (previous.fields.has('consolidation')) {
    const original = JSON.parse(previous.fields.get('consolidation')![0]) as {
      version: number;
      origin?: unknown;
      originBody?: unknown;
    };
    const updatedValue = current.fields.get('consolidation')?.[0];
    if (!updatedValue) provenancePreserved = false;
    else {
      const updated = JSON.parse(updatedValue) as {version: number; origin?: unknown; originBody?: unknown};
      if (original.version === 2 && !same(original.originBody, updated.originBody)) provenancePreserved = false;
      if (!same(original.version === 1 ? original : original.origin, updated.version === 1 ? updated : updated.origin))
        provenancePreserved = false;
    }
  }
  const unrelatedBodyPreserved =
    previous.paragraphs.length === current.paragraphs.length &&
    previous.paragraphs.every(
      (paragraph, ordinal) => allowedEditOrdinals.includes(ordinal) || paragraph === current.paragraphs[ordinal],
    );
  return {identityPreserved, provenancePreserved, unrelatedBodyPreserved};
}

function parseGateEvidence(input: unknown): TopicStudyGateEvidenceV1 {
  const source = record(input, 'referenced measurements', [
    'realTopicPilot',
    'alternatePermission',
    'humanPairs',
    'costProfile',
    'adjudications',
  ]);
  const hashes = (input: unknown) => list(input, 'row references').map(hash);
  const pilot =
    source.realTopicPilot === null
      ? null
      : record(source.realTopicPilot, 'real topic pilot', ['topicId', 'corpusHash', 'receiptHash', 'observations']);
  const permission =
    source.alternatePermission === null
      ? null
      : record(source.alternatePermission, 'alternate permission', ['modelId', 'receiptHash', 'rowHashes']);
  const cost =
    source.costProfile === null
      ? null
      : record(source.costProfile, 'cost profile', [
          'rowHashes',
          'receiptHash',
          'reuseCounts',
          'computeMicrosPerSecond',
          'reviewerMicrosPerMinute',
        ]);
  return {
    realTopicPilot: pilot
      ? {
          topicId: nonempty(pilot.topicId),
          corpusHash: hash(pilot.corpusHash),
          receiptHash: hash(pilot.receiptHash),
          observations: list(pilot.observations, 'pilot observations').map(input => {
            const obs = record(input, 'pilot observation', [
              'hash',
              'sourceCommit',
              'targetBeforeHash',
              'targetAfterHash',
              'identityPreserved',
              'provenancePreserved',
              'unrelatedBodyPreserved',
              'correct',
              'incorrect',
              'unavailable',
            ]);
            return {
              hash: hash(obs.hash),
              sourceCommit: nullableGitObject(obs.sourceCommit) ?? fail('pilot source commit missing'),
              targetBeforeHash: nullableHash(obs.targetBeforeHash),
              targetAfterHash: nullableHash(obs.targetAfterHash),
              identityPreserved: obs.identityPreserved === null ? null : bool(obs.identityPreserved),
              provenancePreserved: obs.provenancePreserved === null ? null : bool(obs.provenancePreserved),
              unrelatedBodyPreserved: obs.unrelatedBodyPreserved === null ? null : bool(obs.unrelatedBodyPreserved),
              correct: integer(obs.correct, 0, 10000),
              incorrect: integer(obs.incorrect, 0, 10000),
              unavailable: integer(obs.unavailable, 0, 10000),
            };
          }),
        }
      : null,
    alternatePermission: permission
      ? {
          modelId: nonempty(permission.modelId),
          receiptHash: hash(permission.receiptHash),
          rowHashes: hashes(permission.rowHashes),
        }
      : null,
    humanPairs: list(source.humanPairs, 'human pairs').map(input => {
      const pair = record(input, 'human pair', ['manualRowHash', 'candidateRowHash', 'receiptHash']);
      return {
        manualRowHash: hash(pair.manualRowHash),
        candidateRowHash: hash(pair.candidateRowHash),
        receiptHash: hash(pair.receiptHash),
      };
    }),
    costProfile: cost
      ? {
          rowHashes: hashes(cost.rowHashes),
          receiptHash: hash(cost.receiptHash),
          reuseCounts: list(cost.reuseCounts, 'reuse counts').map(value => integer(value, 1, 1000000)),
          computeMicrosPerSecond: integer(cost.computeMicrosPerSecond, 0, Number.MAX_SAFE_INTEGER),
          reviewerMicrosPerMinute: integer(cost.reviewerMicrosPerMinute, 0, Number.MAX_SAFE_INTEGER),
        }
      : null,
    adjudications: list(source.adjudications, 'adjudications').map(input => {
      const item = record(input, 'adjudication', ['rowHash', 'probeId', 'receiptHash', 'judged']);
      return {
        rowHash: hash(item.rowHash),
        probeId: identifier(item.probeId),
        receiptHash: hash(item.receiptHash),
        judged: member(item.judged, ['correct', 'incorrect'] as const),
      };
    }),
  };
}

function validateGateMeasurements(
  rows: readonly TopicStudyLedgerRowV1[],
  corpus: TopicStudyCorpusV1,
  gate: TopicStudyGateInputV1,
  reasons: string[],
) {
  const candidates = rows.filter(row => row.arm.startsWith('maintained'));
  const pinned = (model: TopicStudyObservationV1['model']) =>
    model !== null &&
    model.modelVersion !== null &&
    model.settingsHash !== null &&
    model.promptVersion !== null &&
    model.attempts !== null &&
    (model.backend !== 'local-ai' || model.digest !== null);
  if (
    candidates.some(
      ({observation: obs, eventIndex}) =>
        obs.detected === null ||
        (obs.detected && !obs.draftAttempted && corpus.events[eventIndex - 1].fault !== 'duplicate-restart') ||
        obs.identityPreserved !== true ||
        obs.provenancePreserved !== true ||
        obs.unrelatedBodyPreserved !== true ||
        obs.targetBeforeHash === null ||
        obs.targetAfterHash === null ||
        obs.sourceCommit === null ||
        obs.sourceTreeHash === null ||
        obs.commandReceiptHashes.length === 0 ||
        !pinned(obs.downstreamModel) ||
        obs.downstreamPromptHash === null ||
        obs.retrievalHash === null ||
        (obs.draftAttempted && (!obs.draftCompleted || !pinned(obs.model) || obs.promptHash === null)),
    )
  )
    reasons.push('required preservation or model/prompt/runtime observations missing');
  const answerModels = new Set(
    rows
      .filter(row => row.observation.probes.some(probe => probe.answer !== null))
      .map(row => {
        const model = row.observation.downstreamModel;
        return pinned(model) ? topicStudyCanonicalJson(model) : 'unknown';
      }),
  );
  if (
    answerModels.size !== 1 ||
    answerModels.has('unknown') ||
    rows.some(
      row =>
        row.observation.probes.some(probe => probe.answer !== null) &&
        (row.observation.downstreamPromptHash === null || row.observation.retrievalHash === null),
    )
  )
    reasons.push('fixed public probe model/prompt/retrieval measurements missing or inconsistent');
  const sourceTrees = new Map<string, string | null>();
  for (const row of rows) {
    const key = `${row.repetition}/${row.eventIndex}`;
    const previous = sourceTrees.get(key);
    if (previous !== undefined && previous !== row.observation.sourceTreeHash) {
      reasons.push('matched arms diverged from the authored source timeline');
      break;
    }
    sourceTrees.set(key, row.observation.sourceTreeHash);
  }
  if (
    rows.some(
      ({observation: obs, eventIndex}) =>
        obs.providerChargeMicros === null ||
        obs.providerInputTokens === null ||
        obs.providerOutputTokens === null ||
        obs.scanMilliseconds === null ||
        obs.evidenceMilliseconds === null ||
        obs.downstreamMilliseconds === null ||
        obs.retainedBytes === null ||
        (obs.draftAttempted && obs.computeMilliseconds === null) ||
        (eventIndex === 1 && obs.setupMilliseconds === null),
    )
  )
    reasons.push('cost or usage observations missing');
  const evidence = gate.evidence;
  const pilot = evidence?.realTopicPilot;
  if (
    !pilot ||
    pilot.corpusHash === topicStudyCorpusHashV1(corpus) ||
    !pilot.observations.length ||
    pilot.observations.some(
      obs =>
        obs.correct < 1 ||
        obs.incorrect ||
        obs.unavailable ||
        obs.targetBeforeHash === null ||
        obs.targetAfterHash === null ||
        obs.identityPreserved !== true ||
        obs.provenancePreserved !== true ||
        obs.unrelatedBodyPreserved !== true,
    )
  )
    reasons.push('referenced real-topic observations missing or incomplete');
  const byHash = new Map(rows.map(row => [row.hash, row]));
  const permission = evidence?.alternatePermission;
  const alternateDrafts = rows.filter(row => row.arm === 'maintained-alternate' && row.observation.draftCompleted);
  if (
    !permission ||
    !alternateDrafts.length ||
    alternateDrafts.some(
      row => row.observation.model?.id !== permission.modelId || !permission.rowHashes.includes(row.hash),
    ) ||
    permission.rowHashes.some(value => byHash.get(value)?.arm !== 'maintained-alternate')
  )
    reasons.push('referenced alternate permission/measurements missing');
  const pairs = evidence?.humanPairs ?? [];
  const reductions: number[] = [];
  const pairedTimes = new Map<string, {manual: number[]; candidate: number[]}>();
  const pairedArms = new Set<string>();
  const pairedRows = new Set<string>();
  let pairsValid = pairs.length > 0;
  for (const pair of pairs) {
    const manual = byHash.get(pair.manualRowHash),
      candidate = byHash.get(pair.candidateRowHash);
    const a = manual?.observation.reviewerMilliseconds,
      b = candidate?.observation.reviewerMilliseconds;
    if (
      !manual ||
      !candidate ||
      manual.arm !== 'scripted-manual' ||
      !candidate.arm.startsWith('maintained') ||
      manual.eventIndex !== candidate.eventIndex ||
      manual.repetition !== candidate.repetition ||
      manual.observation.status !== 'observed' ||
      candidate.observation.status !== 'observed' ||
      a === null ||
      a === undefined ||
      a <= 0 ||
      b === null ||
      b === undefined ||
      manual.observation.evidenceOpens === null ||
      candidate.observation.evidenceOpens === null ||
      manual.observation.correctionBytes === null ||
      candidate.observation.correctionBytes === null ||
      pairedRows.has(candidate.hash)
    ) {
      pairsValid = false;
      continue;
    }
    pairedRows.add(candidate.hash);
    pairedArms.add(candidate.arm);
    reductions.push((a - b) / a);
    const times = pairedTimes.get(candidate.arm) ?? {manual: [], candidate: []};
    times.manual.push(a);
    times.candidate.push(b);
    pairedTimes.set(candidate.arm, times);
  }
  const reduction = median(reductions);
  if (
    !pairsValid ||
    pairedArms.size !== 2 ||
    [...pairedTimes.values()].some(
      times => (median(times.candidate) ?? Infinity) > (median(times.manual) ?? 0) * 0.75,
    ) ||
    reduction === null ||
    reduction < 0.25 ||
    gate.pairedHumanMedianReduction !== reduction
  )
    reasons.push('referenced paired human observations do not establish the claimed benefit');
  const cost = evidence?.costProfile;
  if (
    !cost ||
    new Set(cost.rowHashes).size !== rows.length ||
    rows.some(row => !cost.rowHashes.includes(row.hash)) ||
    cost.rowHashes.some(value => !byHash.has(value)) ||
    cost.reuseCounts.length < 2 ||
    !cost.reuseCounts.includes(1) ||
    !cost.reuseCounts.some(value => value > 1)
  )
    reasons.push('referenced total-cost/reuse profile missing');
  const grade = (row: TopicStudyLedgerRowV1, probe: TopicStudyProbeObservationV1) =>
    gradeTopicStudyAnswerV1(
      corpus.events[row.eventIndex - 1].probes.find(item => item.id === probe.id)!,
      probe.answer,
    );
  const adjudication = (row: TopicStudyLedgerRowV1, probe: TopicStudyProbeObservationV1) =>
    evidence?.adjudications.find(item => item.rowHash === row.hash && item.probeId === probe.id);
  const adjudicated = (row: TopicStudyLedgerRowV1, probe: TopicStudyProbeObservationV1) =>
    grade(row, probe) === 'adjudication-required' && adjudication(row, probe)?.judged === 'correct';
  const reviewed = (row: TopicStudyLedgerRowV1, probe: TopicStudyProbeObservationV1) => {
    const decision = adjudication(row, probe);
    return !!decision && (grade(row, probe) === 'adjudication-required' || decision.judged === grade(row, probe));
  };
  let regression = false,
    disagreement = false;
  for (const row of candidates) {
    const manual = rows.find(
      item =>
        item.arm === 'scripted-manual' && item.repetition === row.repetition && item.eventIndex === row.eventIndex,
    );
    if (!manual) {
      regression = true;
      continue;
    }
    for (const probe of row.observation.probes) {
      const baseline = manual.observation.probes.find(item => item.id === probe.id);
      if (grade(row, probe) === 'adjudication-required' && !adjudicated(row, probe)) disagreement = true;
      if (
        baseline &&
        (grade(manual, baseline) === 'correct' || adjudicated(manual, baseline)) &&
        grade(row, probe) !== 'correct' &&
        !adjudicated(row, probe)
      )
        regression = true;
      if (
        baseline &&
        baseline.answer !== probe.answer &&
        !(grade(row, probe) === 'correct' && grade(manual, baseline) === 'correct') &&
        (!reviewed(row, probe) || !reviewed(manual, baseline))
      )
        disagreement = true;
    }
  }
  if (disagreement) reasons.push('referenced case-level answer adjudications missing');
  if (regression) reasons.push('matched manual downstream observations regress or are missing');
}

export function classifyTopicStudyProposalV1(
  input: unknown,
): 'applicable' | 'policy-conflict' | 'insufficient-evidence' | null {
  if (!input || typeof input !== 'object') return null;
  const proposal = input as {draft?: {outcome?: unknown}; body?: unknown};
  if (typeof proposal.body !== 'string') return null;
  switch (proposal.draft?.outcome) {
    case 'propose-update':
    case 'propose-revalidation':
      return 'applicable';
    case 'policy-conflict':
      return 'policy-conflict';
    case 'insufficient-evidence':
      return 'insufficient-evidence';
    default:
      return null;
  }
}

export function topicStudyWrittenReceiptV1(
  input: unknown,
  expected: {reviewId: string; revision: number; digest: string; content: string},
): boolean {
  if (!input || typeof input !== 'object') return false;
  const result = input as {
    reviewId?: unknown;
    candidates?: readonly {state?: unknown}[];
    maintenanceApproval?: {
      stage?: unknown;
      reviewRevision?: unknown;
      preview?: {approvalDigest?: unknown; content?: unknown};
    };
  };
  return (
    result.reviewId === expected.reviewId &&
    result.candidates?.length === 1 &&
    result.candidates[0].state === 'applied' &&
    result.maintenanceApproval?.stage === 'written' &&
    result.maintenanceApproval.reviewRevision === expected.revision &&
    result.maintenanceApproval.preview?.approvalDigest === expected.digest &&
    typeof result.maintenanceApproval.preview.content === 'string' &&
    result.maintenanceApproval.preview.content.trim() === expected.content.trim()
  );
}

/** Only an exact typed public domain error establishes a stale-source refusal. */
export function topicStudySourceConflictV1(stdout: string, stderr: string): boolean {
  for (const text of [stdout, stderr]) {
    try {
      const error = JSON.parse(text) as {_tag?: unknown; message?: unknown};
      if (
        error._tag === 'TopicReviewSourceError' &&
        [
          'The reviewed declared source changed or is unavailable.',
          'The reviewed source identity or excerpt changed.',
        ].includes(error.message as string)
      )
        return true;
    } catch {
      /* Unsupported unstructured errors remain unknown, never successful fault evidence. */
    }
  }
  return false;
}

export function topicStudyProbePromptV1(
  body: string,
  publicEvidence: string,
  probes: readonly Pick<TopicStudyProbeV1, 'id' | 'question'>[],
): string {
  if (!publicEvidence.trim()) throw new Error('Public retrieval/freshness evidence is unavailable.');
  const prompt =
    'Answer every question using the accepted topic and the public current evidence/freshness below. ' +
    'Historical facts remain historical. If current support is missing, stale, dirty, incomplete or unavailable, answer "unknown" for a verified-current question. ' +
    'Return only a JSON object mapping each question ID to one concise answer (a value with units, yes/no, or unknown).\n\n' +
    `Accepted topic:\n${body}\n\nPublic accepted-only Context Brief (budget 1500 tokens):\n${publicEvidence}\n\nQuestions:\n` +
    JSON.stringify(probes.map(({id, question}) => ({id, question})));
  if (prompt.length > 24000) throw new Error('Fixed public answer input exceeds the pinned request budget.');
  return prompt;
}

function studyManifestPinsMatch(document: StudyDocument): boolean {
  const manifest = document.manifest;
  if (
    !manifest ||
    manifest.memoryId !== document.fields.get('memory_id')?.[0] ||
    manifest.coverage !== 'declared-only' ||
    manifest.bodyHash !== sha256HexSync(document.body) ||
    !Array.isArray(manifest.paragraphs) ||
    manifest.paragraphs.length !== document.paragraphs.length ||
    !Array.isArray(manifest.additionalDependencies) ||
    !document.citations.length
  )
    return false;
  const ids = new Set(document.citations.map(citation => citation.id));
  if (
    ids.size !== document.citations.length ||
    document.citations.some(
      citation =>
        typeof citation.id !== 'string' ||
        citation.repositoryId !== manifest.repositoryId ||
        typeof citation.sourceCommit !== 'string' ||
        !/^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(citation.sourceCommit) ||
        !citation.fileContentHash ||
        typeof citation.fileContentHash !== 'object' ||
        !HASH.test((citation.fileContentHash as {value: string}).value),
    )
  )
    return false;
  if (
    manifest.paragraphs.some(
      (paragraph: Record<string, unknown>, ordinal: number) =>
        !paragraph ||
        paragraph.ordinal !== ordinal ||
        paragraph.hash !== sha256HexSync(document.paragraphs[ordinal]) ||
        !['descriptive', 'historical', 'normative'].includes(paragraph.role as string) ||
        !['direct', 'contextual', 'unresolved'].includes(paragraph.support as string) ||
        !Array.isArray(paragraph.citationIds) ||
        paragraph.citationIds.some(id => !ids.has(id)),
    )
  )
    return false;
  if (
    manifest.additionalDependencies.some(
      (item: {citationId: string; kind: string}) =>
        !item || !ids.has(item.citationId) || !['configuration', 'dependency'].includes(item.kind),
    )
  )
    return false;
  if (
    manifest.version === 2 &&
    (!Array.isArray(manifest.originCitationIds) ||
      !manifest.originCitationIds.length ||
      manifest.originCitationIds.some(id => !ids.has(id)))
  )
    return false;
  return true;
}
