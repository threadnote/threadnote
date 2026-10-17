import {readFile} from '@threadnote/testing/node-fs-promises';
import {sha256HexSync} from '@threadnote/platform/sha256';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertTopicStudyLedgerV1,
  gradeTopicStudyAnswerV1,
  measureTopicStudyPreservationV1,
  topicStudyReviewExpectationV1,
  checkTopicStudyReviewV1,
  TOPIC_STUDY_REVIEWER_VERSION,
  type TopicStudyObservationV1,
  parseTopicStudyCorpusJsonV1,
  parseTopicStudyGateInputV1,
  summarizeTopicStudyV1,
  topicStudyCanonicalJson,
  topicStudyCorpusHashV1,
  topicStudyLedgerRowV1,
  topicStudyUnavailableObservationV1,
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';

function summarizeFixture(...args: Parameters<typeof summarizeTopicStudyV1>) {
  return summarizeTopicStudyV1(args[0], args[1], args[2], 1);
}

const fixturePath = 'apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json';
const sealPath = 'apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.sha256';

async function corpus() {
  return parseTopicStudyCorpusJsonV1(await readFile(fixturePath, 'utf8'));
}

describe('topic maintenance longitudinal evaluation', () => {
  it('seals an independently authored sequential corpus with recurring probes', async () => {
    const source = await readFile(fixturePath, 'utf8');
    const parsed = parseTopicStudyCorpusJsonV1(source);
    const seal = (await readFile(sealPath, 'utf8')).trim();
    expect(sha256HexSync(topicStudyCanonicalJson(parsed))).toBe(seal);
    expect(parsed.events).toHaveLength(50);
    expect(new Set(parsed.events.map(event => event.operation)).size).toBeGreaterThan(20);
    expect(parsed.events.every(event => event.probes.length >= 7)).toBe(true);
    expect(parsed.events[10].probes[0].answer).toBeNull();
    expect(parsed.events.map(event => event.probes[6].answer)).toEqual(
      Array.from({length: 50}, (_, offset) =>
        offset < 19 || [28, 31, 32].includes(offset) ? null : offset < 40 ? '45 seconds' : '50 seconds',
      ),
    );
    expect(() =>
      parseTopicStudyCorpusJsonV1(
        JSON.stringify({...parsed, events: parsed.events.map(event => ({...event, probes: event.probes.slice(0, 6)}))}),
      ),
    ).toThrow('seven');
  });

  it('separates stale preview refusal from fresh post-race answers and preserves legacy replay', async () => {
    const input = await corpus();
    const race = input.events.find(event => event.id === 'source-preview-race')!;
    expect(race.expectedClass).toBe('stale-conflict');
    expect(race.postReviewChanges[0].content).toContain('timeoutSeconds = 90;');
    expect(race.postReviewChanges[0].content).toContain('stagingTimeoutSeconds = 45;');
    expect(race.probes.find(probe => probe.id === 'race')?.answer).toBe('No');
    for (const [id, answer] of [
      ['current', '90 seconds'],
      ['staging', '45 seconds'],
    ]) {
      const probe = race.probes.find(item => item.id === id)!;
      expect(probe.answer).toBe(answer);
      expect(gradeTopicStudyAnswerV1(probe, answer)).toBe('correct');
    }
    const legacy = {
      ...input,
      events: input.events.map(event =>
        event.id === race.id
          ? {
              ...event,
              probes: event.probes.map(probe =>
                ['current', 'staging'].includes(probe.id) ? {...probe, answer: null} : probe,
              ),
            }
          : event,
      ),
    };
    expect(sha256HexSync(topicStudyCanonicalJson(legacy))).toBe(
      '4fca0c627a4f0a5a25f430f5358adf5189ecaac6f4cd72c78beda605d1ab30dd',
    );
    expect(topicStudyCorpusHashV1(legacy)).toBe('4da42cafcff571e9d8dae0f01aadedc2bfd027578dd1dc60d7b474ac0df97035');
    const event = legacy.events[0];
    const row = topicStudyLedgerRowV1({
      corpusHash: topicStudyCorpusHashV1(legacy),
      runNonce: 'legacy',
      arm: 'maintained-local',
      repetition: 1,
      eventIndex: event.index,
      eventId: event.id,
      observation: topicStudyUnavailableObservationV1(event, 'legacy diagnostic'),
      previousHash: null,
    });
    expect(assertTopicStudyLedgerV1(JSON.stringify(row), legacy)).toHaveLength(1);
    expect(() => assertTopicStudyLedgerV1(JSON.stringify(row), input)).toThrow();
  });

  it('rejects tampering, truncation of required probes, and reordered events', async () => {
    const input = await corpus();
    const event = input.events[0];
    const observation = topicStudyUnavailableObservationV1(event, 'runtime not configured');
    const row = topicStudyLedgerRowV1({
      corpusHash: topicStudyCorpusHashV1(input),
      runNonce: 'run-a',
      arm: 'maintained-local',
      repetition: 1,
      eventIndex: 1,
      eventId: event.id,
      observation,
      previousHash: null,
    });
    expect(assertTopicStudyLedgerV1(`${JSON.stringify(row)}\n`, input)).toEqual([row]);
    expect(() => assertTopicStudyLedgerV1(`${JSON.stringify({...row, eventId: 'changed'})}\n`, input)).toThrow();
    expect(() =>
      assertTopicStudyLedgerV1(`${JSON.stringify({...row, observation: {...observation, probes: []}})}\n`, input),
    ).toThrow();
    expect(() => assertTopicStudyLedgerV1(`${JSON.stringify({...row, previousHash: row.hash})}\n`, input)).toThrow();
  });

  it('keeps absent observations and missing pilot evidence on HOLD', async () => {
    const input = await corpus();
    const event = input.events[0];
    const row = topicStudyLedgerRowV1({
      corpusHash: topicStudyCorpusHashV1(input),
      runNonce: 'run-a',
      arm: 'maintained-local',
      repetition: 1,
      eventIndex: 1,
      eventId: event.id,
      observation: topicStudyUnavailableObservationV1(event, 'model absent'),
      previousHash: null,
    });
    const result = summarizeFixture([row], input, {
      realTopicPilotObserved: false,
      alternatePermittedAndMeasured: false,
      pairedHumanMedianReduction: null,
      totalCostMeasured: false,
      disagreementsAdjudicated: false,
      downstreamNoRegression: null,
    });
    expect(result.decision).toBe('HOLD');
    expect(result.phase7Blocked).toBe(true);
    expect(result.denominators.unavailableEvents).toBe(1);
    expect(result.denominators.probeUnavailable).toBe(7);
  });

  it('rejects optimistic gate evidence with wrong or extra fields', () => {
    const gate = {
      realTopicPilotObserved: false,
      alternatePermittedAndMeasured: false,
      pairedHumanMedianReduction: null,
      totalCostMeasured: false,
      disagreementsAdjudicated: false,
      downstreamNoRegression: null,
    };
    expect(parseTopicStudyGateInputV1(gate)).toEqual(gate);
    expect(() => parseTopicStudyGateInputV1({...gate, realTopicPilotObserved: 'true'})).toThrow();
    expect(() => parseTopicStudyGateInputV1({...gate, pairedHumanMedianReduction: 2})).toThrow();
    expect(() => parseTopicStudyGateInputV1({...gate, unreviewedPass: true})).toThrow();
  });

  it('replays exact authored source bytes in order and keeps numeric gold independent', async () => {
    const input = await corpus();
    const baseline = JSON.parse(
      await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/baseline.json', 'utf8'),
    ) as {
      sourceFiles: readonly {path: string; content: string}[];
    };
    const files = new Map(baseline.sourceFiles.map(item => [item.path, item.content]));
    for (const event of input.events) {
      for (const change of event.changes) {
        if (change.content === null) files.delete(change.path);
        else files.set(change.path, change.content);
      }
      for (const change of event.postReviewChanges) {
        if (change.content === null) files.delete(change.path);
        else files.set(change.path, change.content);
      }
      const gold = event.probes[0].answer;
      const config = files.get('config.ts');
      if (gold !== null && config !== undefined) {
        const actual = /timeoutSeconds = (\d+)/u.exec(config)?.[1];
        expect(`${actual} seconds`, event.id).toBe(gold);
        const stagingGold = event.probes[6].answer;
        if (stagingGold !== null)
          expect(`${/stagingTimeoutSeconds = (\d+)/u.exec(config)?.[1]} seconds`, event.id).toBe(stagingGold);
      }
    }
    expect(files.get('config.ts')).toContain('timeoutSeconds = 125');
  });

  it('roundtrips optional state receipts without changing legacy rows and separates authored labels from actual debt', async () => {
    const input = await corpus();
    const event = input.events.find(event => event.expectedClass === 'unchanged')!;
    const state = {beforeHash: 'b'.repeat(64), sourceHash: 'c'.repeat(64), eligible: true, repairOrdinals: [3, 4]};
    const reviewerExpectation = {
      version: TOPIC_STUDY_REVIEWER_VERSION,
      before: state,
      after: {...state, repairOrdinals: []},
    };
    const observation: TopicStudyObservationV1 = {
      ...topicStudyUnavailableObservationV1(event, 'measured state'),
      status: 'observed' as const,
      actualClass: 'review-required' as const,
      reviewerExpectation,
    };
    const makeRow = (obs: typeof observation) =>
      topicStudyLedgerRowV1({
        corpusHash: topicStudyCorpusHashV1(input),
        runNonce: 'stateful',
        arm: 'maintained-local',
        repetition: 1,
        eventIndex: event.index,
        eventId: event.id,
        observation: obs,
        previousHash: null,
      });
    const row = makeRow(observation);
    expect(assertTopicStudyLedgerV1(JSON.stringify(row), input)).toEqual([row]);
    const result = summarizeFixture([row], input, {
      realTopicPilotObserved: false,
      alternatePermittedAndMeasured: false,
      pairedHumanMedianReduction: null,
      totalCostMeasured: false,
      disagreementsAdjudicated: false,
      downstreamNoRegression: null,
    });
    expect(result.authoredClassDivergenceCount).toBe(1);
    expect(result.outcomeDisagreementCount).toBe(0);
    expect(result.detection.basis).toBe('authored-source-stream-v1');
    expect(result.literalReviewDebt).toMatchObject({
      beforeDebtRows: 1,
      afterDebtRows: 0,
      unknownBeforeRows: 0,
      unknownAfterRows: 0,
    });
    const {reviewerExpectation: _receipt, ...legacy} = observation;
    const legacyRow = makeRow(legacy);
    expect(assertTopicStudyLedgerV1(JSON.stringify(legacyRow), input)).toEqual([legacyRow]);
    expect(Object.hasOwn(legacyRow.observation, 'reviewerExpectation')).toBe(false);
    expect(
      summarizeFixture([legacyRow], input, {
        realTopicPilotObserved: false,
        alternatePermittedAndMeasured: false,
        pairedHumanMedianReduction: null,
        totalCostMeasured: false,
        disagreementsAdjudicated: false,
        downstreamNoRegression: null,
      }).outcomeDisagreementCount,
    ).toBe(1);
    const intrinsic = input.events.find(item => item.expectedClass === 'stale-conflict')!;
    const intrinsicRow = {...row, eventIndex: intrinsic.index, eventId: intrinsic.id};
    const gate = {
      realTopicPilotObserved: false,
      alternatePermittedAndMeasured: false,
      pairedHumanMedianReduction: null,
      totalCostMeasured: false,
      disagreementsAdjudicated: false,
      downstreamNoRegression: null,
    };
    expect(summarizeFixture([intrinsicRow], input, gate).outcomeDisagreementCount).toBe(1);
    const bad = makeRow({
      ...observation,
      reviewerExpectation: {...reviewerExpectation, before: {...state, repairOrdinals: [4, 3]}},
    });
    expect(() => assertTopicStudyLedgerV1(JSON.stringify(bad), input)).toThrow();
    const debt = makeRow({
      ...observation,
      accepted: true,
      approved: true,
      reviewerExpectation: {...reviewerExpectation, after: state},
    });
    expect(
      summarizeFixture([debt], input, {
        realTopicPilotObserved: false,
        alternatePermittedAndMeasured: false,
        pairedHumanMedianReduction: null,
        totalCostMeasured: false,
        disagreementsAdjudicated: false,
        downstreamNoRegression: null,
      }).hardFailureCount,
    ).toBe(1);
  });

  it('canonical hashing is independent of object key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({minLength: 1, maxLength: 8}), fc.integer()), entries => {
        const first = Object.fromEntries(Object.entries(entries));
        const reverse = Object.fromEntries(Object.entries(entries).reverse());
        expect(topicStudyCanonicalJson(first)).toBe(topicStudyCanonicalJson(reverse));
      }),
      {numRuns: 100},
    );
  });
});

