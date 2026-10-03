import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  sharedMaintenanceOwnerProposal,
  withMaintenancePacketRevision,
} from '../../src/memory/context/maintenance_packet.js';

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
  it('binds exact shared canonical edits and base without mutating or exporting personal bodies', () => {
    const original = record.content;
    const base = {commit: 'a'.repeat(40), repositoryId: 'b'.repeat(64)};
    const proposal = sharedMaintenanceOwnerProposal(record, [record], base);
    expect(proposal.readOnly).toBe(true);
    expect(proposal.selectedEdits).toEqual([
      {
        operation: 'remove-relation',
        relation: {type: 'depends_on', uri: target},
        reason: 'target-unresolved-in-readable-corpus',
      },
    ]);
    expect(proposal.sharedBase).toEqual({state: 'available', ...base});
    expect(proposal.proposalRevision).not.toBe(
      sharedMaintenanceOwnerProposal(record, [record], {...base, commit: 'c'.repeat(40)}).proposalRevision,
    );
    expect(JSON.stringify(proposal)).not.toContain('Preserve the original claim.');
    expect(record.content).toBe(original);
    expect(proposal.publication.operations).toContain('share_propose');
  });
});
