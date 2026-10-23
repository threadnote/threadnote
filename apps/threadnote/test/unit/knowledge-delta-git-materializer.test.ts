import {formatMemoryDocument} from '@threadnote/memory/document';
import {createReviewedSupportSnapshot, reviewedMemorySupportDigest} from '@threadnote/memory/reviewed-support';
import {
  topicMaintenancePublicationPolicyHash,
  verifyAutomaticMaintenanceGitProposal,
  type AutomaticMaintenanceGitProposalV3,
} from '../../src/git_proposal/topic_maintenance_proposal.js';
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

function automaticArtifact(kind: 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke') {
  const body = 'Explicit reviewed body.';
  const headerTitle = kind === 'handoff' ? ('HANDOFF' as const) : ('MEMORY' as const);
  const path = `${kind}/projects/threadnote/existing-record.md`;
  const before = formatMemoryDocument(
    headerTitle,
    {
      kind,
      status: 'active',
      memoryId: 'tn_source',
      sourceAgentClient: 'test',
      timestamp: '2026-10-21T00:00:00.000Z',
      visibility: 'shared',
    },
    'Previous body.',
  );
  const beforeCanonicalHash = sha256HexSync(before);
  const reviewedSupport = {
    type: 'reviewed-memory-support' as const,
    version: 1 as const,
    active: createReviewedSupportSnapshot({
      bodyHash: sha256HexSync(body),
      paragraphs: [{ordinal: 0, hash: sha256HexSync(body), role: 'unknown', support: 'unresolved', evidenceIds: []}],
      sources: [],
      acceptance: {
        reviewId,
        approvedAt: '2026-10-21T00:00:00.000Z',
        targetBeforeHash: beforeCanonicalHash,
        preparationDigest: '2'.repeat(64),
        sourceVectorDigest: '3'.repeat(64),
      },
    }),
  };
  const content = formatMemoryDocument(
    headerTitle,
    {
      kind,
      status: 'active',
      memoryId: 'tn_source',
      sourceAgentClient: 'test',
      timestamp: '2026-10-21T00:00:00.000Z',
      visibility: 'shared',
      schemaVersion: 11,
      reviewedSupport,
    },
    body,
  );
  const target = {repositoryId: '1'.repeat(64), team: 'default'};
  const files = [
    {
      approval: {
        candidateId: `${reviewId}-1`,
        expectedSourceContentHash: beforeCanonicalHash,
        expectedSourceMemoryId: 'tn_source',
        reviewId,
        revision: 1,
        scope: 'shared' as const,
      },
      content,
      contentHash: sha256HexSync(content),
      memory: {id: 'tn_source', relations: [], topic: 'existing-record'},
      operation: 'replace' as const,
      path,
      targetPrecondition: {
        state: 'present' as const,
        expectedContentHash: sha256HexSync(before),
        expectedMemoryId: 'tn_source',
      },
    },
  ];
  const maintenance = {
    kind: 'automatic' as const,
    approvalDigest: '4'.repeat(64),
    beforeCanonicalHash,
    sourceVectorHash: '5'.repeat(64),
    reviewHash: '6'.repeat(64),
    supportDigest: reviewedMemorySupportDigest(reviewedSupport),
    target: {kind, headerTitle},
    baseBranch: 'main',
    policy: {
      version: 1 as const,
      access: 'read-write' as const,
      hash: topicMaintenancePublicationPolicyHash(target, path, 'read-write'),
    },
  };
  const binding = {
    base: {expectedCommit: state.baseCommit},
    files,
    knowledgeDelta: {expectedHash: maintenance.reviewHash, expectedRevision: 1, reviewId},
    project: 'threadnote',
    target,
  };
  const unsigned = {
    ...binding,
    branch: {name: expectedBranchName({...binding, maintenance})},
    commit: {message: `threadnote: propose threadnote knowledge delta ${reviewId}`},
    type: 'knowledge-delta-git-proposal' as const,
    version: 3 as const,
    maintenance,
  };
  const proposal: AutomaticMaintenanceGitProposalV3 = {
    ...unsigned,
    proposalHash: sha256HexSync(canonicalJson(unsigned)),
  };
  return {proposal, before};
}

describe('automatic ordinary shared Git materialization', () => {
  it.each(['durable', 'handoff', 'incident', 'preference', 'smoke'] as const)(
    'binds the existing %s path without durable path projection',
    kind => {
      const {proposal, before} = automaticArtifact(kind);
      const original = structuredClone(proposal);
      expect(() => verifyAutomaticMaintenanceGitProposal(proposal)).not.toThrow();
      const current = {...state, files: {[proposal.files[0].path]: before}};
      expect(planKnowledgeDeltaGitMaterializationV1(proposal, current).files).toEqual([
        {path: proposal.files[0].path, content: proposal.files[0].content},
      ]);
      expect(proposal).toEqual(original);
      expect(() => verifyKnowledgeDeltaGitProposalV1({...proposal, version: 1})).toThrow();
      for (const altered of [
        {...proposal, maintenance: {...proposal.maintenance, supportDigest: '0'.repeat(64)}},
        {
          ...proposal,
          maintenance: {
            ...proposal.maintenance,
            target: {
              ...proposal.maintenance.target,
              kind: kind === 'smoke' ? ('durable' as const) : ('smoke' as const),
            },
          },
        },
        {
          ...proposal,
          maintenance: {
            ...proposal.maintenance,
            policy: {...proposal.maintenance.policy, access: 'read-only' as never},
          },
        },
      ])
        expect(() => verifyAutomaticMaintenanceGitProposal(altered)).toThrow();
      expect(() =>
        planKnowledgeDeltaGitMaterializationV1(proposal, {
          ...current,
          files: {[proposal.files[0].path]: `${before}\nchanged`},
        }),
      ).toThrow(/target changed/u);
    },
  );
  it('refuses generic V1 replacement of even malformed reviewed-support declarations', () => {
    const {proposal: automatic} = automaticArtifact('durable');
    const approved = automatic.files[0].content;
    for (const current of [approved, approved.replace('reviewed_support:', ' reviewed_support :')]) {
      const file = {
        ...proposal.files[0],
        operation: 'replace' as const,
        targetPrecondition: {
          state: 'present' as const,
          expectedContentHash: sha256HexSync(current),
          expectedMemoryId: proposal.files[0].memory.id,
        },
      };
      const changed = {...proposal, files: [file]};
      const branch = {...changed, branch: {name: expectedBranchName(changed)}};
      const {proposalHash: _hash, ...unsigned} = branch;
      const rehashed = {...unsigned, proposalHash: sha256HexSync(canonicalJson(unsigned))};
      expect(() => planKnowledgeDeltaGitMaterializationV1(rehashed, {...state, files: {[file.path]: current}})).toThrow(
        /approved reviewed support/u,
      );
    }
  });
});
