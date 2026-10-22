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
import {compactAutomaticTopicDraftFixture, makeTopicDraftWireBasis} from '../helpers/topic-draft-wire.js';

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
  it('cannot rewrite or invent support for a protected ordinal under arbitrary model decisions', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 16}),
        fc.nat({max: 1000}),
        fc.constantFrom('normative' as const, 'historical' as const),
        fc.boolean(),
        (count, selection, role, reverse) => {
          const {basis, wire} = fixture(count, 3);
          const ordinal = selection % count;
          const paragraphs = basis.paragraphs.map(p => (p.ordinal === ordinal ? {...p, role} : p));
          const protectedBasis = validateAutomaticMaintenanceDraftBasis({
            ...basis,
            paragraphs,
            handles: reverse ? [...basis.handles].reverse() : basis.handles,
            assessment: {...basis.assessment, paragraphs},
          });
          const safe = {
            ...wire,
            outcome: 'insufficient-evidence',
            operations: [],
            paragraphDecisions: wire.paragraphDecisions.map((p, i) =>
              i === ordinal ? {...p, role, support: 'unresolved', evidenceIndices: []} : p,
            ),
          };
          const before = JSON.stringify(protectedBasis);
          const canonical = decodeTopicDraftWire(protectedBasis, safe);
          expect(parseAutomaticMaintenanceDraft(protectedBasis, JSON.stringify(canonical)).body).toBe(basis.body);
          const changed = (decision: Record<string, unknown>) => ({
            ...safe,
            paragraphDecisions: safe.paragraphDecisions.map((p, i) => (i === ordinal ? {...p, ...decision} : p)),
          });
          for (const bad of [
            changed({role: 'descriptive'}),
            changed({support: 'direct', evidenceIndices: wire.paragraphDecisions[ordinal].evidenceIndices}),
            changed({support: 'contextual', evidenceIndices: wire.paragraphDecisions[ordinal].evidenceIndices}),
            {...safe, outcome: 'propose-update', operations: [{...wire.operations[0], ordinal}]},
          ]) {
            expect(() => Schema.decodeUnknownSync(topicDraftModelSchema(protectedBasis))(bad)).toThrow();
            expect(() => decodeTopicDraftProviderWire(protectedBasis, bad)).toThrow();
            expect(() => decodeTopicDraftWire(protectedBasis, bad)).toThrow();
          }
          expect(JSON.stringify(protectedBasis)).toBe(before);
        },
      ),
      {numRuns: 35, seed: 61102},
    );
  });

  it('permits only the exact frozen current support mapping for a protected paragraph', () => {
    const {basis, wire} = fixture(1, 3);
    const id = basis.assessment.evidence[0].id;
    const paragraphs = basis.paragraphs.map(p => ({
      ...p,
      role: 'historical' as const,
      support: 'contextual' as const,
      currentEvidenceIds: [id],
      currentSupport: 'contextual' as const,
    }));
    const protectedBasis = validateAutomaticMaintenanceDraftBasis({
      ...basis,
      paragraphs,
      assessment: {...basis.assessment, paragraphs},
      handles: [...basis.handles, {id: `current:${id}`, citationId: id, variant: 'current'}],
    });
    const indices = automaticTopicDraftIndexTables(protectedBasis);
    const supported = {
      ...wire,
      outcome: 'propose-revalidation',
      operations: [],
      paragraphDecisions: [
        {ordinal: 0, role: 'historical', support: 'contextual', evidenceIndices: [indices.evidenceIds.indexOf(id)]},
      ],
      currentSourceIndices: [indices.currentHandles.indexOf(`current:${id}`)],
    };
    expect(
      parseAutomaticMaintenanceDraft(protectedBasis, JSON.stringify(decodeTopicDraftWire(protectedBasis, supported)))
        .body,
    ).toBe(basis.body);
    expect(() =>
      decodeTopicDraftWire(protectedBasis, {
        ...supported,
        paragraphDecisions: [{...supported.paragraphDecisions[0], support: 'direct'}],
      }),
    ).toThrow();
    expect(() =>
      decodeTopicDraftWire(protectedBasis, {
        ...supported,
        paragraphDecisions: [
          {...supported.paragraphDecisions[0], evidenceIndices: wire.paragraphDecisions[0].evidenceIndices},
        ],
      }),
    ).toThrow();
  });

  it('hydrates independent canonical decisions without mutation, including permutations and separate namespaces', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 64}),
        fc.integer({min: 1, max: 8}),
        fc.boolean(),
        fc.nat({max: 1024}),
        fc.constantFrom('direct' as const, 'contextual' as const, 'unresolved' as const),
        (count, sources, reverse, selection, otherSupport) => {
          const {basis, draft: initial} = fixture(count, sources);
          const ordinal = selection % count;
          const current = basis.handles.filter(handle => handle.variant === 'current');
          const draft: AutomaticMaintenanceDraftV2 = {
            ...initial,
            paragraphDecisions: initial.paragraphDecisions.map((decision, index) => ({
              ...decision,
              support: index === ordinal ? 'direct' : otherSupport,
              evidenceIds:
                index !== ordinal && otherSupport === 'unresolved'
                  ? []
                  : [current[(selection + index) % sources].citationId],
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

  it('refuses empty direct/contextual decisions and operation support without filling selections', () => {
    const {basis, wire} = fixture(1, 2);
    const decision = wire.paragraphDecisions[0];
    for (const support of ['direct', 'contextual'] as const) {
      expect(() =>
        decodeTopicDraftProviderWire(basis, {
          ...wire,
          paragraphDecisions: [{...decision, support, evidenceIndices: []}],
        }),
      ).toThrow();
    }
    expect(() =>
      decodeTopicDraftProviderWire(basis, {
        ...wire,
        operations: [{...wire.operations[0], supportIndices: []}],
      }),
    ).toThrow();
    expect(() =>
      decodeTopicDraftProviderWire(basis, {
        ...wire,
        paragraphDecisions: [{...decision, support: 'unresolved'}],
      }),
    ).toThrow();
    for (const support of ['contextual', 'unresolved'] as const) {
      const evidenceIndices = support === 'unresolved' ? [] : decision.evidenceIndices;
      const proposal = decodeTopicDraftWire(basis, {
        ...wire,
        outcome: 'insufficient-evidence',
        paragraphDecisions: [{...decision, support, evidenceIndices}],
        operations: [],
        currentSourceIndices: [],
      });
      expect(parseAutomaticMaintenanceDraft(basis, JSON.stringify(proposal)).body).toBe(basis.body);
    }
  });

  it('exports disjoint support cardinalities for every native ordinal and closes empty namespaces', () => {
    type Field = {
      enum?: readonly unknown[];
      minItems?: number;
      maxItems?: number;
      properties?: Record<string, Field>;
      items?: Field;
      oneOf?: readonly Field[];
    };
    for (const count of [1, 3, 64]) {
      for (const sources of [0, 1, 3]) {
        const {basis} = fixture(count, sources);
        const native = topicDraftNativeJsonSchema(topicDraftModelSchema(basis), basis) as Field;
        const fields = native.properties!;
        const order = Object.keys(fields);
        expect(order.indexOf('rationale')).toBeLessThan(order.indexOf('unresolvedQuestions'));
        expect(order.indexOf('unresolvedQuestions')).toBeLessThan(order.indexOf('paragraphDecisions'));
        expect(order.indexOf('paragraphDecisions')).toBeLessThan(order.indexOf('outcome'));
        expect(order.indexOf('outcome')).toBeLessThan(order.indexOf('operations'));
        const decisions = fields.paragraphDecisions.items!;
        const variants = decisions.oneOf ?? [decisions];
        expect(variants).toHaveLength(count * (sources ? 3 : 1));
        const tags = variants.map(variant => {
          const p = variant.properties!;
          const support = p.support.enum![0];
          expect(p.evidenceIndices.minItems ?? 0).toBe(support === 'unresolved' ? 0 : 1);
          expect(p.evidenceIndices.maxItems).toBe(support === 'unresolved' ? 0 : Math.min(8, sources * 2));
          return `${p.ordinal.enum![0]}:${support}`;
        });
        expect(new Set(tags).size).toBe(variants.length);
        expect(fields.operations.maxItems).toBe(sources ? count : 0);
        const operations = fields.operations.items!;
        for (const operation of operations.oneOf ?? [operations])
          expect(operation.properties!.supportIndices.minItems ?? 0).toBe(sources ? 1 : 0);
      }
    }
  });

  it('preserves selective reviewed-current indices while retaining revalidation requirements', () => {
    const {basis, wire} = fixture(1, 3);
    for (const currentSourceIndices of [[], wire.currentSourceIndices]) {
      const proposal = decodeTopicDraftWire(basis, {...wire, currentSourceIndices});
      expect(parseAutomaticMaintenanceDraft(basis, JSON.stringify(proposal)).changedOrdinals).toEqual([0]);
    }
    const revalidation = decodeTopicDraftWire(basis, {
      ...wire,
      outcome: 'propose-revalidation',
      operations: [],
      currentSourceIndices: [],
    });
    expect(() => parseAutomaticMaintenanceDraft(basis, JSON.stringify(revalidation))).toThrow(
      'outcome differs from its operations',
    );
  });

  it('retains exact frozen legacy native schema projections', () => {
    const cases = [
      {count: 1, sourceCount: 1, expected: 'e9228a84f4ea4476ba1a50fe80d935440b1e15cf41ad4b70e0429583c76b8a10'},
      {
        count: 3,
        sourceCount: 2,
        protectedOrdinal: 2,
        expected: 'b8de46fd722e348dd2391185442b0f90da02d4db60231affcf67d470aeb3cab5',
      },
      {
        count: 64,
        sourceCount: 8,
        protectedOrdinal: 63,
        expected: '0df15b978e862284f4446fbbe465c57296d1f130e80281cfd9ee8cac76eee558',
      },
    ];
    for (const spec of cases) {
      const basis = makeTopicDraftWireBasis(spec.count, spec);
      expect(hash(JSON.stringify(topicDraftNativeJsonSchema(topicDraftModelSchema(basis), basis)))).toBe(spec.expected);
    }
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
      if (role === 'unknown') {
        expect(() => decodeTopicDraftWire(protectedBasis, wire)).not.toThrow();
        expect(() => parseAutomaticMaintenanceDraft(protectedBasis, JSON.stringify(fixture().draft))).not.toThrow();
      } else {
        expect(() => decodeTopicDraftWire(protectedBasis, wire)).toThrow();
        // Public authored canonical V2 still reaches the unchanged final memory-owned guard.
        expect(() => parseAutomaticMaintenanceDraft(protectedBasis, JSON.stringify(fixture().draft))).toThrow(
          'protected approved role',
        );
      }
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
    expect(() => decodeTopicDraftWire(reviewed, wire)).toThrow();
    expect(() => parseAutomaticMaintenanceDraft(reviewed, JSON.stringify(fixture().draft))).toThrow(
      'protected approved role',
    );
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
