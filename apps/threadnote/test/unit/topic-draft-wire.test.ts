import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Schema} from 'effect';
import {
  parseTopicMaintenanceDraft,
  type TopicMaintenanceDraftBasisV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  decodeTopicDraftModelOutput,
  topicDraftCurrentSourceHandles,
  topicDraftModelSchema,
  topicDraftNativeJsonSchema,
} from '../../src/manager/topic_draft_schema.js';
import {topicMaintenanceDraftPrompt} from '../../src/memory/context/maintenance_draft.js';
import {TOPIC_DRAFT_PROMPT_VERSION} from '../../src/manager/selected_draft.js';

import {
  makeTopicDraftWireBasis as basisFor,
  makeTopicDraftWireFixture as wireFor,
} from '../helpers/topic-draft-wire.js';

function canonical(basis: TopicMaintenanceDraftBasisV1, wire: unknown) {
  return parseTopicMaintenanceDraft(basis, JSON.stringify(decodeTopicDraftModelOutput(basis, wire)), {
    requireParagraphDispositions: true,
  });
}

describe('v6 compact paragraph disposition wire', () => {
  it('hydrates 64 explicit decisions in wire order without changing basis or wire', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 64}),
        fc.shuffledSubarray([0, 1, 2], {minLength: 1, maxLength: 3}),
        fc.boolean(),
        (count, indices, reverse) => {
          const original = basisFor(count);
          const current = original.handles.filter(handle => handle.variant === 'current');
          const basis = {
            ...original,
            handles: [...current]
              .reverse()
              .flatMap(handle => [
                handle,
                original.handles.find(item => item.id === `historical:${handle.citationId}`)!,
              ]),
          };
          const wire = wireFor(basis);
          for (const entry of wire.decision.paragraphDispositions.entries) entry.sourceIndices = [...indices];
          if (reverse) wire.decision.paragraphDispositions.entries.reverse();
          const before = JSON.stringify({basis, wire});
          const result = canonical(basis, wire);
          expect(result.draft.paragraphDispositions?.entries).toEqual(
            wire.decision.paragraphDispositions.entries.map(entry => ({
              ordinal: entry.ordinal,
              beforeHash: basis.paragraphs[entry.ordinal].hash,
              disposition: entry.disposition,
              supportHandles: indices.map(index => current[current.length - 1 - index].id),
              rationale: entry.rationale,
            })),
          );
          expect(JSON.stringify({basis, wire})).toBe(before);
        },
      ),
      {numRuns: 32},
    );
    for (const count of [1, 8, 16, 32, 64])
      for (const sourceCount of [1, 8])
        for (const disposition of ['revalidate', 'unresolved'] as const) {
          const basis = basisFor(count, {sourceCount});
          const wire = wireFor(basis, disposition);
          expect(canonical(basis, wire).draft.paragraphDispositions?.entries).toHaveLength(count);
          expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThan(32 * 1024);
        }
  });

  it('keeps the native model schema closed and operations fully bound', () => {
    const basis = basisFor(2);
    const schema = topicDraftNativeJsonSchema(topicDraftModelSchema(basis));
    const variant =
      schema.properties.decision.oneOf[0].properties.paragraphDispositions.properties.entries.items.oneOf[0];
    expect(variant.required).toEqual(['ordinal', 'disposition', 'sourceIndices', 'rationale']);
    expect(variant.additionalProperties).toBe(false);
    expect(variant.properties).not.toHaveProperty('beforeHash');
    expect(variant.properties).not.toHaveProperty('supportHandles');
    const wire = wireFor(basis);
    wire.decision.outcome = 'propose-update';
    wire.decision.operations = [
      {
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        text: 'Updated claim.',
        supportHandles: [topicDraftCurrentSourceHandles(basis)[1]],
        rationale: 'Changed.',
      },
    ];
    wire.decision.paragraphDispositions.entries[0] = {
      ordinal: 0,
      disposition: 'update',
      sourceIndices: [1],
      rationale: 'Changed.',
    };
    expect(canonical(basis, wire).draft.operations).toEqual(wire.decision.operations);
    expect(JSON.stringify(schema)).not.toContain('"anyOf"');
  });

  it('rejects invalid indices and legacy/unknown model fields before hydration', () => {
    const basis = basisFor(1);
    for (const index of [-1, 3, 1.5, NaN]) {
      const wire = wireFor(basis);
      wire.decision.paragraphDispositions.entries[0].sourceIndices = [index];
      expect(() => decodeTopicDraftModelOutput(basis, wire)).toThrow();
    }
    fc.assert(
      fc.property(fc.integer({min: 1, max: 8}), fc.nat({max: 100}), (sourceCount, excess) => {
        const indexedBasis = basisFor(1, {sourceCount});
        for (const index of [sourceCount + excess, -1 - excess]) {
          const wire = wireFor(indexedBasis);
          wire.decision.paragraphDispositions.entries[0].sourceIndices = [index];
          expect(() => decodeTopicDraftModelOutput(indexedBasis, wire)).toThrow();
        }
      }),
      {numRuns: 24},
    );
    for (const extra of [
      {beforeHash: basis.paragraphs[0].hash},
      {supportHandles: [topicDraftCurrentSourceHandles(basis)[0]]},
      {unexpected: true},
    ]) {
      const wire = wireFor(basis);
      Object.assign(wire.decision.paragraphDispositions.entries[0], extra);
      expect(() => decodeTopicDraftModelOutput(basis, wire)).toThrow();
    }
  });

  it('preserves canonical missing/duplicate/protected/unsupported accounting rejection', () => {
    const basis = basisFor(2);
    const missing = wireFor(basis);
    missing.decision.paragraphDispositions.entries.pop();
    expect(() => canonical(basis, missing)).toThrow();
    const duplicate = wireFor(basis);
    duplicate.decision.paragraphDispositions.entries[1].ordinal = 0;
    expect(() => canonical(basis, duplicate)).toThrow();
    const protectedBasis = basisFor(2, {protectedOrdinal: 1});
    const protectedWire = wireFor(protectedBasis);
    protectedWire.decision.paragraphDispositions.entries[0].ordinal = 1;
    expect(() => canonical(protectedBasis, protectedWire)).toThrow();
    const empty = wireFor(basis);
    empty.decision.paragraphDispositions.entries[0].sourceIndices = [];
    expect(() => canonical(basis, empty)).toThrow();
    const repeated = wireFor(basis);
    repeated.decision.paragraphDispositions.entries[0].sourceIndices = [0, 0];
    expect(() => canonical(basis, repeated)).toThrow();
    const ids = basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.citationId);
    const unrelatedBasis = {
      ...basis,
      paragraphs: basis.paragraphs.map(paragraph => ({...paragraph, citationIds: [ids[paragraph.ordinal]]})),
      additionalDependencies: [{kind: 'dependency' as const, citationId: ids[2]}],
    };
    const unrelated = wireFor(unrelatedBasis);
    unrelated.decision.paragraphDispositions.entries[0].sourceIndices = [1];
    expect(() => canonical(unrelatedBasis, unrelated)).toThrow();
  });

  it('keeps unresolved decisions explicit and protected paragraphs absent', () => {
    const basis = basisFor(2, {protectedOrdinal: 1});
    const wire = wireFor(basis);
    wire.decision.outcome = 'insufficient-evidence';
    wire.decision.reviewedHandles = [];
    wire.decision.paragraphDispositions.entries[0] = {
      ordinal: 0,
      disposition: 'unresolved',
      sourceIndices: [],
      rationale: 'Manual review.',
    };
    const result = canonical(basis, wire);
    expect(result.body).toBe(basis.body);
    expect(result.draft.paragraphDispositions?.entries).toEqual([
      {
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        disposition: 'unresolved',
        supportHandles: [],
        rationale: 'Manual review.',
      },
    ]);
  });

  it('describes stable source indices near the input boundary without duplicating accepted prose', () => {
    const prose = 'Unique accepted claim. ' + 'x'.repeat(27 * 1024);
    const basis = basisFor(64, {firstParagraph: prose});
    const sources = basis.handles
      .filter(handle => handle.variant === 'current')
      .map(({citationId}, index) => ({
        citationId,
        oldExcerpt: {source: {path: `source-${index}.ts`}, content: 's'.repeat(900)},
        newExcerpt: {source: {path: `source-${index}.ts`}, content: 's'.repeat(900)},
      }));
    const packet = {
      coverage: 'declared-only',
      targetUri: basis.targetUri,
      additionalDependencies: [],
      sources: [...sources].reverse(),
    } as never;
    for (const error of [undefined, 'Invalid prior decision.']) {
      const prompt = topicMaintenanceDraftPrompt(packet, basis, error, '{invalid');
      expect(prompt.split(prose)).toHaveLength(2);
      expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(80 * 1024);
      expect(prompt).toContain('sourceIndices');
      expect(prompt).not.toContain('entries:[{ordinal,beforeHash');
      expect(
        JSON.parse(/^Packet: (.+)$/mu.exec(prompt)![1]).sources.map(
          (source: {sourceIndex: number}) => source.sourceIndex,
        ),
      ).toEqual([2, 1, 0]);
    }
    expect(TOPIC_DRAFT_PROMPT_VERSION).toBe('topic-maintenance-draft-v6');
    const wire = wireFor(basisFor(64));
    expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThan(32 * 1024);
    expect(() =>
      Schema.decodeUnknownSync(topicDraftModelSchema(basisFor(64)), {onExcessProperty: 'error'})(wire),
    ).not.toThrow();
  });
});
