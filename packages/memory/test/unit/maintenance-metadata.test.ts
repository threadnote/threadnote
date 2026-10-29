import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {applyMaintenanceMetadataV1, previewMaintenanceMetadataV1} from '@threadnote/memory/maintenance/metadata';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const URI = 'threadnote://user/test/memories/durable/projects/threadnote/topic.md';
const NOW = '2026-09-18T12:00:00.000Z';

describe('maintenance metadata proposals', () => {
  it('upgrades a v4 schema header before applying owner and review_after', () => {
    const source = record({
      owner: 'legacy-owner',
      reviewAfter: '2026-10-01',
      schemaVersion: 4,
    });
    const preview = previewMaintenanceMetadataV1([source], URI, {
      owner: 'maintainer',
      reviewAfter: '2026-12-01',
    });
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('expected preview');
    expect(preview.proposal.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    const applied = applyMaintenanceMetadataV1({
      approved: true,
      expectedContentHash: preview.proposal.expectedContentHash,
      expectedRevision: preview.proposal.revision,
      proposal: preview.proposal,
      record: source,
      updatedAt: NOW,
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected apply');
    expect(applied.content).toContain(`schema_version: ${MEMORY_SCHEMA_VERSION}`);
    expect(applied.content).not.toContain('schema_version: 4');
    const updated = parseMemoryDocument(URI, applied.content)!;
    expect(updated.metadata.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(updated.metadata.owner).toBe('maintainer');
    expect(updated.metadata.reviewAfter).toBe('2026-12-01');
  });

  it('strips a legacy v4 MEMORY_FIELDS trailer while upgrading the schema', () => {
    const source = record({schemaVersion: 4}, URI, 'Legacy body.\nSecond line.');
    const withLegacyTrailer = parseMemoryDocument(
      URI,
      `${source.content}\n\n<!-- MEMORY_FIELDS\nsource_hash: legacy\n-->`,
    )!;
    const preview = previewMaintenanceMetadataV1([withLegacyTrailer], URI, {owner: 'maintainer'});
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('expected preview');
    const applied = applyMaintenanceMetadataV1({
      approved: true,
      expectedContentHash: preview.proposal.expectedContentHash,
      expectedRevision: preview.proposal.revision,
      proposal: preview.proposal,
      record: withLegacyTrailer,
      updatedAt: NOW,
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected apply');
    expect(applied.content).toContain(`schema_version: ${MEMORY_SCHEMA_VERSION}`);
    expect(applied.content).not.toContain('schema_version: 4');
    expect(applied.content).not.toContain('<!-- MEMORY_FIELDS');
    const updated = parseMemoryDocument(URI, applied.content)!;
    expect(updated.body).toBe(withLegacyTrailer.body);
    expect(updated.metadata.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
  });

  it('sets, clears, and preserves independently without changing body or unrelated headers', () => {
    const source = record({owner: 'old', reviewAfter: '2026-10-01T00:00:00.000Z', validTo: '2026-11-01T00:00:00.000Z'});
    const original = `${source.content}\nunknown_header: preserved`;
    const target = parseMemoryDocument(URI, original)!;
    const preview = previewMaintenanceMetadataV1([target], URI, {
      owner: null,
      reviewAfter: '2026-12-01',
    });
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('expected preview');
    const applied = applyMaintenanceMetadataV1({
      approved: true,
      expectedContentHash: preview.proposal.expectedContentHash,
      expectedRevision: preview.proposal.revision,
      proposal: preview.proposal,
      record: target,
      updatedAt: NOW,
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected apply');
    const updated = parseMemoryDocument(URI, applied.content)!;
    expect(updated.body).toBe(target.body);
    expect(updated.metadata.owner).toBeUndefined();
    expect(updated.content).toContain('review_after: 2026-12-01');
    expect(updated.content).toContain('valid_to: 2026-11-01T00:00:00.000Z');
    expect(updated.content).toContain('unknown_header: preserved');
    expect(updated.metadata.memoryId).toBe('tn_topic');
    expect(updated.metadata.relations).toEqual(target.metadata.relations);
  });

  it('fails closed for stale content, shared targets, invalid data, and ambiguous stable IDs', () => {
    const source = record();
    const preview = previewMaintenanceMetadataV1([source], URI, {owner: 'maintainer'});
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('expected preview');
    expect(
      applyMaintenanceMetadataV1({
        approved: true,
        expectedContentHash: preview.proposal.expectedContentHash,
        expectedRevision: preview.proposal.revision,
        proposal: preview.proposal,
        record: record({}, URI, 'Changed body.'),
        updatedAt: NOW,
      }),
    ).toMatchObject({code: 'content-changed', status: 'conflict'});
    expect(previewMaintenanceMetadataV1([source], URI, {reviewAfter: '2026-02-30'})).toMatchObject({
      code: 'invalid-date',
      message: 'review_after must be an ISO calendar date or canonical ISO instant.',
    });
    expect(previewMaintenanceMetadataV1([source], URI, {validTo: '2026-10-01'})).toMatchObject({
      code: 'invalid-date',
      message: 'valid_to must be a canonical ISO instant.',
    });
    expect(previewMaintenanceMetadataV1([source], URI, {owner: 'token=super-secret'})).toMatchObject({
      code: 'invalid-owner',
    });
    const shared = record({}, 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/topic.md');
    expect(previewMaintenanceMetadataV1([shared], shared.uri, {owner: 'owner'})).toMatchObject({
      code: 'target-ineligible',
    });
    const duplicate = record({memoryId: 'tn_topic'}, Effect.pipe(URI, EffectString.replace('topic.md', 'second.md')));
    expect(
      previewMaintenanceMetadataV1([source, duplicate], 'threadnote://memory/tn_topic', {owner: 'owner'}),
    ).toMatchObject({
      code: 'ambiguous-identity',
    });
  });

  it('accepts valid calendar years 0000 and 0099 while rejecting invalid leap days', () => {
    const source = record();
    for (const reviewAfter of ['0000-02-29', '0099-12-31']) {
      expect(previewMaintenanceMetadataV1([source], URI, {reviewAfter})).toMatchObject({status: 'preview'});
    }
    for (const reviewAfter of ['0000-02-30', '0099-02-29', '0100-02-29']) {
      expect(previewMaintenanceMetadataV1([source], URI, {reviewAfter})).toMatchObject({
        code: 'invalid-date',
      });
    }
  });

  it('is deterministically previewed, idempotent after apply, and preserves unrelated metadata for bounded patches', () => {
    fc.assert(
      fc.property(
        fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,15}$/u), {nil: undefined}),
        fc.constantFrom<undefined | null | string>(undefined, null, '2026-12-01', '2026-12-01T00:00:00.000Z'),
        fc.constantFrom<undefined | null | string>(undefined, null, '2027-01-01T00:00:00.000Z'),
        (owner, reviewAfter, validTo) => {
          const source = record({
            owner: 'before',
            reviewAfter: '2026-10-01T00:00:00.000Z',
            validTo: '2026-11-01T00:00:00.000Z',
          });
          const patch = {owner, reviewAfter, validTo};
          const first = previewMaintenanceMetadataV1([source], URI, patch);
          const second = previewMaintenanceMetadataV1([source], URI, patch);
          expect(first).toEqual(second);
          if (first.status !== 'preview') return;
          const applied = applyMaintenanceMetadataV1({
            approved: true,
            expectedContentHash: first.proposal.expectedContentHash,
            expectedRevision: first.proposal.revision,
            proposal: first.proposal,
            record: source,
            updatedAt: NOW,
          });
          expect(applied.status).toBe('applied');
          if (applied.status !== 'applied') return;
          const after = parseMemoryDocument(URI, applied.content)!;
          expect(after.body).toBe(source.body);
          expect(after.metadata.memoryId).toBe(source.metadata.memoryId);
          expect(after.metadata.relations).toEqual(source.metadata.relations);
          expect(
            applyMaintenanceMetadataV1({
              approved: true,
              expectedContentHash: first.proposal.expectedContentHash,
              expectedRevision: first.proposal.revision,
              proposal: first.proposal,
              record: after,
              updatedAt: NOW,
            }),
          ).toMatchObject({status: 'already-applied'});
        },
      ),
      {numRuns: 60},
    );
  });

  it('upgrades bounded v4 proposals while preserving unrelated headers and body bytes (property)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,15}$/u),
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .,!?\n-]{0,47}$/u),
        fc.constantFrom('2026-12-01', '2026-12-01T00:00:00.000Z'),
        (headerValue, body, reviewAfter) => {
          const formatted = record({schemaVersion: 4}, URI, body).content;
          const target = parseMemoryDocument(
            URI,
            Effect.pipe(formatted, EffectString.replace('\n\n', `\nopaque_header: ${headerValue}\n\n`)),
          )!;
          const preview = previewMaintenanceMetadataV1([target], URI, {
            owner: 'maintainer',
            reviewAfter,
          });
          expect(preview.status).toBe('preview');
          if (preview.status !== 'preview') return;
          const applied = applyMaintenanceMetadataV1({
            approved: true,
            expectedContentHash: preview.proposal.expectedContentHash,
            expectedRevision: preview.proposal.revision,
            proposal: preview.proposal,
            record: target,
            updatedAt: NOW,
          });
          expect(applied.status).toBe('applied');
          if (applied.status !== 'applied') return;
          expect(applied.content).toContain(`opaque_header: ${headerValue}`);
          expect(applied.content).toContain(`schema_version: ${MEMORY_SCHEMA_VERSION}`);
          expect(applied.content).not.toContain('schema_version: 4');
          const updated = parseMemoryDocument(URI, applied.content)!;
          expect(updated.body).toBe(target.body);
          expect(updated.metadata.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
          expect(updated.metadata.owner).toBe('maintainer');
          expect(updated.metadata.reviewAfter).toBe(reviewAfter);
        },
      ),
      {numRuns: 40},
    );
  });
});

function record(overrides: Partial<MemoryMetadata> = {}, uri = URI, body = 'Body is preserved.'): MemoryRecord {
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: 'tn_topic',
    project: 'threadnote',
    relations: [{type: 'references', uri: 'threadnote://memory/tn_other'}],
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
  return parseMemoryDocument(uri, formatMemoryDocument('MEMORY', metadata, body))!;
}
