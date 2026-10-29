import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  buildKnowledgeDeltaGitProposalV1,
  knowledgeDeltaGitProposalArtifactV1,
  KnowledgeDeltaGitProposalError,
  verifyKnowledgeDeltaGitProposalV1,
  type ReviewedSharedMemoryMutationV1,
} from '@threadnote/threadnote/git_proposal/knowledge_delta';
import {createMemoryCodeCitation, formatMemoryCodeCitationLines} from '@threadnote/memory/code/citation';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import type {KnowledgeDeltaItemV1, KnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {enrolledGitTarget} from '../helpers/enrolled-git-target.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const REVIEW_ID = 'review-0123456789abcdef';
const BASE_COMMIT = Effect.pipe('a', EffectString.repeat(40));
const TARGET = {repositoryId: Effect.pipe('1', EffectString.repeat(64)), team: 'default'} as const;

describe('Knowledge Delta Git proposals', () => {
  it('builds a canonical non-mutating shared-memory proposal with exact preconditions', () => {
    const delta = knowledgeDelta([item(1, 'architecture')]);
    const sourceContent = approvedSource(1, 'architecture');
    const input = {
      baseCommit: BASE_COMMIT,
      delta,
      mutations: [createMutation(1, 'architecture', sourceContent)],
      project: 'threadnote',
      target: TARGET,
    } as const;
    const before = JSON.stringify(input);

    const built = buildKnowledgeDeltaGitProposalV1(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(built.artifact).toBe(knowledgeDeltaGitProposalArtifactV1(built.proposal));
    expect(Effect.pipe(built.artifact, EffectString.endsWith('\n'))).toBe(true);
    expect(built.proposal.base.expectedCommit).toBe(BASE_COMMIT);
    expect(built.proposal.target).toEqual(TARGET);
    expect(built.proposal.branch.name).toMatch(/^threadnote\/knowledge-delta\/review-0123456789abcdef-[0-9a-f]{12}$/u);
    expect(built.proposal.files).toHaveLength(1);
    expect(built.proposal.files[0]).toMatchObject({
      approval: {
        candidateId: `${REVIEW_ID}-1`,
        reviewId: REVIEW_ID,
        revision: 7,
        scope: 'shared',
      },
      memory: {
        id: 'tn_architecture',
        relations: [{type: 'references', uri: 'threadnote://memory/tn_platform_contract'}],
        topic: 'architecture',
      },
      operation: 'create',
      path: 'durable/projects/threadnote/architecture.md',
      targetPrecondition: {state: 'absent'},
    });
    expect(built.proposal.files[0]?.content).toContain('visibility: shared');
    expect(built.proposal.files[0]?.content).toContain('relation: references threadnote://memory/tn_platform_contract');
    expect(built.proposal.files[0]?.content).not.toContain('candidate_id:');
    expect(built.proposal.files[0]?.content).not.toContain('source_session_id:');
    expect(built.proposal.files[0]?.contentHash).toBe(sha256HexSync(built.proposal.files[0]?.content ?? ''));
    expect(built.artifact).not.toContain('alice');
    expect(
      buildKnowledgeDeltaGitProposalV1({
        ...input,
        mutations: EffectArray.map(input.mutations, mutation => ({
          ...mutation,
          sourceUri: Effect.pipe(mutation.sourceUri, EffectString.replace('/alice/', '/bob/')),
        })),
      }).artifact,
    ).toBe(built.artifact);
    expect(() => verifyKnowledgeDeltaGitProposalV1(built.proposal)).not.toThrow();
  });

  it('is invariant to Knowledge Delta and reviewed-mutation ordering', () => {
    const items = [item(1, 'architecture'), item(2, 'testing')];
    const sourceA = approvedSource(1, 'architecture');
    const sourceB = approvedSource(2, 'testing');
    const mutations = [createMutation(1, 'architecture', sourceA), createMutation(2, 'testing', sourceB)];
    const baseline = buildKnowledgeDeltaGitProposalV1({
      baseCommit: BASE_COMMIT,
      delta: knowledgeDelta(items),
      mutations,
      project: 'threadnote',
      target: TARGET,
    }).artifact;

    fc.assert(
      fc.property(
        fc.shuffledSubarray(items, {maxLength: items.length, minLength: items.length}),
        fc.shuffledSubarray(mutations, {maxLength: mutations.length, minLength: mutations.length}),
        (permutedItems, permutedMutations) => {
          const input = {
            baseCommit: BASE_COMMIT,
            delta: knowledgeDelta(permutedItems),
            mutations: permutedMutations,
            project: 'threadnote',
            target: TARGET,
          };
          const before = JSON.stringify(input);
          expect(buildKnowledgeDeltaGitProposalV1(input).artifact).toBe(baseline);
          expect(JSON.stringify(input)).toBe(before);
        },
      ),
      {numRuns: 32},
    );
  });

  it('requires exact replacement bytes and preserves stable identity', () => {
    const sourceContent = approvedSource(1, 'architecture', 'Updated contract.', 'tn_proposed_architecture');
    const targetContent = sharedTarget('architecture', 'Prior contract.');
    const mutation: ReviewedSharedMemoryMutationV1 = {
      ...createMutation(1, 'architecture', sourceContent),
      expectedTarget: {
        content: targetContent,
        contentHash: sha256HexSync(targetContent),
        state: 'present',
      },
      operation: 'replace',
    };
    // Personal candidate application created this memory. The independently approved shared mutation replaces the
    // canonical Git target, which is intentionally a different operation.
    const delta = knowledgeDelta([item(1, 'architecture', 'create')]);
    const proposal = buildKnowledgeDeltaGitProposalV1({
      baseCommit: BASE_COMMIT,
      delta,
      mutations: [mutation],
      project: 'threadnote',
      target: TARGET,
    }).proposal;

    expect(proposal.files[0]?.targetPrecondition).toEqual({
      expectedContentHash: sha256HexSync(targetContent),
      expectedMemoryId: 'tn_architecture',
      state: 'present',
    });
    expect(proposal.files[0]?.approval.expectedSourceMemoryId).toBe('tn_proposed_architecture');
    expect(proposal.files[0]?.memory.id).toBe('tn_architecture');
    expect(proposal.files[0]?.content).toContain('memory_id: tn_architecture');
    expect(proposal.files[0]?.content).not.toContain('memory_id: tn_proposed_architecture');
    expect(() =>
      buildKnowledgeDeltaGitProposalV1({
        baseCommit: BASE_COMMIT,
        delta,
        mutations: [
          {
            ...mutation,
            expectedTarget: {
              content: targetContent,
              contentHash: Effect.pipe('b', EffectString.repeat(64)),
              state: 'present',
            },
          },
        ],
        project: 'threadnote',
        target: TARGET,
      }),
    ).toThrow(/does not match its expected hash/u);
  });

  it('blocks a normal approved personal source from replacing an enrolled shared destination', () => {
    const sourceContent = approvedSource(1, 'architecture');
    const target = enrolledGitTarget('tn_architecture');
    for (const content of [
      target,
      Effect.pipe(target, EffectString.replace('topic_maintenance:', ' \n\t \ntopic_maintenance:')),
      Effect.pipe(target, EffectString.replace(/^topic_maintenance: .+$/mu, ' topic_maintenance : {broken')),
    ]) {
      const mutation: ReviewedSharedMemoryMutationV1 = {
        ...createMutation(1, 'architecture', sourceContent),
        operation: 'replace',
        expectedTarget: {state: 'present', content, contentHash: sha256HexSync(content)},
      };
      expect(() =>
        buildKnowledgeDeltaGitProposalV1({
          baseCommit: BASE_COMMIT,
          delta: knowledgeDelta([item(1, 'architecture')]),
          mutations: [mutation],
          project: 'threadnote',
          target: TARGET,
        }),
      ).toThrow(/enrolled shared target/);
    }
  });

  it('fails closed for stale approval, cross-project content, and non-portable relations', () => {
    const delta = knowledgeDelta([item(1, 'architecture')]);
    const sourceContent = approvedSource(1, 'architecture');
    const mutation = createMutation(1, 'architecture', sourceContent);

    expect(() =>
      buildKnowledgeDeltaGitProposalV1({
        baseCommit: BASE_COMMIT,
        delta,
        mutations: [{...mutation, approval: {...mutation.approval, revision: delta.revision - 1}}],
        project: 'threadnote',
        target: TARGET,
      }),
    ).toThrow(/approval is stale/u);
    expect(() =>
      buildKnowledgeDeltaGitProposalV1({
        baseCommit: BASE_COMMIT,
        delta,
        mutations: [
          createMutation(
            1,
            'architecture',
            Effect.pipe(
              approvedSource(1, 'architecture'),
              EffectString.replace('project: threadnote', 'project: other'),
            ),
          ),
        ],
        project: 'threadnote',
        target: TARGET,
      }),
    ).toThrow(/outside its reviewed project\/topic/u);
    const localRelation = Effect.pipe(
      approvedSource(1, 'architecture'),
      EffectString.replace(
        'threadnote://memory/tn_platform_contract',
        'threadnote://user/alice/memories/durable/projects/threadnote/platform-contract.md',
      ),
    );
    expect(() =>
      buildKnowledgeDeltaGitProposalV1({
        baseCommit: BASE_COMMIT,
        delta,
        mutations: [createMutation(1, 'architecture', localRelation)],
        project: 'threadnote',
        target: TARGET,
      }),
    ).toThrow(/non-portable reviewed relation/u);
  });

  it.each([
    ['dirty', citedSource(true, 'remote'), /dirty worktree cannot be shared/u],
    ['local', citedSource(false, 'local'), /portable remote repository identity/u],
    [
      'malformed',
      Effect.pipe(
        approvedSource(1, 'architecture'),
        EffectString.replace('relation: references', 'code_citation: {not-json}\nrelation: references'),
      ),
      /malformed code citation metadata/u,
    ],
  ] as const)('rejects %s code citations while building and verifying artifacts', (_label, sourceContent, message) => {
    const delta = knowledgeDelta([item(1, 'architecture')]);
    expect(() =>
      buildKnowledgeDeltaGitProposalV1({
        baseCommit: BASE_COMMIT,
        delta,
        mutations: [createMutation(1, 'architecture', sourceContent)],
        project: 'threadnote',
        target: TARGET,
      }),
    ).toThrow(message);

    const built = buildKnowledgeDeltaGitProposalV1({
      baseCommit: BASE_COMMIT,
      delta,
      mutations: [createMutation(1, 'architecture', approvedSource(1, 'architecture'))],
      project: 'threadnote',
      target: TARGET,
    });
    const file = built.proposal.files[0];
    expect(file).toBeDefined();
    if (!file) throw new Error('Expected proposal file.');
    const blockedContent = setCitationHeader(file.content, sourceContent);
    const forged = resignProposal({
      ...built.proposal,
      files: [{...file, content: blockedContent, contentHash: sha256HexSync(blockedContent)}],
    });
    expect(() => verifyKnowledgeDeltaGitProposalV1(forged)).toThrow(message);
  });

  it('rejects replacement relations to either the personal source or adopted target identity', () => {
    const sourceContent = approvedSource(1, 'architecture', 'Updated contract.', 'tn_personal_source');
    const targetContent = sharedTarget('architecture', 'Prior contract.', 'tn_shared_target');
    const mutation: ReviewedSharedMemoryMutationV1 = {
      ...createMutation(1, 'architecture', sourceContent),
      expectedTarget: {
        content: targetContent,
        contentHash: sha256HexSync(targetContent),
        state: 'present',
      },
      operation: 'replace',
    };
    const delta = knowledgeDelta([item(1, 'architecture')]);

    for (const memoryId of ['tn_personal_source', 'tn_shared_target']) {
      const selfRelated = Effect.pipe(
        sourceContent,
        EffectString.replace('threadnote://memory/tn_platform_contract', `threadnote://memory/${memoryId}`),
      );
      expect(() =>
        buildKnowledgeDeltaGitProposalV1({
          baseCommit: BASE_COMMIT,
          delta,
          mutations: [
            {
              ...mutation,
              approval: {
                ...mutation.approval,
                expectedSourceContentHash: sha256HexSync(canonicalMemoryDocumentContent(selfRelated)),
              },
              sourceContent: selfRelated,
            },
          ],
          project: 'threadnote',
          target: TARGET,
        }),
      ).toThrow(/relate to itself/u);
    }
  });

  it('detects artifact tampering', () => {
    const built = buildKnowledgeDeltaGitProposalV1({
      baseCommit: BASE_COMMIT,
      delta: knowledgeDelta([item(1, 'architecture')]),
      mutations: [createMutation(1, 'architecture', approvedSource(1, 'architecture'))],
      project: 'threadnote',
      target: TARGET,
    });
    const tampered = {
      ...built.proposal,
      files: EffectArray.map(built.proposal.files, file => ({...file, content: `${file.content}\nchanged`})),
    };

    expect(() => verifyKnowledgeDeltaGitProposalV1(tampered)).toThrow(KnowledgeDeltaGitProposalError);
  });

  it('binds identical base commits and content to the exact team repository', () => {
    const common = {
      baseCommit: BASE_COMMIT,
      delta: knowledgeDelta([item(1, 'architecture')]),
      mutations: [createMutation(1, 'architecture', approvedSource(1, 'architecture'))],
      project: 'threadnote',
    } as const;

    const first = buildKnowledgeDeltaGitProposalV1({...common, target: TARGET}).proposal;
    const second = buildKnowledgeDeltaGitProposalV1({
      ...common,
      target: {repositoryId: Effect.pipe('2', EffectString.repeat(64)), team: 'other'},
    }).proposal;

    expect(first.base).toEqual(second.base);
    expect(first.files).toEqual(second.files);
    expect(first.target).not.toEqual(second.target);
    expect(first.branch.name).not.toBe(second.branch.name);
    expect(first.proposalHash).not.toBe(second.proposalHash);
  });

  it('rejects an unborn all-zero Git base', () => {
    expect(() =>
      buildKnowledgeDeltaGitProposalV1({
        baseCommit: Effect.pipe('0', EffectString.repeat(40)),
        delta: knowledgeDelta([item(1, 'architecture')]),
        mutations: [createMutation(1, 'architecture', approvedSource(1, 'architecture'))],
        project: 'threadnote',
        target: TARGET,
      }),
    ).toThrow(/existing Git object/u);
  });
});

function knowledgeDelta(items: readonly KnowledgeDeltaItemV1[]): KnowledgeDeltaV1 {
  return {
    items,
    noAction: false,
    reviewId: REVIEW_ID,
    revision: 7,
    type: 'knowledge-delta',
    version: 1,
  };
}

function item(index: number, topic: string, operation: 'create' | 'replace' = 'create'): KnowledgeDeltaItemV1 {
  return {
    candidateId: `${REVIEW_ID}-${index}`,
    comparison: operation === 'create' ? 'new' : 'replacement',
    comparisonReason: 'Reviewed test mutation.',
    confidence: 0.9,
    mutationPreview: {
      bodyText: `Approved ${topic} body.`,
      operation,
      truncated: false,
    },
    proposedDestination: {kind: 'durable', project: 'threadnote', topic},
    recommendation: operation,
    sourceEvidence: ['commit:abc'],
    state: 'applied',
    truncated: false,
    type: 'decision-or-invariant',
  };
}

function createMutation(index: number, topic: string, sourceContent: string): ReviewedSharedMemoryMutationV1 {
  return {
    approval: {
      expectedSourceContentHash: sha256HexSync(canonicalMemoryDocumentContent(sourceContent)),
      reviewId: REVIEW_ID,
      revision: 7,
      share: true,
    },
    candidateId: `${REVIEW_ID}-${index}`,
    expectedTarget: {state: 'absent'},
    operation: 'create',
    sourceContent,
    sourceUri: `threadnote://user/alice/memories/durable/projects/threadnote/${topic}.md`,
  };
}

function approvedSource(
  index: number,
  topic: string,
  body = `Approved ${topic} body.`,
  memoryId = `tn_${Effect.pipe(topic, EffectString.replaceAll('-', '_'))}`,
): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${topic}`,
      'source_agent_client: codex',
      'timestamp: 2026-09-17T00:00:00.000Z',
      'schema_version: 5',
      `memory_id: ${memoryId}`,
      'visibility: personal',
      'authority: user_approved',
      'trust: approved',
      `candidate_id: ${REVIEW_ID}-${index}`,
      'source_session_id: private-session',
      'relation: references threadnote://memory/tn_platform_contract',
      '',
      body,
    ],
    '\n',
  );
}

function sharedTarget(
  topic: string,
  body: string,
  memoryId = `tn_${Effect.pipe(topic, EffectString.replaceAll('-', '_'))}`,
): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${topic}`,
      'source_agent_client: codex',
      'timestamp: 2026-09-16T00:00:00.000Z',
      `memory_id: ${memoryId}`,
      'visibility: shared',
      'authority: user_approved',
      'trust: approved',
      '',
      body,
    ],
    '\n',
  );
}

