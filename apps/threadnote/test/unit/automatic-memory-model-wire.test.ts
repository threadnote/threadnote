import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Effect, Result, Schema} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {runEffectAiTopicDraft} from '../../src/effect/ai/consolidator.js';
import {sha256HexSync as hash} from '@threadnote/platform/sha256';
import {
  automaticMaintenanceCapabilities,
  automaticMaintenanceEvidenceId,
  type AutomaticMaintenanceAssessmentV1,
  type AutomaticMaintenanceSourceV1,
} from '@threadnote/memory/automatic-maintenance';
import {
  parseAutomaticMaintenanceDraft,
  validateAutomaticMaintenanceDraftBasis,
  type AutomaticMaintenanceDraftBasisV3,
  type AutomaticMaintenanceDraftV2,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  automaticTopicDraftIndexTables,
  decodeTopicDraftProviderWire,
  decodeTopicDraftWire,
  topicDraftModelSchema,
  topicDraftNativeJsonSchema,
} from '../../src/manager/topic_draft_schema.js';
import {compactAutomaticTopicDraftFixture} from '../helpers/topic-draft-wire.js';

function fixture(count = 3, sources = 2) {
  const uri = 'threadnote://user/tester/memories/durable/projects/fixture/topic.md';
  const body = Array.from({length: count}, (_, index) => `Old fact ${index}.`).join('\n\n');
  const source = (index: number, variant: string): AutomaticMaintenanceSourceV1 => ({
    kind: 'memory',
    uri: uri.replace('topic.md', `source-${index}.md`),
    canonicalHash: hash(variant + index),
    fragment: {ordinal: 0, hash: hash(variant + index), startOffset: 0, endOffset: 12},
  });
  const old = Array.from({length: sources}, (_, index) => source(index, 'old'));
  const current = Array.from({length: sources}, (_, index) => automaticMaintenanceEvidenceId(source(index, 'new')));
  const target = {
    uri,
    kind: 'durable' as const,
    status: 'active' as const,
    canonicalHash: hash('target'),
    bodyHash: hash(body),
    paragraphCount: count,
    visibility: 'personal' as const,
    readOnly: false,
    artifact: false,
  };
  const paragraphs = body.split('\n\n').map((text, ordinal) => ({
    ordinal,
    hash: hash(text),
    role: 'unknown' as const,
    roleAuthority: 'provisional' as const,
    support: 'unresolved' as const,
    supportAuthority: 'provisional' as const,
    historicalEvidenceIds: [],
    acceptedEvidenceIds: [],
    currentEvidenceIds: [],
    currentSupport: 'unresolved' as const,
    currentSupportAuthority: 'provisional' as const,
  }));
  const evidence = old.map(source => ({
    id: automaticMaintenanceEvidenceId(source),
    source,
    scope: 'personal' as const,
    authority: 'provisional' as const,
    availability: 'available' as const,
  }));
  const coverage = {
    outcome: 'complete' as const,
    scope: 'bounded-search' as const,
    searchedScopes: ['fixture'],
    omittedSources: 0,
    omittedParagraphs: 0,
  };
  const assessment: AutomaticMaintenanceAssessmentV1 = {
    version: 1,
    preparation: {version: 1, kind: 'derived'},
    target,
    paragraphs,
    evidence,
    dependencies: [],
    coverage,
    capabilities: automaticMaintenanceCapabilities(target, paragraphs, evidence, coverage),
  };
  const basis = validateAutomaticMaintenanceDraftBasis({
    version: 3,
    kind: 'automatic',
    targetUri: uri,
    targetHash: target.canonicalHash,
    observationRevision: hash('observation'),
    packetDigest: hash('packet'),
    body,
    assessment,
    paragraphs,
    reads: [],
    scopeRevision: hash('scope'),
    additionalDependencies: [],
    handles: [
      ...evidence.map(entry => ({id: `accepted:${entry.id}`, citationId: entry.id, variant: 'accepted'})),
      ...current.map(id => ({id: `current:${id}`, citationId: id, variant: 'current'})),
    ],
  });
  const selected = current[0];
  const draft: AutomaticMaintenanceDraftV2 = {
    version: 2,
    kind: 'automatic',
    purpose: 'automatic',
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    outcome: sources ? 'propose-update' : 'insufficient-evidence',
    paragraphDecisions: paragraphs.map(p => ({
      ordinal: p.ordinal,
      beforeHash: p.hash,
      role: sources ? 'descriptive' : 'unknown',
      support: sources ? 'direct' : 'unresolved',
      evidenceIds: sources ? [selected] : [],
    })),
    operations: sources
      ? [
          {
            ordinal: 0,
            beforeHash: paragraphs[0].hash,
            supportHandles: [`current:${selected}`],
            rationale: 'Exact new source.',
            text: 'New supported fact.',
          },
        ]
      : [],
    reviewedHandles: sources ? [`current:${selected}`] : [],
    rationale: 'Explicit full paragraph review.',
    unresolvedQuestions: [],
    removedClaims: [],
  };
  return {basis, draft, wire: compactAutomaticTopicDraftFixture(basis, draft)};
}

