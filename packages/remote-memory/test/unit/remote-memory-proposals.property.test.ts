import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {MEMORY_RELATION_TYPES} from '@threadnote/memory/document';
import {
  durableProposalPayload,
  remoteDurableProposalRequestHash,
  remoteProposalReviewRequestHash,
  REMOTE_MEMORY_PROPOSAL_PAYLOAD_MAX_BYTES,
} from '@threadnote/remote-memory/proposals';
import {validatePortableSegment} from '@threadnote/store/resource-id';

const canonicalTopic = FC.stringMatching(/^[a-z]{1,12}$/u).filter(topic => {
  try {
    return validatePortableSegment(topic) === topic;
  } catch {
    return false;
  }
});

describe('remote durable proposal canonicalization', () => {
  it('keeps the request hash invariant under relation permutation', () => {
    const relation = FC.record({
      type: FC.constantFrom(...MEMORY_RELATION_TYPES),
      uri: canonicalTopic.map(topic => `threadnote://share/share-1/memories/durable/project/${topic}.md`),
    });
    FC.assert(
      FC.property(
        FC.uniqueArray(relation, {maxLength: 16, selector: value => `${value.type}\0${value.uri}`}),
        relations => {
          const input = {
            operationId: 'proposal-operation',
            payload: {project: 'project', relations, text: 'Candidate.', topic: 'candidate', version: 1 as const},
            principalId: 'principal-1',
            shareId: 'share-1',
            tenantId: 'tenant-1',
          };
          expect(remoteDurableProposalRequestHash(input)).toBe(
            remoteDurableProposalRequestHash({
              ...input,
              payload: {...input.payload, relations: [...relations].reverse()},
            }),
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('blocks sensitive content and oversized UTF-8 payloads before persistence', () => {
    const input = (text: string) => ({
      operationId: 'proposal-policy',
      project: 'project',
      text,
      topic: 'candidate',
      version: 1 as const,
    });
    expect(() => durableProposalPayload(input('Do not store sk-abcdefghijklmnop'))).toThrow(
      'blocked by credential policy',
    );
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    expect(() => durableProposalPayload(input('🦊'.repeat(REMOTE_MEMORY_PROPOSAL_PAYLOAD_MAX_BYTES / 2)))).toThrow(
      'exceeds the size limit',
    );
  });

  it('binds the exact workload attestation to review replay identity', () => {
    const input = {
      principal: {principalId: 'reviewer-1', shareId: 'share-1', tenantId: 'tenant-1'},
      review: {
        decision: 'approve' as const,
        operationId: 'review-operation',
        proposalId: 'proposal-1',
        revision: 'proposal-revision-1',
        version: 1 as const,
      },
    };
    expect(remoteProposalReviewRequestHash({...input, attestationId: 'attestation-1'})).not.toBe(
      remoteProposalReviewRequestHash({...input, attestationId: 'attestation-2'}),
    );
    expect(remoteProposalReviewRequestHash(input)).not.toBe(
      remoteProposalReviewRequestHash({...input, attestationId: 'attestation-1'}),
    );
  });
});