function citedSource(sourceDirty: boolean, repositoryIdentityKind: 'local' | 'remote'): string {
  const citation = createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
    path: 'apps/threadnote/src/git_proposal/knowledge_delta.ts',
    repositoryId: Effect.pipe('b', EffectString.repeat(64)),
    repositoryIdentityKind,
    sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
    sourceDirty,
    sourceSnapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}`,
    target: {kind: 'file'},
    version: 1,
  });
  const citationLine = formatMemoryCodeCitationLines([citation])[0];
  if (!citationLine) throw new Error('Expected citation line.');
  return Effect.pipe(
    approvedSource(1, 'architecture'),
    EffectString.replace('relation: references', `${citationLine}\nrelation: references`),
  );
}

function setCitationHeader(content: string, citedContent: string): string {
  const citationLine = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      Effect.pipe(citedContent, EffectString.split('\n')),
      __effectArrayValue => !!(line => /^\s*code_citation\s*:/u.test(line))(__effectArrayValue),
    ),
  );
  if (!citationLine) throw new Error('Expected citation header.');
  return Effect.pipe(content, EffectString.replace('relation: references', `${citationLine}\nrelation: references`));
}

function resignProposal(
  proposal: ReturnType<typeof buildKnowledgeDeltaGitProposalV1>['proposal'],
): ReturnType<typeof buildKnowledgeDeltaGitProposalV1>['proposal'] {
  const contentSetHash = sha256HexSync(
    canonicalJson({
      baseCommit: proposal.base.expectedCommit,
      expectedHash: proposal.knowledgeDelta.expectedHash,
      files: proposal.files,
      project: proposal.project,
      reviewId: proposal.knowledgeDelta.reviewId,
      revision: proposal.knowledgeDelta.expectedRevision,
      target: proposal.target,
    }),
  );
  const {proposalHash: _proposalHash, ...unsigned} = {
    ...proposal,
    branch: {
      name: `threadnote/knowledge-delta/${proposal.knowledgeDelta.reviewId}-${Effect.pipe(contentSetHash, EffectString.slice(0, 12))}`,
    },
  };
  return {...unsigned, proposalHash: sha256HexSync(canonicalJson(unsigned))};
}
