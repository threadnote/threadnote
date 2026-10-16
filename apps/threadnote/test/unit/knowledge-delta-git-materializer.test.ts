import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  buildKnowledgeDeltaGitProposalV1,
  expectedBranchName,
  verifyKnowledgeDeltaGitProposalV1,
} from '@threadnote/threadnote/git_proposal/knowledge_delta';
import {planKnowledgeDeltaGitMaterializationV1} from '@threadnote/threadnote/git_proposal/materializer';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {KnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {enrolledGitTarget} from '../helpers/enrolled-git-target.js';

const reviewId = 'review-0123456789abcdef';
const source = [
  'MEMORY',
  'kind: durable',
  'status: active',
  'project: threadnote',
  'topic: architecture',
  'source_agent_client: test',
  'timestamp: 2026-01-01T00:00:00.000Z',
  'schema_version: 5',
  'memory_id: tn_source',
  'visibility: personal',
  'authority: user_approved',
  'trust: approved',
  `candidate_id: ${reviewId}-1`,
  'relation: references threadnote://memory/tn_platform_contract',
  '',
  'Text.',
].join('\n');
const delta: KnowledgeDeltaV1 = {
  items: [
    {
      candidateId: `${reviewId}-1`,
      comparison: 'new',
      comparisonReason: 'test',
      confidence: 0.9,
      mutationPreview: {bodyText: 'Text.', operation: 'create', truncated: false},
      proposedDestination: {kind: 'durable', project: 'threadnote', topic: 'architecture'},
      recommendation: 'create',
      sourceEvidence: ['test'],
      state: 'applied',
      truncated: false,
      type: 'decision-or-invariant',
    },
  ],
  noAction: false,
  reviewId,
  revision: 1,
  type: 'knowledge-delta',
  version: 1,
};
const proposal = buildKnowledgeDeltaGitProposalV1({
  baseCommit: 'a'.repeat(40),
  delta,
  mutations: [
    {
      approval: {expectedSourceContentHash: sha256HexSync(source), reviewId, revision: 1, share: true},
      candidateId: delta.items[0].candidateId,
      expectedTarget: {state: 'absent'},
      operation: 'create',
      sourceContent: source,
      sourceUri: 'threadnote://user/a/memories/durable/projects/threadnote/architecture.md',
    },
  ],
  project: 'threadnote',
  target: {repositoryId: '1'.repeat(64), team: 'default'},
}).proposal;
const state = {baseCommit: 'a'.repeat(40), files: {}, repositoryId: '1'.repeat(64)};

describe('Knowledge Delta Git materializer', () => {
  it('plans the deterministic local branch, commit message, and exact file bytes', () => {
    expect(planKnowledgeDeltaGitMaterializationV1(proposal, state)).toMatchObject({
      branch: proposal.branch.name,
      commitMessage: proposal.commit.message,
      files: proposal.files.map(file => ({content: file.content, path: file.path})),
      proposalHash: proposal.proposalHash,
    });
  });
  it('fails closed on repository, base, or target CAS drift', () => {
    expect(() => planKnowledgeDeltaGitMaterializationV1(proposal, {...state, repositoryId: '2'.repeat(64)})).toThrow(
      /repository binding/u,
    );
    expect(() => planKnowledgeDeltaGitMaterializationV1(proposal, {...state, baseCommit: 'b'.repeat(40)})).toThrow(
      /base commit/u,
    );
    expect(() =>
      planKnowledgeDeltaGitMaterializationV1(proposal, {...state, files: {[proposal.files[0].path]: 'changed'}}),
    ).toThrow(/target changed/u);
  });
  it('has deterministic plans independent of irrelevant state key ordering', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({minLength: 1, maxLength: 4}), {maxLength: 8}), keys => {
        const forward = Object.fromEntries(keys.map(key => [key, undefined]));
        const reverse = Object.fromEntries([...keys].reverse().map(key => [key, undefined]));
        expect(planKnowledgeDeltaGitMaterializationV1(proposal, {...state, files: forward})).toEqual(
          planKnowledgeDeltaGitMaterializationV1(proposal, {...state, files: reverse}),
        );
      }),
      {numRuns: 24},
    );
  });

  it('rejects a prebuilt valid V1 replacement artifact whose exact baseline is enrolled', () => {
    const enrolled = enrolledGitTarget('tn_source');
    for (const content of [enrolled, enrolled.replace('topic_maintenance:', ' \n\t \ntopic_maintenance:')]) {
      const prebuilt = replacementProposal(content);
      expect(() => verifyKnowledgeDeltaGitProposalV1(prebuilt)).not.toThrow();
      expect(() =>
        planKnowledgeDeltaGitMaterializationV1(prebuilt, {...state, files: {[prebuilt.files[0].path]: content}}),
      ).toThrow(/enrolled shared target/);
    }
  });

  it('rejects malformed enrollment declarations across bounded header whitespace and line endings', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', ' ', '\t'),
        fc.constantFrom('', ' ', '\t'),
        fc.constantFrom('\n', '\r\n'),
        (indent, padding, newline) => {
          const enrolled = enrolledGitTarget('tn_source')
            .replace(/^topic_maintenance: .+$/mu, `${indent}topic_maintenance${padding}: {broken`)
            .replaceAll('\n', newline);
          const prebuilt = replacementProposal(enrolled);
          expect(() =>
            planKnowledgeDeltaGitMaterializationV1(prebuilt, {...state, files: {[prebuilt.files[0].path]: enrolled}}),
          ).toThrow(/enrolled shared target/);
        },
      ),
      {numRuns: 16},
    );
    const ordinary = source.replace('visibility: personal', 'visibility: shared') + '\n\ntopic_maintenance: prose only';
    const compatible = replacementProposal(ordinary);
    expect(() =>
      planKnowledgeDeltaGitMaterializationV1(compatible, {...state, files: {[compatible.files[0].path]: ordinary}}),
    ).not.toThrow();
  });
});

/** Simulates a pre-existing/exported V1 artifact; a current builder must not authorize this downgrade. */
function replacementProposal(target: string) {
  const file = proposal.files[0];
  const binding = {
    ...proposal,
    files: [
      {
        ...file,
        operation: 'replace' as const,
        targetPrecondition: {
          state: 'present' as const,
          expectedContentHash: sha256HexSync(target),
          expectedMemoryId: file.memory.id,
        },
      },
    ],
  };
  const {proposalHash: _hash, ...unsigned} = {...binding, branch: {name: expectedBranchName(binding)}};
  return {...unsigned, proposalHash: sha256HexSync(canonicalJson(unsigned))};
}