describe('independent longitudinal answer and preservation contracts', () => {
  it('never certifies substring, negated, contradictory, or mixed abstention answers', () => {
    const current = {id: 'current', question: 'Current timeout?', answer: '60 seconds'};
    for (const answer of ['not 60 seconds', '160 seconds', '60 or 160 seconds', 'unknown; 60 seconds'])
      expect(gradeTopicStudyAnswerV1(current, answer)).not.toBe('correct');
    expect(gradeTopicStudyAnswerV1(current, '60 seconds.')).toBe('correct');
    expect(gradeTopicStudyAnswerV1({...current, answer: null}, 'not unknown; the current value is 60 seconds')).toBe(
      'incorrect',
    );
    expect(gradeTopicStudyAnswerV1({...current, answer: null}, 'unknown')).toBe('correct');
    expect(gradeTopicStudyAnswerV1({...current, answer: 'No'}, 'Nobody knows, yes')).not.toBe('correct');
    expect(gradeTopicStudyAnswerV1(current, 'The timeout appears to be 60 seconds')).toBe('adjudication-required');
  });

  it('numeric grading never accepts a different integer or negated correct value', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 100000}), fc.integer({min: 1, max: 100000}), (gold, other) => {
        const probe = {id: 'current', question: 'Current timeout?', answer: `${gold} seconds`};
        expect(gradeTopicStudyAnswerV1(probe, `not ${gold} seconds`)).not.toBe('correct');
        if (other !== gold) expect(gradeTopicStudyAnswerV1(probe, `${other} seconds`)).toBe('incorrect');
      }),
      {numRuns: 100},
    );
  });

  const citation = {
    id: 'original',
    repositoryId: 'repo',
    path: 'config.ts',
    sourceCommit: 'a'.repeat(40),
    fileContentHash: {algorithm: 'sha256', value: 'b'.repeat(64)},
  };
  function document(version = 1, paragraphs = ['intro', 'history', 'current', 'later exception']) {
    const manifest = {
      version,
      memoryId: 'tn_fixture',
      repositoryId: 'repo',
      coverage: 'declared-only',
      bodyHash: sha256HexSync(paragraphs.join('\n\n')),
      paragraphs: paragraphs.map((text, ordinal) => ({
        ordinal,
        hash: sha256HexSync(text),
        role: ordinal === 1 ? 'historical' : 'descriptive',
        support: 'direct',
        citationIds: ['original'],
      })),
      additionalDependencies: [],
      ...(version === 2
        ? {originCitationIds: ['original'], acceptedSources: [{citationId: 'original', acceptedCitationId: 'original'}]}
        : {}),
    };
    return (
      `MEMORY\nkind: durable\nmemory_id: tn_fixture\nproject: fixture\nowner: original\n` +
      `code_citation: ${JSON.stringify(citation)}\ntopic_maintenance: ${JSON.stringify(manifest)}\n\n${paragraphs.join('\n\n')}`
    );
  }
  const directParagraphs = (seconds = 60, heading = 'Context Health', staging?: number) => [
    'Context remains an explanation.',
    'Policy: preserve the accepted explanation until explicit review.',
    'Historically the timeout was 30 seconds.',
    `The production fixture timeout is ${seconds} seconds.`,
    `The display heading is ${heading}.`,
    ...(staging === undefined ? [] : [`The staging fixture timeout is ${staging} seconds.`]),
  ];
  const literalDocument = (paragraphs: readonly string[]) =>
    document(2, [...paragraphs]).replace(/^topic_maintenance: (.+)$/mu, (_line, json: string) => {
      const manifest = JSON.parse(json);
      manifest.paragraphs = manifest.paragraphs.map((paragraph: {ordinal: number}) => ({
        ...paragraph,
        role: paragraph.ordinal === 1 ? 'normative' : paragraph.ordinal === 2 ? 'historical' : 'descriptive',
        support: paragraph.ordinal === 0 ? 'contextual' : 'direct',
        ...(paragraph.ordinal >= 3 ? {scope: paragraph.ordinal === 5 ? 'staging' : 'production'} : {}),
      }));
      return `topic_maintenance: ${JSON.stringify(manifest)}`;
    });
  const literalSources = (seconds = 90, heading = 'Context Health v2', staging?: number) => ({
    eligible: true,
    config:
      `export const timeoutSeconds = ${seconds};\n` +
      (staging === undefined ? '' : `export const stagingTimeoutSeconds = ${staging};\n`),
    health: `export const title = "${heading}";\n`,
  });

  it('authorizes complete actual-state catchup and rejects partial residual heading debt', () => {
    const before = literalDocument(directParagraphs());
    const expectation = topicStudyReviewExpectationV1(before, literalSources());
    expect(expectation.repairOrdinals).toEqual([3, 4]);
    expect(expectation.expectedBody).toBe(directParagraphs(90, 'Context Health v2').join('\n\n'));
    expect(
      checkTopicStudyReviewV1(before, literalDocument(directParagraphs(90, 'Context Health v2')), expectation)
        .acceptable,
    ).toBe(true);
    expect(checkTopicStudyReviewV1(before, literalDocument(directParagraphs(90)), expectation)).toMatchObject({
      acceptable: false,
      residualDebtOrdinals: [4],
      reason: 'Unresolved registered literal claims: 4.',
    });
    expect(topicStudyReviewExpectationV1(before, {...literalSources(), eligible: false}).eligible).toBe(false);
    expect(
      topicStudyReviewExpectationV1(before, {
        ...literalSources(),
        config: 'export const timeoutSeconds = 90;\nexport const timeoutSeconds = 95;\n',
      }).eligible,
    ).toBe(false);
  });

  it('maintains existing staging but authorizes neither acquisition nor arbitrary descriptor rewording', () => {
    const before = literalDocument(directParagraphs(90, 'Context Health v2'));
    const expectation = topicStudyReviewExpectationV1(before, literalSources(90, 'Context Health v2', 50));
    expect(expectation.repairOrdinals).toEqual([]);
    expect(
      checkTopicStudyReviewV1(before, literalDocument(directParagraphs(90, 'Context Health v2', 50)), expectation)
        .acceptable,
    ).toBe(false);
    expect(
      checkTopicStudyReviewV1(
        before,
        before.replace('The display heading is Context Health v2.', 'Display: Context Health v2.'),
        expectation,
      ).acceptable,
    ).toBe(false);
    const staged = literalDocument(directParagraphs(90, 'Context Health v2', 45));
    const repair = topicStudyReviewExpectationV1(staged, literalSources(90, 'Context Health v2', 50));
    expect(repair.repairOrdinals).toEqual([5]);
    expect(
      checkTopicStudyReviewV1(staged, literalDocument(directParagraphs(90, 'Context Health v2', 50)), repair)
        .acceptable,
    ).toBe(true);
    expect(topicStudyReviewExpectationV1(staged, literalSources()).eligible).toBe(false);
  });

  it('protects identity, scope, roles, validity, origins and all nonrepair paragraphs during exact catchup', () => {
    const before = literalDocument(directParagraphs());
    const expectation = topicStudyReviewExpectationV1(before, literalSources());
    const correct = literalDocument(directParagraphs(90, 'Context Health v2'));
    const mutations = [
      correct.replace('memory_id: tn_fixture', 'memory_id: tn_other'),
      correct.replace('owner: original', 'owner: other'),
      correct.replace('"scope":"production"', '"scope":"staging"'),
      correct.replace('"role":"normative"', '"role":"descriptive"'),
      correct.replace('"originCitationIds":["original"]', '"originCitationIds":[]'),
      correct.replace('"scope":"production"', '"validity":"new","scope":"production"'),
      ...[0, 1, 2].map(ordinal =>
        literalDocument(
          directParagraphs(90, 'Context Health v2').map((text, index) =>
            index === ordinal ? `${text} Rewritten.` : text,
          ),
        ),
      ),
    ];
    for (const altered of mutations)
      expect(checkTopicStudyReviewV1(before, altered, expectation).acceptable).toBe(false);
  });

  it('exact repair authorization is invariant under inserted rejected attempts, with current claims and protected text fixed', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 1000}),
        fc.integer({min: 1, max: 1000}),
        fc.stringMatching(/^[a-z]{1,12}$/u),
        fc.array(fc.nat(100), {maxLength: 8}),
        (oldSeconds, currentSeconds, title, failures) => {
          const before = literalDocument(directParagraphs(oldSeconds));
          const source = literalSources(currentSeconds, title);
          const correct = literalDocument(directParagraphs(currentSeconds, title));
          // A rejected candidate never changes accepted state, regardless of its attempted edits or ideal allowances.
          let actual = before;
          for (const choice of failures) {
            const candidate = literalDocument(
              directParagraphs(oldSeconds).map((text, ordinal) => (ordinal === choice % 3 ? `${text} Corrupt.` : text)),
            );
            const assessment = checkTopicStudyReviewV1(
              actual,
              candidate,
              topicStudyReviewExpectationV1(actual, source),
            );
            expect(assessment.acceptable).toBe(false);
            if (assessment.acceptable) actual = candidate;
          }
          const expectation = topicStudyReviewExpectationV1(actual, source);
          expect(expectation).toEqual(topicStudyReviewExpectationV1(before, source));
          expect(expectation.repairOrdinals).toEqual([...(oldSeconds === currentSeconds ? [] : [3]), 4]);
          expect(checkTopicStudyReviewV1(actual, correct, expectation).acceptable).toBe(true);
          const reworded = correct.replace(
            `The production fixture timeout is ${currentSeconds} seconds.`,
            `Production timeout: ${currentSeconds} seconds.`,
          );
          expect(checkTopicStudyReviewV1(actual, reworded, expectation).acceptable).toBe(false);
        },
      ),
      {numRuns: 60},
    );
  });

  it('protects every independently declared untouched paragraph over bounded generated documents', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,20}$/u), {minLength: 1, maxLength: 12}),
        fc.nat(),
        (paragraphs, choice) => {
          const ordinal = choice % paragraphs.length;
          const changed = paragraphs.map((text, index) => (index === ordinal ? `${text} changed` : text));
          expect(
            measureTopicStudyPreservationV1(document(2, paragraphs), document(2, changed), []).unrelatedBodyPreserved,
          ).toBe(false);
          expect(
            measureTopicStudyPreservationV1(document(2, paragraphs), document(2, changed), [ordinal])
              .unrelatedBodyPreserved,
          ).toBe(true);
        },
      ),
      {numRuns: 100},
    );
  });

  it('permits repeated V2 reviewed-current pin replacement while retaining immutable origins and untouched citations', () => {
    const before = document(2);
    const boundary = before.indexOf('\n\n');
    const header = before.slice(0, boundary);
    const old = JSON.parse(header.split('topic_maintenance: ')[1]) as {
      acceptedSources: {citationId: string; acceptedCitationId: string}[];
    };
    const firstCitation = {...citation, id: 'current-one', sourceCommit: '1'.repeat(40)};
    const secondCitation = {...citation, id: 'current-two', sourceCommit: '2'.repeat(40)};
    const priorManifest = {...old, acceptedSources: [{citationId: 'original', acceptedCitationId: 'current-one'}]};
    const nextManifest = {...old, acceptedSources: [{citationId: 'original', acceptedCitationId: 'current-two'}]};
    const base = header.slice(0, header.indexOf('topic_maintenance: '));
    const prior =
      base +
      `code_citation: ${JSON.stringify(firstCitation)}\ntopic_maintenance: ${JSON.stringify(priorManifest)}` +
      before.slice(boundary);
    const next =
      base +
      `code_citation: ${JSON.stringify(secondCitation)}\ntopic_maintenance: ${JSON.stringify(nextManifest)}` +
      before.slice(boundary);
    expect(measureTopicStudyPreservationV1(prior, next, [])).toEqual({
      identityPreserved: true,
      provenancePreserved: true,
      unrelatedBodyPreserved: true,
    });
    expect(
      measureTopicStudyPreservationV1(prior, next.replace('owner: original', 'owner: missing'), []).provenancePreserved,
    ).toBe(false);
  });

  it('accepts no-op V1 and V2 while measuring every protected field, citation and later paragraph', () => {
    for (const version of [1, 2]) {
      const before = document(version);
      expect(measureTopicStudyPreservationV1(before, before, [])).toEqual({
        identityPreserved: true,
        provenancePreserved: true,
        unrelatedBodyPreserved: true,
      });
      expect(
        measureTopicStudyPreservationV1(before, before.replace('owner: original', 'owner: changed'), [])
          .provenancePreserved,
      ).toBe(false);
      expect(
        measureTopicStudyPreservationV1(before, before.replace(`code_citation: ${JSON.stringify(citation)}\n`, ''), [])
          .provenancePreserved,
      ).toBe(false);
      expect(
        measureTopicStudyPreservationV1(before, document(version, ['intro', 'history', 'current']), [2])
          .unrelatedBodyPreserved,
      ).toBe(false);
    }
    expect(
      measureTopicStudyPreservationV1(
        document(2),
        document(2).replace('"originCitationIds":["original"]', '"originCitationIds":[]'),
        [],
      ).provenancePreserved,
    ).toBe(false);
  });
});

