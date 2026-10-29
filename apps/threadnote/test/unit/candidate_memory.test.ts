import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {BunCrypto, BunFileSystem, BunPath} from '@effect/platform-bun';
import {ByteSize, DateTime, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  appendCandidateAudit,
  assessReplacementSafety,
  buildCandidateReview,
  candidateReviewWithAuditEvent,
  candidateReviewWithApplying,
  candidateReviewWithReplacementSafety,
  candidateReviewWithState,
  loadCandidateReview,
  parseCandidateReview,
  readActiveProjectMemories,
  replacementSafetyBaseline,
  saveCandidateReview,
  type CandidateReview,
  type SessionCloseoutInput,
  type StructuredCloseoutV1,
  validateSessionCloseoutInput,
  withCandidateReviewLock,
} from '@threadnote/memory/candidate';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import type {MemoryRecord} from '@threadnote/memory/document';

import {join, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

const input: SessionCloseoutInput = {
  decisions: ['Keep application workflows Effect-native.'],
  evidence: ['docs/effect.md'],
  handoff: ['Candidate review MCP wiring remains.'],
  invariants: ['Only the executable runtime may run an Effect.'],
  outcome: 'Centralized memory documents.',
  preferences: ['Ask before creating durable memory.'],
  project: 'threadnote',
  sourceAgentClient: 'codex',
  sourceSessionId: 'session-1',
  task: 'Improve recall and memory formation',
  topic: 'recall-memory-formation',
};

function existing(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    body: '## Decisions\n- Use Promise-first workflows.',
    content: '',
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-07-22T00:00:00.000Z',
      topic: 'recall-memory-formation',
    },
    uri: 'threadnote://user/me/memories/durable/projects/threadnote/recall-memory-formation.md',
    ...overrides,
  };
}

function projectedReview(candidates: CandidateReview['candidates']): CandidateReview {
  return {
    auditEvents: [],
    candidates,
    codeCitations: [],
    createdAt: '2026-09-17T10:00:00.000Z',
    outcome: 'Projected reviewed knowledge.',
    project: 'threadnote',
    reviewId: 'review-0123456789abcdef',
    revision: 2,
    sourceAgentClient: 'codex',
    task: 'Project a knowledge delta',
    topic: 'knowledge-delta',
    version: 2,
  };
}

const structuredCloseout: StructuredCloseoutV1 = {
  type: 'structured-closeout',
  version: 1,
  rationale: 'Keep reviewed context explicit.',
  constraints: ['Private by default.'],
  verificationPerformed: ['Focused unit tests passed.'],
  knowledgeInvalidated: ['The unbounded closeout draft.'],
  unresolvedRisks: ['A follow-up review may be needed.'],
};

function projectedCandidate(
  candidateId: string,
  overrides: Partial<CandidateReview['candidates'][number]> = {},
): CandidateReview['candidates'][number] {
  return {
    candidateId,
    categories: ['decision'],
    comparison: 'new',
    confidence: 0.82,
    evidence: ['test/candidate-memory.test.ts'],
    kind: 'durable',
    project: 'threadnote',
    proposedText: '## Decisions\n- Keep review output bounded.',
    reason: 'No active memory with the same stable identity was found.',
    recommendation: 'create',
    state: 'pending',
    topic: 'knowledge-delta',
    ...overrides,
  };
}