describe('automatic model-only compact transport', () => {
  it('hydrates independent canonical decisions without mutation, including permutations and separate namespaces', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 64}),
        fc.integer({min: 1, max: 8}),
        fc.boolean(),
        fc.nat({max: 1024}),
        (count, sources, reverse, selection) => {
          const {basis, draft: initial} = fixture(count, sources);
          const ordinal = selection % count;
          const current = basis.handles.filter(handle => handle.variant === 'current');
          const draft: AutomaticMaintenanceDraftV2 = {
            ...initial,
            paragraphDecisions: initial.paragraphDecisions.map((decision, index) => ({
              ...decision,
              evidenceIds: [current[(selection + index) % sources].citationId],
            })),
            operations: [
              {
                ...initial.operations[0],
                ordinal,
                beforeHash: basis.paragraphs[ordinal].hash,
                supportHandles: [current[(selection + ordinal) % sources].id],
              },
            ],
          };
          const wire = compactAutomaticTopicDraftFixture(basis, draft);
          const before = JSON.stringify({basis, wire});
          const tables = automaticTopicDraftIndexTables(basis);
          expect(tables.evidenceIds).toEqual(
            [...new Set([...basis.assessment.evidence.map(e => e.id), ...basis.handles.map(h => h.citationId)])].sort(),
          );
          expect(tables.currentHandles).toEqual(
            basis.handles
              .filter(h => h.variant === 'current')
              .map(h => h.id)
              .sort(),
          );
          const permuted: AutomaticMaintenanceDraftBasisV3 = {
            ...basis,
            handles: reverse ? [...basis.handles].reverse() : [...basis.handles],
            assessment: {...basis.assessment, evidence: [...basis.assessment.evidence].reverse()},
          };
          expect(automaticTopicDraftIndexTables(permuted)).toEqual(tables);
          expect(decodeTopicDraftWire(permuted, wire)).toEqual(draft);
          expect(decodeTopicDraftProviderWire(basis, wire)).toEqual(wire);
          expect(parseAutomaticMaintenanceDraft(basis, JSON.stringify(draft)).body).toBe(
            basis.body
              .split('\n\n')
              .map((text, index) => (index === ordinal ? 'New supported fact.' : text))
              .join('\n\n'),
          );
          expect(JSON.stringify({basis, wire})).toBe(before);
        },
      ),
      {numRuns: 40, seed: 60106},
    );
  });

  it('never treats the admitted-evidence and current-source indices as one namespace', () => {
    const {basis, wire} = fixture(1, 3);
    const tables = automaticTopicDraftIndexTables(basis);
    const index = tables.currentHandles.findIndex((handle, i) => handle !== `current:${tables.evidenceIds[i]}`);
    expect(index).toBeGreaterThanOrEqual(0);
    const decoded = decodeTopicDraftWire(basis, {
      ...wire,
      paragraphDecisions: [{...wire.paragraphDecisions[0], evidenceIndices: [index]}],
      operations: [{...wire.operations[0], supportIndices: [index]}],
    });
    expect(decoded.operations[0].supportHandles).toEqual([tables.currentHandles[index]]);
    expect(decoded.paragraphDecisions[0].evidenceIds).toEqual([tables.evidenceIds[index]]);
    expect(() => parseAutomaticMaintenanceDraft(basis, JSON.stringify(decoded))).toThrow();
  });

  it('closes empty namespaces and singleton duplicates in both schema and terminal decoding', () => {
    for (const sources of [0, 1, 3]) {
      const {basis, wire} = fixture(1, sources);
      const decode = (input: unknown) => decodeTopicDraftWire(basis, input);
      expect(() => decode(wire)).not.toThrow();
      expect(() => topicDraftNativeJsonSchema(topicDraftModelSchema(basis), basis)).not.toThrow();
      const decisions = {
        ...wire,
        paragraphDecisions: [{...wire.paragraphDecisions[0], evidenceIndices: sources ? [0, 0] : [0]}],
      };
      expect(() => decode(decisions)).toThrow();
      expect(() => decode({...wire, currentSourceIndices: sources ? [0, 0] : [0]})).toThrow();
      expect(() =>
        decode({
          ...wire,
          operations: [{ordinal: 0, supportIndices: sources ? [0, 0] : [0], rationale: 'Check.', text: 'New.'}],
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeSync(topicDraftModelSchema(basis))(sources ? {...wire, currentSourceIndices: [999]} : decisions),
      ).toThrow();
    }
  });

  it('retains the unchanged 32 KiB canonical preflight after compact hydration', () => {
    const {basis, draft} = fixture(64, 8);
    const all = basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.citationId);
    const wire = compactAutomaticTopicDraftFixture(basis, {
      ...draft,
      paragraphDecisions: draft.paragraphDecisions.map(decision => ({...decision, evidenceIds: all})),
    });
    expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThan(32 * 1024);
    expect(() => decodeTopicDraftProviderWire(basis, wire)).not.toThrow();
    expect(() => decodeTopicDraftWire(basis, wire)).toThrow();
  });

  it('refuses missing, duplicate, reordered, excess and unbound decisions without accepting canonical provider alternatives', () => {
    const {basis, wire, draft} = fixture();
    const decisions = wire.paragraphDecisions;
    for (const input of [
      draft,
      {...wire, targetHash: hash('wrong')},
      {...wire, observationRevision: hash('wrong')},
      {...wire, packetDigest: hash('wrong')},
      {...wire, extra: true},
      {...wire, paragraphDecisions: decisions.slice(1)},
      {...wire, paragraphDecisions: [decisions[0], decisions[0], decisions[2]]},
      {...wire, paragraphDecisions: [...decisions].reverse()},
      {...wire, paragraphDecisions: [{...decisions[0], beforeHash: basis.paragraphs[0].hash}, ...decisions.slice(1)]},
      {...wire, operations: [...wire.operations, ...wire.operations]},
      {...wire, operations: [{...wire.operations[0], beforeHash: hash('invented')}]},
      ...[-1, 0.5, 999, '0'].map(index => ({...wire, currentSourceIndices: [index]})),
    ])
      expect(() => decodeTopicDraftWire(basis, input)).toThrow();
    expect(() => decodeTopicDraftProviderWire(basis, draft)).toThrow();
    expect(() => parseAutomaticMaintenanceDraft(basis, JSON.stringify(draft))).not.toThrow();
  });

  it('keeps unsafe text/bounds terminal and protected-role/application checks under the memory owner', () => {
    const {basis, wire} = fixture();
    for (const text of ['\ud800', 'New.\n\nAnother.', 'x'.repeat(32 * 1024)]) {
      expect(() => decodeTopicDraftWire(basis, {...wire, operations: [{...wire.operations[0], text}]})).toThrow();
    }
    expect(() => decodeTopicDraftWire(basis, {...wire, rationale: 'x'.repeat(2049)})).toThrow();
    for (const role of ['normative', 'historical', 'unknown'] as const) {
      const paragraphs = basis.paragraphs.map(p => ({...p, role}));
      const protectedBasis = validateAutomaticMaintenanceDraftBasis({
        ...basis,
        paragraphs,
        assessment: {...basis.assessment, paragraphs},
      });
      const proposed = decodeTopicDraftWire(protectedBasis, wire);
      if (role === 'unknown')
        expect(() => parseAutomaticMaintenanceDraft(protectedBasis, JSON.stringify(proposed))).not.toThrow();
      else
        expect(() => parseAutomaticMaintenanceDraft(protectedBasis, JSON.stringify(proposed))).toThrow(
          'protected approved role',
        );
    }
  });
  it('preserves established reviewed unknown roles during model hydration and application', () => {
    const {basis, wire} = fixture();
    const paragraphs = basis.paragraphs.map(paragraph => ({
      ...paragraph,
      roleAuthority: 'reviewed',
      supportAuthority: 'reviewed',
    }));
    const reviewed = validateAutomaticMaintenanceDraftBasis({
      ...basis,
      paragraphs,
      assessment: {
        ...basis.assessment,
        version: 2,
        preparation: {version: 2, kind: 'reviewed-support', supportDigest: hash('support')},
        paragraphs,
      },
    });
    const proposed = decodeTopicDraftWire(reviewed, wire);
    expect(() => parseAutomaticMaintenanceDraft(reviewed, JSON.stringify(proposed))).toThrow('protected approved role');
  });

  for (const scenario of [
    'accepted',
    'malformed-json',
    'shape-invalid',
    'excess-field',
    'preflight-invalid',
  ] as const) {
    effectIt.effect(`retains real remote compact output and measured usage: ${scenario}`, () =>
      Effect.gen(function* () {
        const {basis, wire} = fixture(2, 3);
        const output =
          scenario === 'excess-field'
            ? {...wire, beforeHash: hash('excess')}
            : scenario === 'preflight-invalid'
              ? {...wire, currentSourceIndices: [0, 0]}
              : scenario === 'shape-invalid'
                ? {...wire, targetHash: hash('wrong')}
                : wire;
        const responseText = scenario === 'malformed-json' ? '{invalid-json' : JSON.stringify(output);
        let calls = 0;
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              hostname: '127.0.0.1',
              fetch: async request => {
                calls++;
                const body = await request.json();
                expect(body.max_tokens).toBe(4000);
                expect(body.response_format.json_schema.schema.properties.kind).toMatchObject({
                  enum: ['automatic-model'],
                });
                return Response.json({
                  id: 'chatcmpl-compact-test',
                  object: 'chat.completion',
                  created: 1,
                  model: 'compact-test',
                  choices: [{index: 0, message: {role: 'assistant', content: responseText}, finish_reason: 'stop'}],
                  usage: {prompt_tokens: 17, completion_tokens: 19, total_tokens: 36},
                });
              },
            }),
          ),
          server => Effect.promise(() => server.stop(true)),
        );
        const result = yield* runEffectAiTopicDraft(
          'Return the bounded object.',
          {
            apiUrl: `http://127.0.0.1:${server.port}/v1`,
            model: 'compact-test',
          },
          topicDraftModelSchema(basis),
          basis,
        ).pipe(Effect.result);
        expect(calls).toBe(1);
        if (scenario === 'accepted') {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isFailure(result)) return;
          expect(JSON.parse(result.success.text)).toEqual(wire);
          expect(result.success.text).not.toContain('beforeHash');
          expect(result.success.usage).toEqual({status: 'measured', inputTokens: 17, outputTokens: 19});
          expect(result.success.outputRepresentation).toBe('decoded-json');
        } else {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isSuccess(result)) return;
          expect(result.failure).toMatchObject({
            _tag: 'TopicDraftProviderOutputError',
            usage:
              scenario === 'malformed-json' || scenario === 'shape-invalid'
                ? {status: 'unavailable'}
                : {status: 'measured', inputTokens: 17, outputTokens: 19},
            output: {
              text: responseText,
              representation:
                scenario === 'malformed-json' || scenario === 'shape-invalid' ? 'provider-text' : 'decoded-json',
            },
          });
        }
      }).pipe(TestClock.withLive),
    );
  }
});