it('separates a failing naive comparator from complete maintained/manual candidate evidence', async () => {
  const input = await corpus();
  const rows: ReturnType<typeof topicStudyLedgerRowV1>[] = [];
  const pin = {
    backend: 'local-ai',
    id: 'local',
    digest: '1'.repeat(64),
    settingsHash: '2'.repeat(64),
    modelVersion: 'verified-bytes;settings=recorded',
    promptVersion: 'request-v1',
    attempts: 1,
  };
  for (const arm of ['scripted-manual', 'maintained-local', 'maintained-alternate', 'naive-local'] as const) {
    for (const event of input.events) {
      const initial = topicStudyUnavailableObservationV1(event, 'unmeasured');
      const observation = {
        ...initial,
        status: 'observed' as const,
        reason: null,
        actualClass: event.expectedClass,
        sourceCommit: 'a'.repeat(40),
        sourceTreeHash: 'b'.repeat(64),
        targetBeforeHash: 'c'.repeat(64),
        targetAfterHash: 'd'.repeat(64),
        detected: event.declaredPositive,
        identityPreserved: true,
        provenancePreserved: true,
        unrelatedBodyPreserved: arm !== 'naive-local',
        downstreamModel: pin,
        downstreamPromptHash: 'e'.repeat(64),
        retrievalHash: 'f'.repeat(64),
        draftAttempted: arm.startsWith('maintained'),
        draftCompleted: arm.startsWith('maintained'),
        model: arm === 'maintained-alternate' ? {...pin, backend: 'effect-ai', id: 'alternate', digest: null} : pin,
        promptHash: '0'.repeat(64),
        providerInputTokens: 100,
        providerOutputTokens: 10,
        providerChargeMicros: 0,
        computeMilliseconds: 10,
        reviewerMilliseconds: arm === 'scripted-manual' ? 100 : 50,
        evidenceOpens: 1,
        correctionBytes: 0,
        setupMilliseconds: 10,
        scanMilliseconds: 10,
        evidenceMilliseconds: 10,
        downstreamMilliseconds: 10,
        retainedBytes: 1000,
        commandReceiptHashes: ['1'.repeat(64)],
        probes: event.probes.map(probe => ({
          id: probe.id,
          answer: arm === 'naive-local' ? `not ${probe.answer ?? 'unknown'}` : (probe.answer ?? 'unknown'),
          evidence: 'evidence',
          judged: arm === 'naive-local' ? ('incorrect' as const) : ('correct' as const),
        })),
      };
      rows.push(
        topicStudyLedgerRowV1({
          corpusHash: topicStudyCorpusHashV1(input),
          runNonce: `run-${arm}`,
          arm,
          repetition: 1,
          eventIndex: event.index,
          eventId: event.id,
          observation,
          previousHash: rows.at(-1)?.hash ?? null,
        }),
      );
    }
  }
  const gate = parseTopicStudyGateInputV1({
    realTopicPilotObserved: true,
    alternatePermittedAndMeasured: true,
    pairedHumanMedianReduction: 0.5,
    totalCostMeasured: true,
    disagreementsAdjudicated: true,
    downstreamNoRegression: true,
    evidence: {
      realTopicPilot: {
        topicId: 'real-reviewed-topic',
        corpusHash: '3'.repeat(64),
        receiptHash: '4'.repeat(64),
        observations: [
          {
            hash: '5'.repeat(64),
            sourceCommit: 'a'.repeat(40),
            targetBeforeHash: 'c'.repeat(64),
            targetAfterHash: 'd'.repeat(64),
            identityPreserved: true,
            provenancePreserved: true,
            unrelatedBodyPreserved: true,
            correct: 6,
            incorrect: 0,
            unavailable: 0,
          },
        ],
      },
      alternatePermission: {
        modelId: 'alternate',
        receiptHash: '4'.repeat(64),
        rowHashes: rows.filter(row => row.arm === 'maintained-alternate').map(row => row.hash),
      },
      humanPairs: ['maintained-local', 'maintained-alternate'].map(arm => ({
        manualRowHash: rows[0].hash,
        candidateRowHash: rows.find(row => row.arm === arm)!.hash,
        receiptHash: '4'.repeat(64),
      })),
      costProfile: {
        rowHashes: rows.map(row => row.hash),
        receiptHash: '4'.repeat(64),
        reuseCounts: [1, 10],
        computeMicrosPerSecond: 1,
        reviewerMicrosPerMinute: 1,
      },
      adjudications: [],
    },
  });
  const result = summarizeFixture(rows, input, gate);
  expect(result.reasons).toEqual([]);
  expect(result.decision).toBe('GO');
  expect(result.hardFailureCount).toBe(0);
  expect(result.comparatorHardFailureCount).toBe(input.events.length);
  expect(
    summarizeFixture(
      rows.map(row =>
        row.arm === 'naive-local'
          ? {...row, observation: {...row.observation, status: 'failed', reason: 'Measured baseline failure'}}
          : row,
      ),
      input,
      gate,
    ).decision,
  ).toBe('GO');
  const equivalentAnswers = rows.map(row =>
    row.arm.startsWith('maintained')
      ? {
          ...row,
          observation: {
            ...row.observation,
            probes: row.observation.probes.map(probe => ({...probe, answer: `${probe.answer!.toUpperCase()}.`})),
          },
        }
      : row,
  );
  expect(summarizeFixture(equivalentAnswers, input, gate).decision).toBe('GO');
  const forged = rows.map(row =>
    row.arm === 'maintained-local'
      ? {
          ...row,
          observation: {
            ...row.observation,
            probes: row.observation.probes.map(probe =>
              probe.id === 'current' ? {...probe, answer: 'not 160 seconds', judged: 'correct' as const} : probe,
            ),
          },
        }
      : row,
  );
  expect(summarizeFixture(forged, input, gate).decision).toBe('HOLD');
  const remappedStudy = (
    transform: (row: (typeof rows)[number]) => (typeof rows)[number]['observation'],
    adjudicatedRows: typeof rows = [],
  ) => {
    const relabelled: typeof rows = [];
    const remap = new Map<string, string>();
    for (const row of rows) {
      const next = topicStudyLedgerRowV1({
        corpusHash: row.corpusHash,
        runNonce: row.runNonce,
        arm: row.arm,
        repetition: row.repetition,
        eventIndex: row.eventIndex,
        eventId: row.eventId,
        observation: transform(row),
        previousHash: relabelled.at(-1)?.hash ?? null,
      });
      remap.set(row.hash, next.hash);
      relabelled.push(next);
    }
    const evidence = gate.evidence!;
    return {
      rows: relabelled,
      gate: {
        ...gate,
        evidence: {
          ...evidence,
          alternatePermission: {
            ...evidence.alternatePermission!,
            rowHashes: evidence.alternatePermission!.rowHashes.map(hash => remap.get(hash)!),
          },
          humanPairs: evidence.humanPairs.map(pair => ({
            ...pair,
            manualRowHash: remap.get(pair.manualRowHash)!,
            candidateRowHash: remap.get(pair.candidateRowHash)!,
          })),
          costProfile: {
            ...evidence.costProfile!,
            rowHashes: evidence.costProfile!.rowHashes.map(hash => remap.get(hash)!),
          },
          adjudications: adjudicatedRows.map(row => ({
            rowHash: remap.get(row.hash)!,
            probeId: 'current',
            receiptHash: '9'.repeat(64),
            judged: 'correct' as const,
          })),
        },
      },
    };
  };
  const firstCandidate = rows.find(row => row.arm === 'maintained-local')!;
  const wrongNumeric = remappedStudy(
    row =>
      row === firstCandidate
        ? {
            ...row.observation,
            probes: row.observation.probes.map(probe =>
              probe.id === 'current'
                ? {...probe, answer: '160 seconds', judged: 'adjudication-required' as const}
                : probe,
            ),
          }
        : row.observation,
    [firstCandidate, rows[0]],
  );
  const adverse = summarizeFixture(wrongNumeric.rows, input, wrongNumeric.gate);
  expect(adverse.decision).toBe('HOLD');
  expect(adverse.hardFailureCount).toBeGreaterThan(0);
  const unanswered = remappedStudy(row =>
    row.eventIndex === firstCandidate.eventIndex && row.arm !== 'naive-local'
      ? {
          ...row.observation,
          probes: row.observation.probes.map(probe =>
            probe.id === 'current' ? {...probe, answer: null, judged: 'adjudication-required' as const} : probe,
          ),
        }
      : row.observation,
  );
  const missing = summarizeFixture(unanswered.rows, input, unanswered.gate);
  expect(missing.decision).toBe('HOLD');
  expect(missing.hardFailureCount).toBe(0);
  expect(missing.reasons).toContain('downstream probe observations unavailable');
  const nullRows = rows.map(row => ({
    ...row,
    observation: {
      ...topicStudyUnavailableObservationV1(input.events[row.eventIndex - 1], 'null'),
      status: 'observed' as const,
      actualClass: input.events[row.eventIndex - 1].expectedClass,
      probes: row.observation.probes,
    },
  }));
  expect(summarizeFixture(nullRows, input, gate).decision).toBe('HOLD');
  expect(summarizeFixture(rows, input, {...gate, evidence: undefined}).decision).toBe('HOLD');
  const declared = rows.filter(row => input.events[row.eventIndex - 1].declaredPositive);
  const unknown = rows.map(row =>
    declared.includes(row) ? {...row, observation: {...row.observation, detected: null}} : row,
  );
  expect(summarizeFixture(unknown, input, gate).detection.recall).toBe(0);
  expect(summarizeFixture(unknown, input, gate).detection.unknownPositive).toBe(declared.length);
});