describe('candidate-memory formation', () => {
  it('retains legacy generic reviews without candidate kinds', () => {
    const candidate = Object.fromEntries(
      Object.entries(projectedCandidate('legacy')).filter(([key]) => key !== 'kind'),
    );
    for (const version of [1, 2]) {
      const raw = {...projectedReview([]), version, candidates: [candidate]};
      const before = structuredClone(raw);
      const parsed = parseCandidateReview(raw);
      expect(parsed.candidates).toEqual([candidate]);
      expect(Object.hasOwn(parsed.candidates[0], 'kind')).toBe(false);
      expect(raw).toEqual(before);
    }
  });

  it('round trips legacy generic candidate states and optional kinds without mutation', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2),
        fc.option(fc.constantFrom('durable', 'handoff', 'preference'), {nil: undefined}),
        fc.shuffledSubarray(['pending', 'applying', 'deferred', 'applied', 'rejected', 'conflict'], {
          minLength: 1,
        }),
        (version, kind, states) => {
          const candidates = states.map((state, index) => {
            const candidate = Object.fromEntries(
              Object.entries(projectedCandidate(`legacy-${index}`)).filter(([key]) => key !== 'kind'),
            );
            return {...candidate, state, ...(kind === undefined ? {} : {kind})};
          });
          const raw = {...projectedReview([]), version, candidates};
          const before = structuredClone(raw);
          const parsed = parseCandidateReview(raw);
          expect(parsed.candidates).toEqual(candidates);
          expect(parseCandidateReview(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
          expect(raw).toEqual(before);
        },
      ),
      {numRuns: 24},
    );
  });

  it('still refuses maintenance-only kinds and closed journal versions in generic reviews', () => {
    for (const version of [1, 2]) {
      for (const kind of ['incident', 'smoke', 'unknown', null]) {
        expect(() =>
          parseCandidateReview({
            ...projectedReview([]),
            version,
            candidates: [{...projectedCandidate('generic'), kind}],
          }),
        ).toThrow('Generic candidates cannot select ordinary maintenance-only kinds.');
      }
    }
    for (const version of [3, 4, 5]) {
      expect(() => parseCandidateReview({...projectedReview([]), version})).toThrow();
    }
  });

  it('projects review candidates as a bounded KnowledgeDeltaV1 without mutating the review', () => {
    const review = projectedReview([
      projectedCandidate('review-0123456789abcdef-1'),
      projectedCandidate('review-0123456789abcdef-2', {
        categories: ['handoff'],
        kind: 'handoff',
        proposedText: '## Handoff state\n- Run focused checks.',
        topic: 'knowledge-delta-handoff',
      }),
      projectedCandidate('review-0123456789abcdef-3', {
        categories: ['preference'],
        kind: 'preference',
        proposedText: '## Preferences\n- Keep output concise.',
        topic: 'knowledge-delta-preference',
      }),
    ]);
    const before = structuredClone(review);

    expect(projectKnowledgeDeltaV1(review)).toEqual({
      items: [
        expect.objectContaining({candidateId: 'review-0123456789abcdef-1', type: 'decision-or-invariant'}),
        expect.objectContaining({candidateId: 'review-0123456789abcdef-2', type: 'handoff-state'}),
        expect.objectContaining({candidateId: 'review-0123456789abcdef-3', type: 'preference'}),
      ],
      noAction: false,
      reviewId: review.reviewId,
      revision: review.revision,
      type: 'knowledge-delta',
      version: 1,
    });
    expect(
      projectKnowledgeDeltaV1(
        projectedReview([
          projectedCandidate('review-0123456789abcdef-4', {
            comparison: 'replacement',
            recommendation: 'replace',
            targetContentHash: 'a'.repeat(64),
            targetUri: 'threadnote://user/me/memories/durable/projects/threadnote/knowledge-delta.md',
          }),
        ]),
      ),
    ).toMatchObject({
      items: [expect.objectContaining({type: 'context-repair-or-retirement'})],
    });
    expect(review).toEqual(before);
  });

  it('projects revision-checked edited and persisted apply bodies without mutating the review', () => {
    const candidate = projectedCandidate('review-0123456789abcdef-1');
    const review = projectedReview([candidate]);
    expect(
      projectKnowledgeDeltaV1(review, {
        bodyText: '## Decisions\n- Use the reviewed edit.',
        candidateId: candidate.candidateId,
        revision: review.revision,
      }).items[0]?.mutationPreview.bodyText,
    ).toContain('reviewed edit');
    expect(() =>
      projectKnowledgeDeltaV1(review, {
        bodyText: 'stale',
        candidateId: candidate.candidateId,
        revision: review.revision + 1,
      }),
    ).toThrow('revision changed');
    expect(
      projectKnowledgeDeltaV1(
        projectedReview([
          {...candidate, applyBodyText: '## Decisions\n- Persist the exact applied edit.', state: 'applied'},
        ]),
      ).items[0]?.mutationPreview.bodyText,
    ).toContain('exact applied edit');
  });

  it('orders KnowledgeDeltaV1 items deterministically by candidate identity', () => {
    const candidates = [
      projectedCandidate('review-0123456789abcdef-3'),
      projectedCandidate('review-0123456789abcdef-1'),
      projectedCandidate('review-0123456789abcdef-2'),
    ];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(candidates, {minLength: candidates.length, maxLength: candidates.length}),
        ordered => {
          expect(projectKnowledgeDeltaV1(projectedReview(ordered))).toEqual(
            projectKnowledgeDeltaV1(projectedReview(candidates)),
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('projects structured closeout context without mutation', () => {
    const review = {...projectedReview([projectedCandidate('review-0123456789abcdef-1')]), structuredCloseout};
    const before = structuredClone(review);
    expect(projectKnowledgeDeltaV1(review).structuredCloseout).toEqual(structuredCloseout);
    expect(review).toEqual(before);
  });

  it('keeps structured closeout projection deterministic across field ordering', () => {
    fc.assert(
      fc.property(
        fc.record({
          rationale: fc.string({maxLength: 30}),
          constraints: fc.array(fc.string({maxLength: 30}), {maxLength: 4}),
          verificationPerformed: fc.array(fc.string({maxLength: 30}), {maxLength: 4}),
          knowledgeInvalidated: fc.array(fc.string({maxLength: 30}), {maxLength: 4}),
          unresolvedRisks: fc.array(fc.string({maxLength: 30}), {maxLength: 4}),
        }),
        fields => {
          const review = {
            ...projectedReview([projectedCandidate('review-0123456789abcdef-1')]),
            structuredCloseout: {type: 'structured-closeout' as const, version: 1 as const, ...fields},
          };
          const before = structuredClone(review);
          expect(projectKnowledgeDeltaV1(review).structuredCloseout).toEqual(review.structuredCloseout);
          expect(review).toEqual(before);
        },
      ),
      {numRuns: 20},
    );
  });

  it('forms at most three reviewed candidates from a session closeout', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));

    expect(review.candidates).toHaveLength(3);
    expect(review.candidates.map(candidate => candidate.kind)).toEqual(['durable', 'preference', 'handoff']);
    expect(review.candidates.every(candidate => candidate.recommendation === 'create')).toBe(true);
    expect(review.candidates[0]?.proposedText).toContain('## Decisions');
    expect(review.candidates[0]?.proposedText).toContain('## Invariants');
  });

  effectIt.effect('carries structured closeout into the durable candidate body', () =>
    Effect.gen(function* () {
      const review = yield* buildCandidateReview(
        {
          ...input,
          decisions: [],
          invariants: [],
          preferences: [],
          handoff: [],
          rationale: 'Explain why this contract is safe.',
          constraints: ['Keep writes private.'],
          verificationPerformed: ['Focused checks passed.'],
          knowledgeInvalidated: ['The old draft.'],
          unresolvedRisks: ['Follow-up review may refine this.'],
        },
        [],
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      );
      expect(review.structuredCloseout).toEqual({
        type: 'structured-closeout',
        version: 1,
        rationale: 'Explain why this contract is safe.',
        constraints: ['Keep writes private.'],
        verificationPerformed: ['Focused checks passed.'],
        knowledgeInvalidated: ['The old draft.'],
        unresolvedRisks: ['Follow-up review may refine this.'],
      });
      expect(review.candidates[0]?.proposedText).toContain('## Verification performed\n- Focused checks passed.');
      expect(review.candidates[0]?.proposedText).toContain('## Unresolved risks\n- Follow-up review may refine this.');
    }).pipe(provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('omits an all-empty structured closeout instead of creating an empty durable candidate', () =>
    Effect.gen(function* () {
      const review = yield* buildCandidateReview(
        {
          ...input,
          decisions: [],
          invariants: [],
          preferences: [],
          handoff: [],
          rationale: '   ',
          constraints: [],
          verificationPerformed: ['  '],
          knowledgeInvalidated: [],
          unresolvedRisks: [],
        },
        [],
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      );
      expect(review.structuredCloseout).toBeUndefined();
      expect(review.candidates).toEqual([]);
    }).pipe(provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer))),
  );

  it('recommends no action for a duplicate stable memory', async () => {
    const draft = await run(
      buildCandidateReview(
        {...input, handoff: [], invariants: [], preferences: []},
        [
          existing({
            body: '## Decisions\n- Keep application workflows Effect-native.',
          }),
        ],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(draft.candidates[0]).toMatchObject({
      comparison: 'duplicate',
      recommendation: 'no_action',
      targetUri: existing().uri,
    });
  });

  it('flags a changed stable memory as a replacement instead of creating a duplicate', async () => {
    const review = await run(
      buildCandidateReview(
        {...input, handoff: [], invariants: [], preferences: []},
        [existing()],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(review.candidates[0]).toMatchObject({
      comparison: 'replacement',
      recommendation: 'replace',
      targetContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetUri: existing().uri,
    });
  });

  effectIt.effect('warns when a handoff replacement would erase most multi-section continuity state', () =>
    Effect.gen(function* () {
      const targetBody = [
        '## Current state',
        '- Release branch and exact head are recorded for the next agent.',
        '- Runtime ownership and active branch coordination are recorded here.',
        '- Pull request status still needs a fresh remote check.',
        '',
        '## Verification evidence',
        '- Focused tests, typecheck, lint, and exact-head smoke passed.',
        '- The retained safety artifact and recovery path are documented.',
        '',
        '## Ordered next steps',
        '- Refresh remote checks before merging.',
        '- Transfer runtime ownership before the next install.',
        '- Run final admission only after every slice is complete.',
      ].join('\n');
      const review = yield* buildCandidateReview(
        {
          ...input,
          decisions: [],
          handoff: ['Continue release coordination after the remaining checks finish.'],
          invariants: [],
          preferences: [],
        },
        [
          existing({
            body: targetBody,
            metadata: {...existing().metadata, kind: 'handoff'},
            uri: 'threadnote://user/me/memories/handoffs/active/threadnote/recall-memory-formation.md',
          }),
        ],
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      );

      const projected = projectKnowledgeDeltaV1(review).items[0]?.mutationPreview.replacementSafety;
      expect(projected).toMatchObject({
        acknowledged: false,
        classification: 'destructive-loss-risk',
        destructiveLossRisk: true,
        missingSections: ['Current state', 'Verification evidence', 'Ordered next steps'],
        requiresExplicitApproval: true,
        targetNonEmptyLines: 11,
      });
      expect(projected?.warning).toContain('Merge continuity-critical detail');

      const edited = projectKnowledgeDeltaV1(review, {
        bodyText: `${targetBody}\n- Continue release coordination after the remaining checks finish.`,
        candidateId: review.candidates[0]?.candidateId ?? '',
        revision: review.revision,
      }).items[0]?.mutationPreview.replacementSafety;
      expect(edited).toMatchObject({
        classification: 'preserving',
        destructiveLossRisk: false,
        requiresExplicitApproval: false,
      });
    }).pipe(provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer))),
  );

  it('flags material character and line loss at compact boundaries monotonically', () => {
    const compactLines = Array.from({length: 8}, (_unused, index) => `line-${index}`).join('\n');
    expect(assessReplacementSafety('handoff', replacementSafetyBaseline(compactLines), 'line-0')).toMatchObject({
      destructiveLossRisk: true,
      targetBodyCharacters: compactLines.length,
      targetNonEmptyLines: 8,
    });

    const characterTarget = 'x'.repeat(256);
    expect(
      assessReplacementSafety('handoff', replacementSafetyBaseline(characterTarget), 'x'.repeat(179)),
    ).toMatchObject({
      destructiveLossRisk: true,
      retainedCharacterRatio: 179 / 256,
    });
    expect(assessReplacementSafety('handoff', replacementSafetyBaseline('x'.repeat(255)), 'x'.repeat(1))).toMatchObject(
      {destructiveLossRisk: false},
    );

    fc.assert(
      fc.property(fc.integer({min: 0, max: 8}), fc.integer({min: 0, max: 8}), (left, right) => {
        const moreRetained = Math.max(left, right);
        const lessRetained = Math.min(left, right);
        const moreResult = assessReplacementSafety(
          'handoff',
          replacementSafetyBaseline(compactLines),
          Array.from({length: moreRetained}, (_unused, index) => `line-${index}`).join('\n'),
        );
        const lessResult = assessReplacementSafety(
          'handoff',
          replacementSafetyBaseline(compactLines),
          Array.from({length: lessRetained}, (_unused, index) => `line-${index}`).join('\n'),
        );
        if (moreResult.destructiveLossRisk) {
          expect(lessResult.destructiveLossRisk).toBe(true);
        }
      }),
      {numRuns: 40},
    );
  });

  it('requires a fresh review when a legacy replacement has no safety baseline', () => {
    const review = projectedReview([
      projectedCandidate('review-0123456789abcdef-1', {
        comparison: 'replacement',
        recommendation: 'replace',
        targetContentHash: 'a'.repeat(64),
        targetUri: 'threadnote://user/me/memories/handoffs/active/threadnote/legacy.md',
      }),
    ]);

    expect(projectKnowledgeDeltaV1(review).items[0]?.mutationPreview.replacementSafety).toMatchObject({
      acknowledged: false,
      classification: 'review-required',
      requiresExplicitApproval: true,
      warning: expect.stringContaining('Run review_session_context again'),
    });
  });

  it('does not form durable candidates without an evidence pointer', async () => {
    const review = await run(
      buildCandidateReview(
        {...input, evidence: [], sourceCommit: undefined, sourceSessionId: undefined},
        [],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(review.candidates).toEqual([]);
  });

  it('uses the global preference topic as its storage identity across projects', async () => {
    const preference = existing({
      body: '## Preferences\n- Ask before publishing.',
      metadata: {
        kind: 'preference',
        project: 'another-project',
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-07-22T00:00:00.000Z',
        topic: 'recall-memory-formation',
      },
      uri: 'threadnote://user/me/memories/preferences/recall-memory-formation.md',
    });
    const review = await run(
      buildCandidateReview(
        {...input, decisions: [], handoff: [], invariants: [], preferences: ['Ask before creating durable memory.']},
        [preference],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(review.candidates[0]).toMatchObject({
      recommendation: 'replace',
      targetUri: preference.uri,
    });
  });

  it('ignores symlinked memory escapes and cycles during candidate comparison', async () => {
    const scanDirectory = await mkdtemp('threadnote-candidate-scan-');
    try {
      const projectDirectory = join(
        scanDirectory,
        'data',
        'local',
        'user',
        'me',
        'memories',
        'durable',
        'projects',
        'threadnote',
      );
      const outsidePath = join(scanDirectory, 'outside.md');
      const memory = (body: string) =>
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: safe-scan',
          'source_agent_client: test',
          'timestamp: 2026-07-23T00:00:00.000Z',
          '',
          body,
        ].join('\n');
      await mkdir(projectDirectory, {recursive: true});
      await writeFile(join(projectDirectory, 'safe.md'), memory('safe candidate comparison'), 'utf8');
      await writeFile(outsidePath, memory('escaped candidate comparison'), 'utf8');
      await symlink(outsidePath, join(projectDirectory, 'escaped.md'));
      await symlink(projectDirectory, join(projectDirectory, 'cycle'), 'dir');

      const records = await run(
        readActiveProjectMemories({account: 'local', agentContextHome: scanDirectory, user: 'me'}, 'threadnote'),
      );

      expect(records.map(record => record.body.trim())).toEqual(['safe candidate comparison']);
    } finally {
      await rm(scanDirectory, {force: true, recursive: true});
    }
  });

  effectIt.effect('normalizes Windows filesystem separators in comparison target URIs', () =>
    Effect.gen(function* () {
      const agentContextHome = 'C:\\context';
      const projectDirectory = 'C:\\context\\data\\local\\user\\me\\memories\\durable\\projects\\threadnote';
      const memoryPath = `${projectDirectory}\\recall.md`;
      const memoryContent = [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: recall-memory-formation',
        'source_agent_client: test',
        'timestamp: 2026-07-23T00:00:00.000Z',
        '',
        '## Decisions',
        '- Keep application workflows Effect-native.',
      ].join('\n');
      const WindowsFileSystemLayer = FileSystem.layerNoop({
        readDirectory: path => Effect.succeed(path === projectDirectory ? ['recall.md'] : []),
        readFileString: () => Effect.succeed(memoryContent),
        realPath: path => Effect.succeed(path),
        stat: path =>
          Effect.succeed({
            atime: Option.none(),
            birthtime: Option.none(),
            blksize: Option.none(),
            blocks: Option.none(),
            dev: 0n,
            gid: Option.none(),
            ino: Option.none(),
            mode: 0,
            mtime: Option.none(),
            nlink: Option.none(),
            rdev: Option.none(),
            size: ByteSize.zero,
            type: path === memoryPath ? 'File' : 'Directory',
            uid: Option.none(),
          } satisfies FileSystem.File.Info),
      });
      const WindowsTestLayer = Layer.mergeAll(BunCrypto.layer, BunPath.layerWin32, WindowsFileSystemLayer);
      const records = yield* readActiveProjectMemories(
        {account: 'local', agentContextHome, user: 'me'},
        'threadnote',
      ).pipe(provideTestLayer(WindowsTestLayer));
      const review = yield* buildCandidateReview(
        {...input, handoff: [], invariants: [], preferences: []},
        records,
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      ).pipe(provideTestLayer(WindowsTestLayer));

      expect(records[0]?.uri).toBe('threadnote://user/me/memories/durable/projects/threadnote/recall.md');
      expect(review.candidates[0]).toMatchObject({
        comparison: 'duplicate',
        recommendation: 'no_action',
        targetUri: 'threadnote://user/me/memories/durable/projects/threadnote/recall.md',
      });
    }),
  );

  it('rejects unbounded closeout arrays, items, and total payloads', () => {
    expect(validateSessionCloseoutInput({...input, evidence: Array.from({length: 33}, () => 'file.md')})).toContain(
      'evidence exceeds',
    );
    expect(validateSessionCloseoutInput({...input, decisions: ['x'.repeat(2_001)]})).toContain(
      'decisions contains an item',
    );
    expect(
      validateSessionCloseoutInput({
        ...input,
        decisions: Array.from({length: 32}, () => 'é'.repeat(1_100)),
        handoff: Array.from({length: 32}, () => 'é'.repeat(1_100)),
      }),
    ).toContain('UTF-8 bytes');
  });
});

describe('candidate review persistence', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-candidates-');
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it('persists revisions and appends audit events through Effect FileSystem', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));
    await run(saveCandidateReview(directory, review));
    const loaded = await run(loadCandidateReview(directory, review.reviewId));
    const deferred = candidateReviewWithState(loaded, loaded.candidates[0]?.candidateId ?? '', 'deferred', {
      action: 'defer',
      at: '2026-07-23T10:01:00.000Z',
    });
    await run(saveCandidateReview(directory, deferred));
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');

    const persisted = await run(loadCandidateReview(directory, review.reviewId));
    expect(persisted.revision).toBe(2);
    expect(persisted.auditEvents).toEqual([
      {
        action: 'create_review',
        at: '2026-07-23T10:00:00.000Z',
        reviewId: review.reviewId,
        revision: 1,
      },
      {
        action: 'defer',
        at: '2026-07-23T10:01:00.000Z',
        candidateId: deferred.candidates[0]?.candidateId,
        reviewId: deferred.reviewId,
        revision: deferred.revision,
      },
    ]);
    expect(auditPath).toContain('/threadnote/candidates/v1/audit.jsonl');
  });

  effectIt.effect('loads CandidateReview v1 with empty citations instead of dropping the review', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({prefix: 'threadnote-candidates-v1-'}),
        candidateDirectory => fs.remove(candidateDirectory, {force: true, recursive: true}).pipe(Effect.ignore),
      );
      const review = yield* buildCandidateReview(
        input,
        [],
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      );
      const {codeCitations: _v2Citations, ...legacy} = review;
      const reviewDirectory = path.join(temporaryDirectory, 'threadnote', 'candidates', 'v1', 'reviews');
      yield* fs.makeDirectory(reviewDirectory, {recursive: true});
      yield* fs.writeFileString(
        path.join(reviewDirectory, `${review.reviewId}.json`),
        `${JSON.stringify({...legacy, version: 1})}\n`,
      );

      expect(yield* loadCandidateReview(temporaryDirectory, review.reviewId)).toMatchObject({
        codeCitations: [],
        reviewId: review.reviewId,
        version: 2,
      });
    }).pipe(provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('persists replacement-safety refresh revisions and audit events', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporaryDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({prefix: 'threadnote-candidate-safety-refresh-'}),
        candidateDirectory => fs.remove(candidateDirectory, {force: true, recursive: true}).pipe(Effect.ignore),
      );
      const review = yield* buildCandidateReview(
        input,
        [existing()],
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      );
      const candidateId = review.candidates[0]?.candidateId ?? '';
      const refreshed = candidateReviewWithReplacementSafety(
        review,
        candidateId,
        '## Decisions\n- Keep application workflows Effect-native.\n\n## Constraints\n- Preserve callers.',
        'a'.repeat(64),
        '2026-07-23T10:01:00.000Z',
      );
      if (!refreshed) throw new Error('expected a replacement candidate');

      yield* saveCandidateReview(temporaryDirectory, refreshed);
      const loaded = yield* loadCandidateReview(temporaryDirectory, review.reviewId);

      expect(loaded.revision).toBe(2);
      expect(loaded.candidates[0]).toMatchObject({
        replacementSafetyBaseline: {
          sectionHeadings: ['Decisions', 'Constraints'],
          version: 1,
        },
        targetContentHash: 'a'.repeat(64),
      });
      expect(loaded.auditEvents.at(-1)).toMatchObject({
        action: 'refresh_safety',
        candidateId,
        revision: 2,
      });
    }).pipe(provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('retains destructive replacement approval in review and aggregate audit events', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({prefix: 'threadnote-candidate-audit-'}),
        candidateDirectory => fs.remove(candidateDirectory, {force: true, recursive: true}).pipe(Effect.ignore),
      );
      const review = yield* buildCandidateReview(
        input,
        [],
        DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T10:00:00.000Z')),
      );
      const candidateId = review.candidates[0]?.candidateId ?? '';
      const applying = candidateReviewWithApplying(
        review,
        candidateId,
        {
          allowDestructiveReplacement: true,
          bodyText: '## Decisions\n- Keep the explicitly approved replacement.',
          contentHash: 'a'.repeat(64),
          operation: 'replace',
          replaceUri: 'threadnote://user/me/memories/durable/projects/threadnote/old.md',
          targetUri: 'threadnote://user/me/memories/durable/projects/threadnote/new.md',
        },
        '2026-07-23T10:01:00.000Z',
      );
      const applied = candidateReviewWithState(applying, candidateId, 'applied', {
        action: 'apply',
        allowDestructiveReplacement: true,
        at: '2026-07-23T10:02:00.000Z',
        memoryUri: 'threadnote://user/me/memories/durable/projects/threadnote/new.md',
      });
      yield* saveCandidateReview(temporaryDirectory, applied);

      const loaded = yield* loadCandidateReview(temporaryDirectory, review.reviewId);
      expect(loaded.auditEvents.filter(event => event.action === 'begin_apply' || event.action === 'apply')).toEqual([
        expect.objectContaining({action: 'begin_apply', allowDestructiveReplacement: true}),
        expect.objectContaining({action: 'apply', allowDestructiveReplacement: true}),
      ]);
      const auditPath = path.join(temporaryDirectory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
      const auditEvents = (yield* fs.readFileString(auditPath))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as {readonly allowDestructiveReplacement?: boolean});
      expect(auditEvents.filter(event => event.allowDestructiveReplacement === true)).toHaveLength(2);
    }).pipe(provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer))),
  );

  it('serializes concurrent decisions for one review and deduplicates audit writes', async () => {
    const trace: string[] = [];
    const locked = (name: string) =>
      withCandidateReviewLock(
        directory,
        'review-lock-test',
        Effect.gen(function* () {
          yield* Effect.sync(() => trace.push(`${name}:start`));
          yield* Effect.sleep(75);
          yield* Effect.sync(() => trace.push(`${name}:end`));
        }),
      );

    await run(Effect.all([locked('first'), locked('second')], {concurrency: 2}));
    expect(trace[0]?.split(':')[0]).toBe(trace[1]?.split(':')[0]);
    expect(trace[2]?.split(':')[0]).toBe(trace[3]?.split(':')[0]);
    expect(trace[0]?.split(':')[0]).not.toBe(trace[2]?.split(':')[0]);

    const event = {
      action: 'apply' as const,
      at: '2026-07-23T10:01:00.000Z',
      candidateId: 'candidate-1',
      reviewId: 'review-lock-test',
      revision: 2,
    };
    const auditPath = await run(appendCandidateAudit(directory, event));
    await run(appendCandidateAudit(directory, event));
    expect((await readFile(auditPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('keeps no-op decisions and per-review audit history bounded', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));
    const candidateId = review.candidates[0]?.candidateId ?? '';
    const deferred = candidateReviewWithState(review, candidateId, 'deferred', {
      action: 'defer',
      at: '2026-07-23T10:01:00.000Z',
    });
    expect(
      candidateReviewWithState(deferred, candidateId, 'deferred', {
        action: 'defer',
        at: '2026-07-23T10:02:00.000Z',
      }),
    ).toBe(deferred);

    let bounded = deferred;
    for (let revision = 3; revision <= 180; revision += 1) {
      bounded = candidateReviewWithAuditEvent(bounded, {
        action: 'begin_apply',
        at: `2026-07-23T10:${String(revision).padStart(2, '0')}:00.000Z`,
        candidateId,
        reviewId: review.reviewId,
        revision,
      });
    }
    await run(saveCandidateReview(directory, bounded));
    const persisted = await run(loadCandidateReview(directory, review.reviewId));

    expect(persisted.auditEvents).toHaveLength(100);
    expect(persisted.auditEvents[0]?.action).toBe('create_review');
  });

  it('reconciles a persisted review transition after aggregate audit synchronization fails', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
    await mkdir(auditPath, {recursive: true});

    await expect(run(saveCandidateReview(directory, review))).rejects.toBeDefined();
    await rm(auditPath, {force: true, recursive: true});

    await expect(run(loadCandidateReview(directory, review.reviewId))).resolves.toMatchObject({
      reviewId: review.reviewId,
    });
    expect((await readFile(auditPath, 'utf8')).trim()).toContain('"action":"create_review"');
  });

  it('does not let an old review replay evict newer bounded audit events', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2020-01-01T00:00:00.000Z')));
    await run(saveCandidateReview(directory, review));
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
    const newerEvents = Array.from({length: 5_000}, (_unused, index) => ({
      action: 'apply' as const,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      candidateId: `candidate-${index}`,
      reviewId: `review-${index}`,
      revision: 2,
    }));
    const boundedAudit = `${newerEvents.map(event => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(auditPath, boundedAudit, 'utf8');

    await run(loadCandidateReview(directory, review.reviewId));

    expect(await readFile(auditPath, 'utf8')).toBe(boundedAudit);
  });

  it('preserves workflow order when audit transitions share a timestamp', async () => {
    const at = '2026-07-23T10:00:00.000Z';
    const reviewId = 'same-timestamp-review';
    for (const [index, action] of ['create_review', 'begin_apply', 'apply', 'defer', 'reject'].entries()) {
      await run(
        appendCandidateAudit(directory, {
          action: action as 'apply' | 'begin_apply' | 'create_review' | 'defer' | 'reject',
          at,
          candidateId: index === 0 ? undefined : `candidate-${index}`,
          reviewId,
          revision: index + 1,
        }),
      );
    }
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
    const actions = (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as {readonly action: string}).action);

    expect(actions).toEqual(['create_review', 'begin_apply', 'apply', 'defer', 'reject']);
  });
});
