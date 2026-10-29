import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  sharedMaintenanceOwnerProposal,
  withMaintenancePacketRevision,
} from '../../src/memory/context/maintenance_packet.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const uri = 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/source.md';
const target = 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/missing.md';
const record = parseMemoryDocument(
  uri,
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      schemaVersion: 2,
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-10-03T12:00:00.000Z',
      relations: [{type: 'depends_on', uri: target}],
    },
    'Preserve the original claim.',
  ),
)!;

describe('revision-bound maintenance packets', () => {
  effectIt.effect('rejects changed revision after an asynchronous evidence read', () =>
    Effect.gen(function* () {
      let revision = 'first';
      const assertCurrent = Effect.suspend(() => (revision === 'first' ? Effect.void : Effect.fail('stale')));
      const read = Effect.yieldNow.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            revision = 'second';
          }),
        ),
        Effect.as('evidence'),
      );
      const result = yield* withMaintenancePacketRevision(assertCurrent, read).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBe('stale');
    }),
  );
  effectIt.effect('does not read source when the initial revision is stale', () =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withMaintenancePacketRevision(
        Effect.fail('stale'),
        Effect.sync(() => {
          reads += 1;
        }),
      ).pipe(Effect.result);
      expect(reads).toBe(0);
    }),
  );
  it('binds the exact shared subject and base without mutating or exporting personal bodies', () => {
    const original = record.content;
    const base = {
      commit: Effect2.pipe('a', EffectString.repeat(40)),
      repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    };
    const proposal = sharedMaintenanceOwnerProposal(record, base);
    expect(proposal.readOnly).toBe(true);
    expect(proposal.selectedEdits).toEqual([]);
    expect(proposal.evidence).toEqual({
      completeness: 'unknown',
      provenance: 'unobserved-relation-targets',
      supportsAbsence: false,
    });
    expect(proposal.sharedBase).toEqual({state: 'available', ...base});
    expect(proposal.proposalRevision).not.toBe(
      sharedMaintenanceOwnerProposal(record, {...base, commit: Effect2.pipe('c', EffectString.repeat(40))})
        .proposalRevision,
    );
    expect(JSON.stringify(proposal)).not.toContain('Preserve the original claim.');
    expect(record.content).toBe(original);
    expect(proposal.publication.operations).toContain('share_propose');
  });
  it('never infers removal from unobserved relations and conserves arbitrary canonical content', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom('references' as const, 'depends_on' as const),
            uri: fc.constantFrom(target, 'threadnote://memory/tn_target'),
          }),
          {maxLength: 40},
        ),
        fc.string({maxLength: 100}),
        (relations, body) => {
          const subject = parseMemoryDocument(
            uri,
            formatMemoryDocument('MEMORY', {...record.metadata, relations}, body),
          )!;
          const before = structuredClone(subject);
          const proposal = sharedMaintenanceOwnerProposal(subject);
          expect(proposal.selectedEdits).toEqual([]);
          expect(proposal.omittedEdits).toBe(0);
          expect(proposal.evidence.supportsAbsence).toBe(false);
          expect(sharedMaintenanceOwnerProposal(subject)).toEqual(proposal);
          expect(subject).toEqual(before);
        },
      ),
      {numRuns: 32},
    );
  });
});