describe('executed-path probe eligibility', () => {
  const gate = {
    realTopicPilotObserved: false,
    alternatePermittedAndMeasured: false,
    pairedHumanMedianReduction: null,
    totalCostMeasured: false,
    disagreementsAdjudicated: false,
    downstreamNoRegression: null,
  };
  async function unsupportedCase() {
    const input = await corpus();
    const event = input.events[32];
    const observation = {
      ...topicStudyUnavailableObservationV1(event, `Fault ${event.fault} requires a dedicated execution adapter.`),
      probes: event.probes.map(probe => {
        const answer = probe.answer === null ? '125 seconds' : probe.answer;
        return {id: probe.id, answer, evidence: null, judged: gradeTopicStudyAnswerV1(probe, answer)};
      }),
    };
    const row = topicStudyLedgerRowV1({
      corpusHash: topicStudyCorpusHashV1(input),
      runNonce: 'unexecuted-fault',
      arm: 'maintained-local',
      repetition: 1,
      eventIndex: event.index,
      eventId: event.id,
      observation,
      previousHash: null,
    });
    return {input, event, row};
  }

  it('retains unexecuted counterfactual answers as diagnostics without fabricating observed failures', async () => {
    const {input, event, row} = await unsupportedCase();
    const result = summarizeFixture([row], input, gate);
    expect(result.decision).toBe('HOLD');
    expect(result.hardFailureCount).toBe(0);
    expect(result.denominators.unsupportedFaultEvents).toBe(1);
    expect(result.denominators.unsupportedFaultProbes).toBe(event.probes.length);
    expect(result.denominators.probePlanned).toBe(0);
    expect(result.byArm[1].incorrectProbes).toBe(0);
    expect(result.diagnosticProbes.incorrect).toBeGreaterThan(0);
    expect(result.reasons).not.toContain('candidate answers or labels disagree with independent grading');
  });

  it('keeps actual failed attempts, unavailable answers and nonmatching reason contracts in the denominator', async () => {
    const {input, event, row} = await unsupportedCase();
    for (const observation of [
      {...row.observation, status: 'failed' as const, reason: 'Actual execution failed'},
      {...row.observation, reason: 'Fault graph-outage requires a dedicated execution adapter.'},
      {...row.observation, actualClass: 'unavailable' as const},
    ]) {
      const result = summarizeFixture([{...row, observation}], input, gate);
      expect(result.denominators.probePlanned).toBe(event.probes.length);
      expect(result.denominators.unsupportedFaultEvents).toBe(0);
      expect(result.hardFailureCount).toBeGreaterThan(0);
    }
    const unavailable = summarizeFixture(
      [
        {
          ...row,
          observation: topicStudyUnavailableObservationV1(event, 'Actual adapter execution failed'),
        },
      ],
      input,
      gate,
    );
    expect(unavailable.denominators.probePlanned).toBe(event.probes.length);
    expect(unavailable.denominators.probeUnavailable).toBe(event.probes.length);
  });

  it('always reports physical safety violations even during unsupported fault slots', async () => {
    const {input, row} = await unsupportedCase();
    for (const violation of [
      {accepted: true, approved: false},
      {identityPreserved: false},
      {provenancePreserved: false},
      {unrelatedBodyPreserved: false},
    ]) {
      const result = summarizeFixture([{...row, observation: {...row.observation, ...violation}}], input, gate);
      expect(result.hardFailureCount).toBe(1);
      expect(result.decision).toBe('HOLD');
      expect(result.denominators.unsupportedFaultEvents).toBe(1);
    }
  });

  it('partitions every planned probe without discarding failures or mutating raw observations', async () => {
    const input = await corpus();
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 50, maxLength: 50}), flags => {
        const rows = input.events.map((event, index) =>
          topicStudyLedgerRowV1({
            corpusHash: topicStudyCorpusHashV1(input),
            runNonce: 'partition-check',
            arm: 'maintained-local',
            repetition: 1,
            eventIndex: event.index,
            eventId: event.id,
            previousHash: null,
            observation: {
              ...topicStudyUnavailableObservationV1(
                event,
                flags[index]
                  ? `Fault ${event.fault} requires a dedicated execution adapter.`
                  : 'Actual execution failed',
              ),
              status: flags[index] ? 'unavailable' : 'failed',
            },
          }),
        );
        const before = JSON.stringify(rows);
        const result = summarizeFixture(rows, input, gate);
        const counts = result.denominators;
        expect(counts.allSlotProbePlanned).toBe(
          counts.probePlanned + counts.unsupportedFaultProbes + counts.unrecordedSlotProbePlanned!,
        );
        expect(counts.recordedSlotProbePlanned).toBe(counts.probePlanned + counts.unsupportedFaultProbes);
        expect(result.byArm.reduce((sum, arm) => sum + arm.measuredProbes.planned, 0)).toBe(counts.probePlanned);
        for (const arm of result.byArm)
          expect(arm.measuredProbes.planned).toBe(
            arm.measuredProbes.correct +
              arm.measuredProbes.incorrect +
              arm.measuredProbes.adjudicationRequired +
              arm.measuredProbes.unavailable,
          );
        expect(counts.unsupportedFaultEvents).toBe(
          input.events.filter((event, index) => flags[index] && event.fault !== 'none').length,
        );
        expect(JSON.stringify(rows)).toBe(before);
        expect(result.decision).toBe('HOLD');
      }),
      {numRuns: 30},
    );
  });
});

it('counts unstarted planned repetitions and labels a legacy schedule unknown', async () => {
  const input = await corpus();
  const event = input.events[0];
  const row = topicStudyLedgerRowV1({
    corpusHash: topicStudyCorpusHashV1(input),
    runNonce: 'early-stop',
    arm: 'scripted-manual',
    repetition: 1,
    eventIndex: 1,
    eventId: event.id,
    previousHash: null,
    observation: topicStudyUnavailableObservationV1(event, 'stopped'),
  });
  const gate = {
    realTopicPilotObserved: false,
    alternatePermittedAndMeasured: false,
    pairedHumanMedianReduction: null,
    totalCostMeasured: false,
    disagreementsAdjudicated: false,
    downstreamNoRegression: null,
  };
  const known = summarizeTopicStudyV1([row], input, gate, 2);
  expect(known.denominators.plannedEvents).toBe(400);
  expect(known.denominators.minimumEventsFromObservedRepetitions).toBe(200);
  expect(known.denominators.allSlotProbePlanned).toBe(
    input.events.reduce((total, item) => total + item.probes.length, 0) * 8,
  );
  expect(known.denominators.unrecordedSlotProbePlanned).toBe(
    known.denominators.allSlotProbePlanned! - event.probes.length,
  );
  const legacy = summarizeTopicStudyV1([row], input, gate);
  expect(legacy.denominators.plannedEvents).toBeNull();
  expect(legacy.denominators.allSlotProbePlanned).toBeNull();
  expect(legacy.denominators.unrecordedSlotProbePlanned).toBeNull();
  expect(legacy.reasons).toContain('planned repetition schedule unverified');
  expect(legacy.decision).toBe('HOLD');
  expect(() => summarizeTopicStudyV1([row], input, gate, 0)).toThrow('planned repetitions');
});
