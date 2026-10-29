import {Array as EffectArray, Option as EffectOption} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {buildContextHealthReport} from '@threadnote/context/health';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {
  createMemoryCodeCitation,
  formatMemoryCodeCitation,
  preserveMemoryCodeCitationAnchor,
} from '@threadnote/memory/code/citation';
import {ContextHealthPanel} from '@threadnote/manager/attention-view';
import {ManagerNavigation, useContextHealthDecisionCount} from '../../src/navigation.js';
import {MaintenanceControls} from '../../src/attention/maintenance_controls.js';
import {ContextMaintenanceView, adoptMaintenanceEvidence} from '@threadnote/manager/attention/maintenance-view';
import {MaintenanceCaseDialog} from '../../src/attention/maintenance_dialogs.js';
import {HealthDetail} from '../../src/attention_details.js';
import {TopicReviewContent} from '../../src/attention/topic_review.js';
import type {ManagerTopicReviewV1, ManagerAutomaticReview} from '@threadnote/manager/attention/topic-contracts';
import {createReviewedSupportSnapshot} from '@threadnote/memory/reviewed-support';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {
  ManagerContextHealthResponseV1,
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenancePacketV2,
  ManagerContextMaintenanceStatusV2,
} from '@threadnote/manager/attention/contracts';
import {ManagerLiveProvider, useManagerLiveResource} from '../../src/live/provider.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

let root: Root | undefined;
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const report = (project = 'threadnote'): ManagerContextHealthResponseV1 => ({
  project,
  version: 1,
  findings: [],
  recordPreviews: [],
  limit: 100,
  omittedFindings: 0,
  recordsScanned: 1_712,
  repositoryEvidence: {state: 'unavailable', reason: 'repository-unavailable'},
  status: 'unknown',
  semanticCompleteness: {
    version: 2,
    state: 'partial',
    eligibleRecords: 384,
    analyzedRecords: 11,
    unknownRecords: 373,
    claimsAnalyzed: 11,
    supportedClaims: 11,
    unsupportedClaims: 0,
    coverage: 'bounded-English-extraction',
    contradictionCount: 0,
    pairsCompared: 0,
    omittedContradictions: 0,
    unknownReasons: [{reason: 'record-limit', count: 373}],
  },
  maintenance: {
    version: 2,
    actionableFindings: 0,
    affectedMemories: 0,
    automaticallyManagedFindings: 4,
    historicalFindings: 2,
    citationCoverage: {
      eligible: 2_013,
      checked: 96,
      deferred: 1_917,
      currentVerified: 94,
      historicalVerified: 2,
      unverified: 1_917,
      state: 'partial',
      reasons: [{reason: 'citation-limit', count: 1_917}],
    },
    semanticCoverage: {
      version: 2,
      state: 'partial',
      eligibleRecords: 384,
      analyzedRecords: 11,
      unknownRecords: 373,
      claimsAnalyzed: 11,
      supportedClaims: 11,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
      contradictionCount: 0,
      pairsCompared: 0,
      omittedContradictions: 0,
      unknownReasons: [{reason: 'record-limit', count: 373}],
    },
  },
});
const status = (): ManagerContextMaintenanceStatusV2 => ({
  version: 2,
  state: 'waiting-evidence',
  generation: 'generation-one',
  paused: false,
  projects: [
    {
      project: 'threadnote',
      generation: 'corpus-one',
      cursor: 96,
      checked: 96,
      eligible: 1_712,
      eligibleCitations: 2_013,
      checkedCitations: 96,
    },
  ],
  cases: [],
  receipts: [],
  lastProgressAt: '2026-10-03T10:00:00Z',
});
async function render(element: React.ReactElement) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
}
const props = {
  onProjectChange: () => undefined,
  onOpenLibrary: () => undefined,
  onChanged: () => undefined,
  projects: ['threadnote'],
  loadingMore: false,
  onLoadMore: () => undefined,
};

describe('context maintenance view', () => {
  it('keeps the explicit legacy health fallback current while a project stays open', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async (input: string) =>
        new Response(
          JSON.stringify(Effect.pipe(input, EffectString.startsWith('/api/context-health?')) ? report() : status()),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    await render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={0} />);
    const healthReads = () =>
      EffectArray.filter(
        fetch.mock.calls,
        ([path], index) =>
          index in fetch.mock.calls && Effect.pipe(path, EffectString.startsWith('/api/context-health?')),
      ).length;
    expect(healthReads()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(healthReads()).toBe(2);
  });
  it('automatically recovers a stale review after a successful current evidence read', async () => {
    const finding: ManagerContextHealthResponseV1['findings'][number] = {
      id: 'citation-one',
      category: 'citation-changed',
      confidence: 'high',
      repairability: 'reviewable',
      severity: 'medium',
      summary: 'The source citation changed.',
      uris: ['threadnote://memory/one'],
      repair: {
        kind: 'repair-citation',
        subjectUri: 'threadnote://memory/one',
        targetUri: 'threadnote://memory/one',
        summary: 'Refresh the source citation.',
      },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({...report(), findings: [finding]})));
    vi.stubGlobal('fetch', fetch);
    const detail = (stale: boolean) => (
      <HealthDetail
        finding={finding}
        project="threadnote"
        repairsAvailable
        stale={stale}
        onChanged={() => undefined}
        onClose={() => undefined}
        onOpenLibrary={() => undefined}
      />
    );
    await render(detail(true));
    const preview = () =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          [...document.querySelectorAll<HTMLButtonElement>('dialog button')],
          button =>
            button.textContent !== null && Effect.pipe(button.textContent, EffectString.includes('Preview repair')),
        ),
      );
    expect(preview()?.disabled).toBe(false);
    await act(async () => root?.render(detail(false)));
    expect(preview()?.disabled).toBe(false);
    await act(async () => root?.render(detail(false)));
    expect(preview()?.disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/context-health?project=threadnote'),
      expect.anything(),
    );
  });
  it('shares an ACK-gated maintenance read across mounted consumers and closes the tab socket', async () => {
    class Socket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: {data: string}) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      sent: Array<{generation: number; type: string}> = [];
      closed = false;
      send(value: string) {
        this.sent.push(JSON.parse(value));
      }
      close() {
        this.closed = true;
      }
      emit(value: Record<string, unknown>) {
        this.onmessage?.({data: JSON.stringify({version: 1, ...value})});
      }
    }
    const sockets: Socket[] = [];
    vi.stubGlobal(
      'WebSocket',
      class extends Socket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ticket: 'one'}), {status: 200})),
    );
    const reader = vi.fn(async () => ({count: 1}));
    function Consumer() {
      const {snapshot} = useManagerLiveResource(
        'context-maintenance',
        'threadnote',
        reader,
        (value): value is {count: number} =>
          typeof value === 'object' && value !== null && 'count' in value && typeof value.count === 'number',
      );
      return <span>{snapshot.status}</span>;
    }
    await render(
      <ManagerLiveProvider account="local">
        <Consumer />
        <Consumer />
      </ManagerLiveProvider>,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await act(async () => {
      socket.readyState = 1;
      socket.onopen?.();
      socket.emit({type: 'welcome', epoch: 'one', topics: ['context-maintenance'], heartbeatMilliseconds: 15_000});
    });
    expect(reader).not.toHaveBeenCalled();
    const subscribe = EffectOption.getOrUndefined(
      EffectArray.findFirst(socket.sent, value => value.type === 'subscribe'),
    );
    expect(subscribe).toBeDefined();
    await act(async () => {
      socket.emit({type: 'subscribed', epoch: 'one', generation: subscribe!.generation, startingSequence: 0});
    });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('ready');
    await act(async () => root?.unmount());
    root = undefined;
    expect(socket.closed).toBe(true);
  });
  it.each([
    {result: 'verified', retain: 'none'},
    {result: 'verified', retain: 'relation'},
    {result: 'verified', retain: 'newer'},
    {result: 'verified', retain: 'new-hash'},
    {result: 'refused', retain: 'none'},
    {result: 'unverified', retain: 'none'},
  ] as const)(
    'reconciles automatic attention immediately with paused status and held stale responses ($result/$retain)',
    async ({result, retain}) => {
      vi.useFakeTimers();
      const uri = 'threadnote://user/test/memories/durable/projects/threadnote/limit.md';
      const capture = (value: number) =>
        createMemoryCodeCitation({
          version: 1,
          extractorSet: 'test',
          fileContentHash: {algorithm: 'sha256', value: sha256HexSync(`const limit = ${value};`)},
          path: 'limit.ts',
          repositoryId: Effect.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect.pipe(String(value), EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect.pipe(String(value), EffectString.repeat(40))}`,
          target: {kind: 'file'},
        });
      const original = capture(8);
      const recaptured = preserveMemoryCodeCitationAnchor(original, capture(9));
      expect(recaptured.anchorId).toBe(original.id);
      expect(recaptured.id).not.toBe(original.id);
      const citationId = recaptured.id;
      const before = `MEMORY\nschema_version: 11\nkind: durable\nproject: threadnote\nmemory_id: tn_limit\ncode_citation: ${formatMemoryCodeCitation(recaptured)}\n\nThe limit is 8.`;
      const record = parseMemoryDocument(uri, before);
      if (!record) throw new Error('Recaptured canonical fixture did not parse.');
      expect(record.metadata.codeCitations).toEqual([recaptured]);
      const hash = sha256HexSync(before);
      const oldReport = buildContextHealthReport({
        project: 'threadnote',
        records: [record],
        now: new Date('2026-10-22T00:00:00.000Z'),
        includeFindingCategories: ['citation-changed'],
        citationValidations: [
          {
            uri,
            receipts: [
              {
                citationId,
                candidateCount: 1,
                coverage: 'current-complete',
                kind: 'file',
                observedAt: '2026-10-22T00:00:00.000Z',
                reason: 'source-changed',
                status: 'changed',
                strategy: 'file-path',
                validatorVersion: 1,
              },
            ],
          },
        ],
      });
      expect(oldReport.findings).toHaveLength(1);
      const oldFinding = oldReport.findings[0];
      expect(oldFinding.caseIdentity?.slot).toBe(`anchor:${original.id}`);
      expect(oldFinding.repair.targetUri).toBe(`${uri}#${recaptured.id}`);
      const body = 'The limit is 9.';
      const active = createReviewedSupportSnapshot({
        bodyHash: sha256HexSync(body),
        paragraphs: [{ordinal: 0, hash: sha256HexSync(body), role: 'unknown', support: 'unresolved', evidenceIds: []}],
        sources: [],
        acceptance: {
          reviewId: 'review-automatic',
          approvedAt: '2026-10-22T00:00:00.000Z',
          targetBeforeHash: hash,
          preparationDigest: hash,
          sourceVectorDigest: hash,
        },
      });
      const reviewedSupport = {type: 'reviewed-memory-support' as const, version: 1 as const, active};
      const content = `MEMORY\nschema_version: 11\nkind: durable\nproject: threadnote\nmemory_id: tn_limit\ncode_citation: ${formatMemoryCodeCitation(recaptured)}\nreviewed_support: ${JSON.stringify(reviewedSupport)}\n\n${body}`;
      const written: ManagerAutomaticReview = {
        version: 1,
        kind: 'automatic-memory-review',
        project: 'threadnote',
        reviewId: 'review-automatic',
        revision: 4,
        state: 'applied',
        targetUri: uri,
        targetHash: hash,
        evidenceRevision: hash,
        purpose: 'automatic',
        acceptedBody: 'The limit is 8.',
        proposal: {
          version: 2,
          kind: 'automatic',
          body,
          finalBodyHash: sha256HexSync(body),
          changedOrdinals: [0],
          draft: {
            version: 2,
            kind: 'automatic',
            purpose: 'automatic',
            targetHash: hash,
            observationRevision: hash,
            packetDigest: hash,
            outcome: 'propose-update',
            operations: [],
            reviewedHandles: [],
            rationale: 'Changed source.',
            unresolvedQuestions: [],
            removedClaims: [],
            paragraphDecisions: [],
          },
        },
        sourceEvidence: [],
        coverage: {
          outcome: 'complete',
          scope: 'recorded-only',
          searchedScopes: [],
          omittedSources: 0,
          omittedParagraphs: 0,
        },
        canApply: false,
        canFinishVerification: false,
        verified: result === 'verified',
        approval: {
          stage: 'written',
          reviewRevision: 2,
          approvalDigest: hash,
          content,
          contentHash: sha256HexSync(content),
          metadataDiff: [],
          reviewedSupport,
        },
      };
      const observation = {
        caseId: oldFinding.caseId!,
        project: 'threadnote',
        memoryId: 'tn_limit',
        family: 'citation',
        slot: oldFinding.caseIdentity!.slot,
        evidenceRevision: Effect.pipe('b', EffectString.repeat(64)),
        subjectUri: uri,
        subjectContentHashes: [{uri, hash}],
        disposition: 'needs-decision' as const,
        reason: 'source-changed',
        firstSeen: 'now',
        lastSeen: 'now',
        lastChecked: 'now',
        attemptCount: 1,
        events: [],
      };
      const staleStatus: ManagerContextMaintenanceStatusV2 = {
        ...status(),
        paused: true,
        cases: [
          observation,
          ...(retain === 'relation' ? [{...observation, caseId: 'unrelated-relation', family: 'relation'}] : []),
        ],
        counts: {decisionMemories: 1, 'needs-decision': retain === 'relation' ? 2 : 1},
      };
      const staleReport: ManagerContextHealthResponseV1 = {
        ...oldReport,
        repositoryEvidence: {state: 'available'},
        recordPreviews: [
          {
            uri,
            title: 'Limit',
            kind: 'durable',
            excerpt: record.body,
            contentHash: hash,
            code: [{citationId, path: recaptured.path, findingIds: [oldFinding.id]}],
          },
        ],
      };
      let applying = false;
      let statusReads = 0;
      let reportReads = 0;
      const lateStatus = Promise.withResolvers<Response>();
      const lateReport = Promise.withResolvers<Response>();
      const response = (value: unknown, code = 200) => new Response(JSON.stringify(value), {status: code});
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        if (url.pathname === '/api/shares/conflicts') return response({conflicts: []});
        if (url.searchParams.get('view') === 'controls') return response({paused: true});
        if (url.pathname === '/api/context-health') {
          reportReads += 1;
          return reportReads > 1 ? lateReport.promise : response(staleReport);
        }
        if (url.pathname === '/api/attention/context-maintenance') {
          statusReads += 1;
          return statusReads > 1 ? lateStatus.promise : response(staleStatus);
        }
        if (url.pathname === '/api/attention/automatic-memory')
          return response({
            version: 1,
            project: 'threadnote',
            omitted: 0,
            items: [
              {
                uri,
                title: 'Limit',
                targetHash: hash,
                state: 'ready',
                reviewId: written.reviewId,
                evidenceRevision: hash,
                coverage: written.coverage,
                paragraphs: [],
                route: 'personal-review',
                legacyUncited: false,
              },
            ],
          });
        if (url.pathname === '/api/attention/automatic-review') {
          if (init?.method === 'POST') {
            applying = true;
            return result === 'refused' ? response({error: 'The exact source changed.'}, 409) : response(written);
          }
          return response({
            ...written,
            state: 'pending',
            verified: false,
            canApply: true,
            approval: {...written.approval!, stage: 'preview'},
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      const counts: (number | undefined)[] = [];
      await render(
        <ContextHealthPanel
          {...props}
          project="threadnote"
          refreshGeneration={0}
          onDecisionCountChange={(_project, count) => counts.push(count)}
        />,
      );
      expect(document.querySelectorAll('.health-decision-card')).toHaveLength(1);
      const click = async (text: string) => {
        const button = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            [...document.querySelectorAll<HTMLButtonElement>('button')],
            item =>
              Effect.pipe(item.textContent, effectOptionalString =>
                effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
              ) === text,
          ),
        );
        expect(button, text).toBeDefined();
        await act(async () => button!.click());
      };
      await click('Review update');
      await click('Apply update');
      expect(applying).toBe(true);
      if (result === 'verified') {
        expect(document.querySelector('dialog')).toBeNull();
        expect(document.body.textContent).toContain('Update saved and verified');
        expect(document.querySelector('.automatic-memory-card')).toBeNull();
        expect(document.querySelectorAll('.health-decision-card')).toHaveLength(retain === 'relation' ? 1 : 0);
        expect(counts.at(-1)).toBe(retain === 'relation' ? 1 : 0);
        expect(statusReads).toBe(2);
        expect(reportReads).toBe(2);
      } else {
        expect(document.querySelector('dialog')).not.toBeNull();
        expect(document.querySelectorAll('.health-decision-card')).toHaveLength(1);
        expect(counts.at(-1)).toBeGreaterThan(0);
        expect(document.body.textContent).not.toContain('Update saved and verified');
      }
      await act(async () => {
        lateStatus.resolve(
          response(
            retain === 'newer'
              ? {
                  ...staleStatus,
                  generation: 'newer-source',
                  cases: [{...observation, evidenceRevision: 'new-source-revision'}],
                }
              : retain === 'new-hash'
                ? {
                    ...staleStatus,
                    generation: 'new-target-hash',
                    cases: [
                      {...observation, subjectContentHashes: [{uri, hash: Effect.pipe('c', EffectString.repeat(64))}]},
                    ],
                  }
                : staleStatus,
          ),
        );
        lateReport.resolve(response(staleReport));
      });
      expect(document.querySelectorAll('.health-decision-card')).toHaveLength(
        result === 'verified' && retain === 'none' ? 0 : 1,
      );
      if (result === 'verified') expect(counts.at(-1)).toBe(retain === 'none' ? 0 : 1);
    },
  );
  it.each([404, 409])('falls back to the ordinary topic packet only after case selector %s', async statusCode => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://manager.test');
        requests.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/api/consolidation-models') return new Response(JSON.stringify({models: []}));
        return new Response(JSON.stringify({error: `Selector ${statusCode}`}), {status: statusCode});
      }),
    );
    await render(
      <TopicReviewContent
        project="threadnote"
        caseId={`health-case-${Effect.pipe('b', EffectString.repeat(40))}`}
        onChanged={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    );
    expect(
      EffectArray.some(requests, request =>
        Effect.pipe(request, EffectString.includes('/api/attention/topic-review?project=threadnote&caseId=')),
      ),
    ).toBe(true);
    expect(
      EffectArray.some(requests, request =>
        Effect.pipe(request, EffectString.includes('/api/attention/context-maintenance?project=threadnote&caseId=')),
      ),
    ).toBe(statusCode === 404);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(`Selector ${statusCode}`);
  });
  it('recovers a stale written topic from a fresh case-only health mount after packet refusal', async () => {
    const caseId = `health-case-${Effect.pipe('b', EffectString.repeat(40))}`;
    const reviewId = `review-${Effect.pipe('a', EffectString.repeat(24))}`;
    const hash = Effect.pipe('c', EffectString.repeat(64));
    const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
    const item = {
      caseId,
      project: 'threadnote',
      memoryId: 'tn_topic',
      subjectUri: uri,
      subjectContentHashes: [{uri, hash}],
      family: 'topic-maintenance',
      slot: 'declared-support',
      evidenceRevision: hash,
      disposition: 'needs-decision' as const,
      reason: 'source-changed',
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    };
    let snapshot: ManagerContextMaintenanceStatusV2 = {
      ...status(),
      cases: [item],
      counts: {decisionMemories: 1, 'needs-decision': 1},
    };
    const saved: ManagerTopicReviewV1 = {
      version: 1,
      kind: 'topic-maintenance',
      project: 'threadnote',
      reviewId,
      revision: 4,
      state: 'applied',
      topic: 'Topic',
      caseId,
      caseObservationMatches: true,
      targetUri: uri,
      targetHash: hash,
      acceptedBody: 'Saved claim.',
      observationRevision: hash,
      coverage: 'declared-only',
      generation: {origin: 'manual', agent: 'user', model: 'manual', attempts: 0, usage: {status: 'unavailable'}},
      draft: {
        version: 1,
        targetHash: hash,
        observationRevision: hash,
        packetDigest: hash,
        outcome: 'propose-revalidation',
        operations: [],
        reviewedHandles: ['current:source'],
        rationale: 'Reviewed source.',
        unresolvedQuestions: [],
        removedClaims: [],
      },
      proposal: {body: 'Saved claim.', finalBodyHash: hash, changedOrdinals: []},
      paragraphs: [],
      additionalDependencies: [],
      support: [],
      warnings: [],
      canApply: false,
      canFinishVerification: true,
      approval: {
        stage: 'written',
        reviewRevision: 3,
        approvalDigest: hash,
        content: 'SAVED DOCUMENT',
        contentHash: hash,
        metadataDiff: [],
      },
    };
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://manager.test');
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (url.pathname === '/api/consolidation-models') return new Response(JSON.stringify({models: []}));
        if (url.pathname === '/api/shares/conflicts') return new Response(JSON.stringify({conflicts: []}));
        if (url.pathname === '/api/context-health') return new Response(JSON.stringify(report()));
        if (url.pathname === '/api/attention/topic-review') {
          if (init?.method === 'POST') {
            const action = JSON.parse(String(init.body));
            expect(action).toMatchObject({
              action: 'apply',
              reviewId,
              revision: 3,
              approvalDigest: hash,
              approved: true,
            });
            snapshot = {...snapshot, generation: 'resolved', cases: [], counts: {decisionMemories: 0}};
            return new Response(JSON.stringify(saved));
          }
          return new Response(JSON.stringify(saved));
        }
        if (url.pathname === '/api/attention/context-maintenance') {
          if (init?.method === 'POST')
            return new Response(
              JSON.stringify({
                outcome: 'ready',
                item,
                packet: {
                  version: 2,
                  project: 'threadnote',
                  caseId,
                  memoryUri: uri,
                  evidenceRevision: hash,
                  expectedContentHash: hash,
                  reason: 'source-changed',
                  choices: [],
                  allowedOperations: [],
                  instructions: 'Review current evidence.',
                },
              }),
            );
          if (url.searchParams.get('caseId') && url.searchParams.get('view') !== 'status')
            return new Response(JSON.stringify({error: 'The accepted baseline changed.'}), {status: 409});
          return new Response(JSON.stringify(snapshot));
        }
        return new Response(JSON.stringify(snapshot));
      }),
    );
    const mount = async () => {
      await render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={0} />);
    };
    await mount();
    const open = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        __effectArrayValue =>
          !!(button =>
            Effect.pipe(button.textContent, effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect.pipe(effectOptionalString, EffectString.includes('Review memory and evidence')),
            ))(__effectArrayValue),
      ),
    );
    expect(open).toBeDefined();
    await act(async () => open!.click());
    const finish = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        button =>
          Effect.pipe(button.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
          ) === 'Finish saved update verification',
      ),
    );
    expect(finish).toBeDefined();
    expect(
      EffectArray.some(requests, request =>
        Effect.pipe(request, EffectString.includes(`topic-review?project=threadnote&caseId=${caseId}`)),
      ),
    ).toBe(true);
    await act(async () => finish!.click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(snapshot.cases).toHaveLength(0);
    await act(async () => root?.unmount());
    root = undefined;
    await mount();
    expect(document.body.textContent).not.toContain('1 memory needs your decision');
  });
  it.each([false, true])(
    'reconciles only a confirmed topic apply while stale polls are pending (failure: %s)',
    async failed => {
      vi.useFakeTimers();
      const hash = Effect.pipe('a', EffectString.repeat(64));
      const uri = 'threadnote://memory/topic';
      const citationId = `tncc_${Effect.pipe('1', EffectString.repeat(40))}`;
      const healthReport: ManagerContextHealthResponseV1 = {
        ...report(),
        findings: [
          {
            id: 'enrolled-source-changed',
            category: 'citation-changed',
            classification: 'actionable',
            confidence: 'high',
            severity: 'high',
            summary: 'Enrolled source changed',
            repairability: 'reviewable',
            uris: [uri],
            repair: {
              kind: 'repair-citation',
              subjectUri: uri,
              targetUri: `${uri}#${citationId}`,
              summary: 'Review source',
            },
          },
        ],
        recordPreviews: [
          {
            uri,
            title: 'Enrolled topic',
            kind: 'durable',
            excerpt: 'Saved claim.',
            code: [{citationId, path: 'src/topic.ts', findingIds: ['enrolled-source-changed']}],
            contentHash: hash,
          },
        ],
        maintenance: {...report().maintenance!, affectedMemories: 1, actionableFindings: 1},
      };
      const item = {
        caseId: 'topic-case',
        project: 'threadnote',
        memoryId: 'topic-memory',
        subjectUri: uri,
        family: 'topic-maintenance',
        slot: 'declared-support',
        evidenceRevision: hash,
        disposition: 'needs-decision' as const,
        reason: 'source-changed',
        firstSeen: 'now',
        lastSeen: 'now',
        lastChecked: 'now',
        attemptCount: 1,
        events: [],
      };
      let snapshot: ManagerContextMaintenanceStatusV2 = {
        ...status(),
        cases: [item],
        counts: {decisionMemories: 1, 'needs-decision': 1},
      };
      const packet = {
        version: 2,
        project: 'threadnote',
        caseId: item.caseId,
        reviewId: 'topic-review',
        memoryUri: uri,
        evidenceRevision: hash,
        expectedContentHash: hash,
        family: item.family,
        slot: item.slot,
        reason: item.reason,
        choices: [],
        allowedOperations: [],
        instructions: '',
        topicEvidence: {
          version: 1,
          outcome: 'ready',
          targetUri: uri,
          targetHash: hash,
          observationRevision: hash,
          coverage: 'declared-only',
          body: 'Saved claim.',
          paragraphs: [],
          additionalDependencies: [],
          sources: [],
        },
      };
      let current: ManagerTopicReviewV1 = {
        version: 1,
        kind: 'topic-maintenance',
        project: 'threadnote',
        reviewId: 'topic-review',
        revision: 1,
        state: 'pending',
        topic: 'Topic',
        caseId: item.caseId,
        caseObservationMatches: true,
        targetUri: uri,
        targetHash: hash,
        acceptedBody: 'Saved claim.',
        observationRevision: hash,
        coverage: 'declared-only',
        generation: {origin: 'manual', agent: 'user', model: 'manual', attempts: 0, usage: {status: 'unavailable'}},
        draft: {
          version: 1,
          targetHash: hash,
          observationRevision: hash,
          packetDigest: hash,
          outcome: 'propose-revalidation',
          operations: [],
          reviewedHandles: ['current:source'],
          rationale: 'Reviewed source.',
          unresolvedQuestions: [],
          removedClaims: [],
        },
        proposal: {body: 'Saved claim.', finalBodyHash: hash, changedOrdinals: []},
        paragraphs: [],
        additionalDependencies: [],
        support: [],
        warnings: [],
        canApply: false,
      };
      const late = Promise.withResolvers<Response>();
      let deferPoll = false;
      const response = (value: unknown, code = 200) => new Response(JSON.stringify(value), {status: code});
      vi.stubGlobal(
        'fetch',
        vi.fn(async (path: string, init?: RequestInit) => {
          const url = new URL(path, 'http://manager.test');
          if (url.pathname === '/api/consolidation-models') return response({models: []});
          if (url.pathname === '/api/shares/conflicts') return response({conflicts: []});
          if (url.pathname === '/api/attention/topic-review') {
            if (init?.method === 'POST') {
              const action = JSON.parse(String(init.body));
              if (action.action === 'preview')
                current = {
                  ...current,
                  revision: 2,
                  canApply: true,
                  approval: {
                    stage: 'preview',
                    reviewRevision: 2,
                    approvalDigest: hash,
                    content: 'Saved claim.',
                    contentHash: hash,
                    metadataDiff: [],
                  },
                };
              if (action.action === 'apply') {
                if (failed) return response({error: 'The exact source changed. Refresh the review.'}, 409);
                current = {
                  ...current,
                  state: 'applied',
                  revision: 4,
                  canApply: false,
                  approval: {...current.approval!, stage: 'written'},
                  resolvedCitationIds: [citationId],
                };
              }
            }
            return response(current);
          }
          if (url.pathname === '/api/attention/context-maintenance' && init?.method === 'POST') {
            const action = JSON.parse(String(init.body));
            expect(action).toMatchObject({action: 'refresh-case', project: 'threadnote', caseId: item.caseId});
            return response({outcome: 'ready', item, packet});
          }
          if (url.pathname === '/api/context-health') {
            if (current.state === 'applied') return healthRefresh.promise;
            return response(healthReport);
          }
          if (url.searchParams.has('caseId'))
            return response(url.searchParams.get('view') === 'status' ? snapshot : packet);
          if (url.searchParams.get('limit') === '1') return response(snapshot);
          if (fullPollFailures > 0) {
            fullPollFailures -= 1;
            return response({error: 'Maintenance status unavailable'}, 503);
          }
          if (deferPoll) {
            deferPoll = false;
            return late.promise;
          }
          return response(snapshot);
        }),
      );
      let fullPollFailures = 0;
      const healthRefresh = Promise.withResolvers<Response>();
      function HealthWorkspace() {
        const [decisionCount, onDecisionCountChange] = useContextHealthDecisionCount();
        return (
          <>
            <ManagerNavigation
              panel="context-health"
              project="threadnote"
              refreshGeneration={0}
              connected
              disabled={false}
              onSelect={() => undefined}
              width={200}
              onResizeKeyDown={() => undefined}
              onResizePointerDown={() => undefined}
              contextHealthDecisionCount={decisionCount}
            />
            <ContextHealthPanel
              {...props}
              project="threadnote"
              refreshGeneration={0}
              onDecisionCountChange={onDecisionCountChange}
            />
          </>
        );
      }
      await render(<HealthWorkspace />);
      expect(document.querySelector('[aria-label="1 memory needs attention in threadnote"]')).not.toBeNull();
      const click = async (label: string) => {
        const button = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            [...document.querySelectorAll<HTMLButtonElement>('button')],
            value =>
              Effect.pipe(value.textContent, effectOptionalString =>
                effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
              ) === label,
          ),
        );
        expect(button, label).toBeDefined();
        await act(async () => button!.click());
      };
      await click('Review memory and evidence');
      expect(document.querySelector('[aria-label="Exact final document"]')).not.toBeNull();
      deferPoll = true;
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      await click('Confirm unchanged');
      if (failed) {
        expect(document.querySelector('dialog[open]')).not.toBeNull();
        expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('exact source changed');
        expect(document.body.textContent).toContain('1 memory needs your decision');
        expect(document.body.textContent).not.toContain('Topic update saved and verified.');
      } else {
        expect(document.querySelector('dialog')).toBeNull();
        expect(document.body.textContent).toContain('Topic update saved and verified.');
        expect(document.body.textContent).not.toContain('1 memory needs your decision');
        expect(document.querySelectorAll('.health-decision-card')).toHaveLength(0);
      }
      expect(document.querySelector('[aria-label="1 memory needs attention in threadnote"]') === null).toBe(!failed);
      await act(async () => late.resolve(response(snapshot)));
      expect(document.querySelectorAll('.health-decision-card')).toHaveLength(failed ? 1 : 0);
      if (!failed) {
        await act(async () => healthRefresh.resolve(response({error: 'Health refresh unavailable'}, 503)));
        expect(document.querySelectorAll('.health-decision-card')).toHaveLength(0);
        expect(document.body.textContent).not.toContain('1 memory needs your decision');
        expect(document.querySelector('[aria-label="1 memory needs attention in threadnote"]')).toBeNull();
        fullPollFailures = 1;
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(fullPollFailures).toBe(0);
        expect(document.querySelectorAll('.health-decision-card')).toHaveLength(0);
        // A new source revision and another case on the same memory must remain actionable.
        snapshot = {
          ...snapshot,
          generation: 'new',
          page: {generation: 'new'},
          cases: [
            {...item, evidenceRevision: Effect.pipe('b', EffectString.repeat(64))},
            {...item, caseId: 'another-case'},
          ],
          counts: {decisionMemories: 1, 'needs-decision': 2},
        };
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(document.querySelectorAll('.health-decision-card')).toHaveLength(1);
        expect(document.body.textContent).toContain('3 supporting checks');
        expect(document.querySelector('[aria-label="1 memory needs attention in threadnote"]')).not.toBeNull();
        expect(document.body.textContent).toContain('1 memory needs your decision');
      }
    },
  );
  it('opens a persisted semantic case with both quotes, context, reason, and evidence revisions', async () => {
    const memory = (name: string, body: string): MemoryRecord => ({
      body,
      content: body,
      headerTitle: 'MEMORY',
      uri: `threadnote://memory/${name}`,
      metadata: {
        kind: 'durable',
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-01-01',
      },
    });
    const records = [
      memory('a', '# Production\nTimeout is 60 seconds.'),
      memory('b', '# Production\nTimeout must be 30 seconds.'),
    ];
    const health = buildContextHealthReport({project: 'threadnote', records, now: new Date('2026-06-01')});
    const finding = health.findings[0];
    const item = {
      ...finding.caseIdentity!,
      caseId: finding.caseId!,
      evidenceRevision: 'revision',
      disposition: 'needs-decision' as const,
      reason: finding.summary,
      firstSeen: '2026-06-01',
      lastSeen: '2026-06-01',
      lastChecked: '2026-06-01',
      attemptCount: 0,
      subjectUri: records[0].uri,
      events: [],
    };
    const retained = {...status(), state: 'needs-decision', cases: [item]};
    const packet = {
      version: 2,
      caseId: item.caseId,
      project: 'threadnote',
      memoryUri: records[0].uri,
      evidenceRevision: 'revision',
      expectedContentHash: 'hash',
      reason: finding.summary,
      choices: ['Review applicability and policy'],
      allowedOperations: ['read_context'],
      instructions: 'No source wins automatically.',
      semanticEvidence: finding.semanticEvidence,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://manager.test');
        const result =
          url.pathname === '/api/memory'
            ? {content: records[0].content}
            : url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status'
              ? packet
              : retained;
        return new Response(JSON.stringify(result), {headers: {'content-type': 'application/json'}});
      }),
    );
    const openMemory = vi.fn();
    await render(
      <ContextMaintenanceView
        {...props}
        onOpenLibrary={openMemory}
        project="threadnote"
        report={{...health, findings: [], recordPreviews: [], repositoryEvidence: {state: 'available'}}}
      />,
    );
    const button = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        button => button.textContent === 'Review memory and evidence',
      ),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    const evidence = document.querySelector('dialog [aria-label="Semantic comparison evidence"]');
    expect(evidence?.textContent).toContain('Timeout is 60 seconds.');
    expect(evidence?.textContent).toContain('Timeout must be 30 seconds.');
    expect(evidence?.textContent).toContain('policy conflict');
    expect(evidence?.textContent).toContain('unknown validity');
    expect(evidence?.textContent).toContain('Production');
    expect(evidence?.textContent).toContain(finding.semanticEvidence?.right.recordContentFingerprint);
    expect(document.querySelector('dialog')?.textContent).not.toContain('No source excerpt is available');
    expect(document.querySelector('dialog h2')?.textContent).toBe('Compare conflicting memories');
    expect(document.querySelector('dialog [aria-label="Memory being reviewed"]')).toBeNull();
    expect(document.querySelector('dialog')?.textContent).not.toContain('Edit or archive in Library');
    const openB = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('dialog button')],
        button =>
          Effect.pipe(button.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
          ) === 'Open memory B',
      ),
    );
    await act(async () => openB?.click());
    expect(openMemory).toHaveBeenCalledWith(records[1].uri);
  });
  it.each(['finding', 'retained'] as const)(
    'refreshes the retained decision queue immediately after confirming a semantic %s review',
    async path => {
      vi.useFakeTimers();
      const memory = (name: string, body: string): MemoryRecord => ({
        uri: `threadnote://memory/${name}`,
        body,
        content: body,
        headerTitle: 'MEMORY',
        metadata: {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: '2026-01-01',
        },
      });
      const records = [
        memory('a', '# Production\nTimeout is 60 seconds.'),
        memory('b', '# Production\nTimeout must be 30 seconds.'),
      ];
      const health = buildContextHealthReport({project: 'threadnote', records, now: new Date('2026-06-01')});
      const finding = health.findings[0];
      const evidence = finding.semanticEvidence!;
      const item = {
        ...finding.caseIdentity!,
        caseId: finding.caseId!,
        evidenceRevision: 'revision',
        disposition: 'needs-decision' as const,
        reason: 'Opposing canonical claims',
        firstSeen: '2026-06-01',
        lastSeen: '2026-06-01',
        lastChecked: '2026-06-01',
        attemptCount: 0,
        subjectContentHashes: EffectArray.map(records, record => ({uri: record.uri, hash: 'hash'})),
        events: [],
      };
      let applied = false;
      let statusReads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input), 'http://manager.test');
          let result: unknown;
          if (Effect.pipe(url.pathname, EffectString.endsWith('/semantic/preview')))
            result = {
              preview: {
                previewId: 'semantic-preview',
                revision: 'semantic-revision',
                choice: 'left',
                mode: 'archive-other',
                summary: 'Keep memory A current; move memory B to history.',
                keptUri: evidence.left.recordUri,
                archivedUri: evidence.right.recordUri,
                archivedContent: records[1].body,
                constraints: [],
              },
            };
          else if (Effect.pipe(url.pathname, EffectString.endsWith('/semantic/apply'))) {
            applied = true;
            result = {result: {status: 'applied', choice: 'left'}};
          } else if (url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status') {
            result = {
              version: 2,
              project: 'threadnote',
              caseId: item.caseId,
              memoryUri: evidence.left.recordUri,
              reason: item.reason,
              evidenceRevision: 'revision',
              expectedContentHash: 'memory-content-hash',
              semanticEvidence: evidence,
              choices: [],
              allowedOperations: [],
              instructions: 'Review both memories.',
            };
          } else {
            if (!url.searchParams.has('caseId')) statusReads += 1;
            result = {
              ...status(),
              state: applied ? 'idle' : 'needs-decision',
              cases: [{...item, disposition: applied ? 'resolved' : 'needs-decision'}],
              counts: {decisionMemories: applied ? 0 : 2},
            };
          }
          return new Response(JSON.stringify(result), {headers: {'content-type': 'application/json'}});
        }),
      );
      let currentReport = {
        ...report(),
        ...health,
        recordPreviews: [],
        findings: path === 'finding' ? health.findings : [],
        repositoryEvidence: {state: 'available' as const},
      };
      const onChanged = vi.fn(() => {
        currentReport = {
          ...currentReport,
          findings: [],
          maintenance: {...currentReport.maintenance!, affectedMemories: 0, actionableFindings: 0},
        };
        root?.render(
          <ContextMaintenanceView {...props} project="threadnote" report={currentReport} onChanged={onChanged} />,
        );
      });
      await render(
        <ContextMaintenanceView {...props} project="threadnote" report={currentReport} onChanged={onChanged} />,
      );
      expect(document.querySelectorAll('.health-record')).toHaveLength(2);
      const initialReads = statusReads;
      const click = async (label: string) => {
        const button = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            [...document.querySelectorAll<HTMLButtonElement>('button')],
            value =>
              Effect.pipe(value.textContent, effectOptionalString =>
                effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
              ) === label,
          ),
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());
      };
      await click(path === 'finding' ? 'Compare evidence and preview change' : 'Review memory and evidence');
      await act(async () => document.querySelector<HTMLInputElement>('dialog input[value="left"]')!.click());
      await click('Preview my choice');
      await act(async () => document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click());
      await click('Confirm and move memory B to history');
      expect(onChanged).toHaveBeenCalledOnce();
      expect(statusReads).toBeGreaterThan(initialReads);
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.querySelectorAll('.health-record')).toHaveLength(0);
      expect(document.querySelector('[aria-label="Needs your decision"]')?.textContent).not.toContain(
        'Opposing canonical claims',
      );
      expect(document.body.textContent).toContain('No decisions are waiting');
      expect(
        EffectArray.some(
          [...document.querySelectorAll('[role="status"]')],
          value => value.textContent === 'Change saved.',
        ),
      ).toBe(true);
    },
  );

  it('shows the affected memory, safe cause and concrete recovery when inventory stops', async () => {
    const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/broken.md';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...status(),
              state: 'failed',
              error: {
                reason: 'memory-snapshot-unreadable',
                at: '2026-10-05T07:00:00Z',
                diagnostic: {
                  version: 1,
                  category: 'invalid-header',
                  stage: 'record-read',
                  memoryUri,
                  retryable: false,
                  summary: 'Private memory header is not a valid Threadnote document.',
                  recovery:
                    'Preserve a backup, restore a valid header from a known-good copy, then run maintenance again.',
                },
              },
            }),
          ),
      ),
    );
    await render(<ContextMaintenanceView project="threadnote" report={report()} {...props} />);
    expect(document.body.textContent).toContain('Private memory header is not a valid Threadnote document.');
    expect(document.body.textContent).toContain(memoryUri);
    expect(document.body.textContent).toContain('Preserve a backup');
    expect(document.body.textContent).not.toContain('inspect the diagnostic');
    expect(document.body.textContent).toContain('Stopped');
    expect(
      document.querySelector('[aria-label="Background scan"] .health-status-badge')?.getAttribute('data-tone'),
    ).toBe('danger');
  });

  it('loads retained case and receipt pages and opens exact evidence and old undo', async () => {
    const item = {
      caseId: 'old-case',
      project: 'threadnote',
      memoryId: 'old-memory',
      family: 'citation',
      slot: 'anchor:old',
      disposition: 'historical' as const,
      evidenceRevision: 'revision',
      reason: 'historical-verified',
      firstSeen: '2026-10-03',
      lastSeen: '2026-10-03',
      lastChecked: '2026-10-03',
      attemptCount: 2,
      events: [],
    };
    const receipt = {
      receiptId: 'old-receipt',
      project: 'threadnote',
      subjectUri: 'threadnote://memory/old',
      postHash: 'hash',
      timestamp: '2026-10-03',
      state: 'applied' as const,
    };
    const calls: URL[] = [];
    let undone = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        calls.push(url);
        if (init?.method === 'POST') {
          undone = JSON.parse(String(init.body)).receiptId === 'old-receipt';
          return new Response(JSON.stringify({status: 'undone'}));
        }
        if (url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status')
          return new Response(
            JSON.stringify({
              version: 2,
              project: 'threadnote',
              caseId: 'old-case',
              evidenceRevision: 'revision',
              expectedContentHash: 'hash',
              reason: 'historical-verified',
              choices: ['Review original claim'],
              allowedOperations: ['read_context'],
              instructions: 'Historical evidence does not verify current source.',
              evidence: {
                coverage: 'available',
                generation: 'source',
                attemptedSteps: [],
                excerpts: [
                  {
                    content: 'retained historical declaration',
                    provenance: 'historical-verified',
                    excerptHash: 'hash',
                    supportsCitation: true,
                    startLine: 1,
                    endLine: 1,
                    fileBytesHash: 'old-file-hash',
                    source: {path: 'old.ts', sourceCommit: 'old-commit', sourceSnapshotId: 'old-snapshot'},
                  },
                ],
              },
            }),
          );
        if (url.searchParams.has('caseId')) return new Response(JSON.stringify({...status(), cases: [item]}));
        return new Response(
          JSON.stringify({
            ...status(),
            cases: url.searchParams.has('caseCursor') ? [item] : [],
            receipts: url.searchParams.has('receiptCursor') ? [receipt] : [],
            page: {
              generation: 'history',
              caseNextCursor: url.searchParams.has('caseCursor') ? undefined : 'cases-2',
              receiptNextCursor: url.searchParams.has('receiptCursor') ? undefined : 'receipts-2',
            },
          }),
        );
      }),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    const click = async (label: string) => {
      const button = EffectOption.getOrUndefined(
        EffectArray.findFirst([...document.querySelectorAll('button')], value => value.textContent === label),
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    await click('Load more retained cases');
    await click('Load more retained changes and undo');
    await click('Inspect exact case and evidence');
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('retained historical declaration');
    await click('Close');
    expect(EffectArray.filter(calls, url => url.searchParams.has('caseId'))[0].searchParams.get('project')).toBe(
      'threadnote',
    );
    await click('Undo this change');
    expect(undone).toBe(true);
  });

  it('continues polling after a hidden tab becomes visible', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const fetch = vi.fn(async () => new Response(JSON.stringify(status())));
    vi.stubGlobal('fetch', fetch);
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    hidden.mockReturnValue(false);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps maintenance cards and an open dialog mounted while health refresh fails and recovers', async () => {
    const memoryUri = 'threadnote://user/tester/memories/refresh-stability.md';
    const item: ManagerContextMaintenanceStatusV2['cases'][number] = {
      caseId: 'case-stable',
      project: 'threadnote',
      memoryId: 'memory-stable',
      family: 'citation',
      slot: 'anchor',
      evidenceRevision: 'revision',
      disposition: 'needs-decision',
      reason: 'source-changed',
      subjectContentHashes: [{uri: memoryUri, hash: 'hash'}],
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    };
    const packet = {
      version: 2,
      project: 'threadnote',
      caseId: item.caseId,
      memoryUri,
      evidenceRevision: 'revision',
      expectedContentHash: 'hash',
      reason: 'source-changed',
      choices: ['Review the claim'],
      allowedOperations: [],
      instructions: 'Compare the source.',
    };
    const held = Promise.withResolvers<Response>();
    const retry = Promise.withResolvers<Response>();
    let healthReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        if (url.pathname === '/api/context-health') {
          healthReads++;
          return healthReads === 1
            ? Promise.resolve(new Response(JSON.stringify(report())))
            : healthReads === 2
              ? held.promise
              : retry.promise;
        }
        if (url.pathname === '/api/attention/automatic-memory')
          return Promise.resolve(
            new Response(JSON.stringify({version: 1, project: 'threadnote', items: [], omitted: 0})),
          );
        if (url.pathname === '/api/memory')
          return Promise.resolve(new Response(JSON.stringify({content: '# Stable private evidence'})));
        if (init?.method === 'POST')
          return Promise.resolve(new Response(JSON.stringify({version: 2, outcome: 'ready', item, packet})));
        if (url.searchParams.has('caseId')) return Promise.resolve(new Response(JSON.stringify(packet)));
        return Promise.resolve(new Response(JSON.stringify({...status(), cases: [item]})));
      }),
    );
    const panel = (refreshGeneration: number) => (
      <ContextHealthPanel {...props} project="threadnote" refreshGeneration={refreshGeneration} />
    );
    await render(panel(0));
    const card = document.querySelector('.health-decision-card');
    expect(card).not.toBeNull();
    const review = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        button => button.textContent === 'Review memory and evidence',
      ),
    )!;
    await act(async () => review.click());
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
    const body = dialog.querySelector<HTMLElement>('.detail-modal-body')!;
    body.scrollTop = 180;
    await act(async () => root?.render(panel(1)));
    const slot = document.querySelector<HTMLElement>('.health-refresh-status')!;
    expect(slot.textContent).toContain('Context health evidence is being refreshed');
    expect(document.querySelector('.health-decision-card')).toBe(card);
    expect(document.querySelector('dialog')).toBe(dialog);
    expect(body.scrollTop).toBe(180);
    await act(async () => held.reject(new Error('Temporary health refresh failure')));
    const error = slot.querySelector('[role=alert]');
    expect(error?.textContent).toContain('Temporary health refresh failure');
    await act(async () => root?.render(panel(2)));
    expect(slot.querySelector('[role=alert]')).toBe(error);
    expect(document.querySelector('.health-decision-card')).toBe(card);
    expect(document.querySelector('dialog')).toBe(dialog);
    await act(async () => retry.resolve(new Response(JSON.stringify(report()))));
    expect(slot.querySelector('[role=alert]')).toBeNull();
    expect(document.querySelector('.health-refresh-status')).toBe(slot);
    expect(document.querySelector('.health-decision-card')).toBe(card);
    expect(document.querySelector('dialog')).toBe(dialog);
    expect(dialog.open).toBe(true);
    expect(body.scrollTop).toBe(180);
  });

  it('redacts retained maintenance and health evidence when the maintenance poll loses authorization', async () => {
    vi.useFakeTimers();
    let denied = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://manager.test');
        if (url.pathname === '/api/attention/automatic-memory')
          return new Response(JSON.stringify({version: 1, project: 'threadnote', items: [], omitted: 0}));
        return denied
          ? new Response(JSON.stringify({error: 'Maintenance access ended'}), {status: 403})
          : new Response(JSON.stringify(status()));
      }),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    expect(document.querySelector('.automatic-memory-panel')).not.toBeNull();
    denied = true;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(document.querySelector('.automatic-memory-panel')).toBeNull();
    expect(document.querySelector('.attention-metrics')).toBeNull();
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Maintenance access ended');
  });

  it('keeps distinct panel and review identities when background maintenance advances its generation', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let advanced = false;
    const memoryUri = 'threadnote://user/tester/memories/example.md';
    const item = {
      caseId: 'case-visible',
      project: 'threadnote',
      memoryId: 'memory-visible',
      family: 'citation',
      slot: 'anchor',
      evidenceRevision: 'revision',
      disposition: 'needs-decision',
      reason: 'source-changed',
      subjectContentHashes: [{uri: memoryUri, hash: 'hash'}],
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://manager.test');
        if (url.pathname === '/api/memory') return new Response(JSON.stringify({content: '# Visible memory'}));
        if (url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status')
          return new Response(
            JSON.stringify({
              version: 2,
              project: 'threadnote',
              caseId: item.caseId,
              memoryUri,
              evidenceRevision: 'revision',
              expectedContentHash: 'hash',
              reason: 'source-changed',
              choices: ['Review the claim'],
              allowedOperations: [],
              instructions: 'Compare the source.',
            }),
          );
        return new Response(
          JSON.stringify({...status(), cases: [item], page: {generation: advanced ? 'second' : 'first'}}),
        );
      }),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    const review = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll('button')],
        button => button.textContent === 'Review memory and evidence',
      ),
    );
    await act(async () => review!.click());
    const dialog = document.querySelector('dialog');
    const automaticPanel = document.querySelector('.automatic-memory-panel');
    expect(dialog?.open).toBe(true);
    expect(automaticPanel).not.toBeNull();
    advanced = true;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(document.querySelector('dialog')).toBe(dialog);
    expect(document.querySelector('.automatic-memory-panel')).toBe(automaticPanel);
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain('Visible memory');
    expect(
      EffectArray.filter(consoleError.mock.calls, args =>
        EffectArray.some(args, value => EffectString.includes('same key')(String(value))),
      ),
    ).toEqual([]);
  });

  it('refreshes evidence when background proof advances without a corpus change', async () => {
    vi.useFakeTimers();
    const onChanged = vi.fn();
    let advanced = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...status(),
              page: {generation: advanced ? 'evidence-two' : 'evidence-one'},
              projects: [{...status().projects[0], checked: advanced ? 104 : 96}],
            }),
          ),
      ),
    );
    await render(<ContextMaintenanceView {...props} onChanged={onChanged} project="threadnote" report={report()} />);
    expect(onChanged).not.toHaveBeenCalled();
    advanced = true;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('preserves the selected review across arbitrary report and maintenance refresh outcomes', async () => {
    vi.useFakeTimers();
    const memory = (name: string, body: string): MemoryRecord => ({
      uri: `threadnote://memory/${name}`,
      body,
      content: body,
      headerTitle: 'MEMORY',
      metadata: {
        kind: 'durable',
        project: 'threadnote',
        status: 'active',
        sourceAgentClient: 'test',
        timestamp: '2026-01-01',
      },
    });
    const evidence = buildContextHealthReport({
      project: 'threadnote',
      records: [memory('a', 'Timeout is 60 seconds.'), memory('b', 'Timeout must be 30 seconds.')],
      now: new Date('2026-06-01'),
    }).findings[0].semanticEvidence!;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('left', 'right', 'both'),
        fc.array(fc.record({hideCase: fc.boolean(), maintenanceFailure: fc.boolean(), reportFailure: fc.boolean()}), {
          minLength: 1,
          maxLength: 6,
        }),
        async (choice, updates) => {
          if (root) await act(async () => root?.unmount());
          root = undefined;
          document.body.replaceChildren();
          vi.clearAllMocks();
          let revision = 0;
          let outcome = {hideCase: false, maintenanceFailure: false, reportFailure: false};
          const item = {
            caseId: 'stable-review',
            project: 'threadnote',
            memoryId: 'a',
            family: 'semantic-contradiction',
            slot: 'conflict',
            evidenceRevision: 'reviewed-revision',
            disposition: 'needs-decision',
            reason: 'incompatible-values',
            subjectContentHashes: [{uri: evidence.left.recordUri, hash: 'reviewed-hash'}],
            firstSeen: 'now',
            lastSeen: 'now',
            lastChecked: 'now',
            attemptCount: 1,
            events: [],
          };
          const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
            const url = new URL(input, 'http://manager.test');
            const response = (value: unknown, code = 200) => new Response(JSON.stringify(value), {status: code});
            if (_init?.method === 'POST') {
              expect(JSON.parse(String(_init.body))).toMatchObject({
                action: 'refresh-case',
                project: 'threadnote',
                caseId: item.caseId,
              });
              return outcome.maintenanceFailure
                ? response({error: 'Synthetic maintenance failure'}, 503)
                : response({
                    outcome: 'ready',
                    item,
                    packet: {
                      version: 2,
                      project: 'threadnote',
                      caseId: item.caseId,
                      memoryUri: evidence.left.recordUri,
                      evidenceRevision: item.evidenceRevision,
                      expectedContentHash: 'reviewed-content-hash',
                      reason: item.reason,
                      choices: [],
                      allowedOperations: [],
                      instructions: 'Compare the selected memories.',
                      family: item.family,
                      semanticEvidence: evidence,
                    },
                  });
            }
            if (url.pathname === '/api/context-health')
              return outcome.reportFailure
                ? response({error: 'Synthetic report failure'}, 503)
                : response(report(url.searchParams.get('project') ?? 'threadnote'));
            if (url.searchParams.has('caseId'))
              return url.searchParams.get('view') === 'status'
                ? response({...status(), cases: [item]})
                : response({
                    version: 2,
                    project: 'threadnote',
                    caseId: item.caseId,
                    memoryUri: evidence.left.recordUri,
                    evidenceRevision: item.evidenceRevision,
                    expectedContentHash: 'reviewed-content-hash',
                    reason: item.reason,
                    choices: [],
                    allowedOperations: [],
                    instructions: 'Compare the selected memories.',
                    family: item.family,
                    semanticEvidence: evidence,
                  });
            return outcome.maintenanceFailure
              ? response({error: 'Synthetic maintenance failure'}, 503)
              : response({
                  ...status(),
                  cases: outcome.hideCase ? [] : [{...item, evidenceRevision: `background-${revision}`}],
                  page: {generation: `background-${revision}`},
                });
          });
          vi.stubGlobal('fetch', fetch);
          await render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={revision} />);
          const open = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              [...document.querySelectorAll('button')],
              button => button.textContent === 'Review memory and evidence',
            ),
          );
          expect(open).toBeDefined();
          await act(async () => open!.click());
          const dialog = document.querySelector('dialog')!;
          const input = dialog.querySelector<HTMLInputElement>(`input[value="${choice}"]`)!;
          const body = dialog.querySelector<HTMLElement>('.detail-modal-body')!;
          await act(async () => input.click());
          input.focus();
          body.scrollTop = 120;
          for (const update of updates) {
            outcome = update;
            revision += 1;
            await act(async () => vi.advanceTimersByTimeAsync(30_000));
            await act(async () =>
              root?.render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={revision} />),
            );
            expect(document.querySelector('dialog')).toBe(dialog);
            expect(dialog.open).toBe(true);
            expect(input.checked).toBe(true);
            expect(document.activeElement).toBe(input);
            expect(body.scrollTop).toBe(120);
            expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
            expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
          }
          expect(
            EffectArray.every(
              EffectArray.filter(fetch.mock.calls, ([, init]) => init?.method === 'POST'),
              ([, init]) => JSON.parse(String(init?.body)).action === 'refresh-case',
            ),
          ).toBe(true);
          await act(async () =>
            root?.render(<ContextHealthPanel {...props} project="other" refreshGeneration={revision} />),
          );
          expect(document.querySelector('dialog')).toBeNull();
          expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        },
      ),
      {numRuns: 24},
    );
  });

  it('does not render the previous project report while the new project read is pending', async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://manager.test');
        if (url.pathname === '/api/context-health')
          return url.searchParams.get('project') === 'other' ? pending.promise : new Response(JSON.stringify(report()));
        return new Response(JSON.stringify(status()));
      }),
    );
    await render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={0} />);
    await act(async () => root?.render(<ContextHealthPanel {...props} project="other" refreshGeneration={0} />));
    expect(document.body.textContent).toContain('Checking project context');
    expect(document.body.textContent).not.toContain('1,712');
    expect(document.body.textContent).not.toContain('Records scanned');
    await act(async () => pending.resolve(new Response(JSON.stringify({...report('other'), recordsScanned: 0}))));
    expect(document.body.textContent).not.toContain('1,712');
  });

  it('shows full aggregate recovery and history when decision details are truncated', async () => {
    const onDecisionCountChange = vi.fn();
    const snapshot: ManagerContextMaintenanceStatusV2 = {
      ...status(),
      cases: Array.from({length: 30}, (_, index) => ({
        caseId: `decision-${index}`,
        memoryId: `memory-${index}`,
        project: 'threadnote',
        family: 'citation',
        slot: 'anchor:0',
        evidenceRevision: 'revision',
        disposition: 'needs-decision' as const,
        reason: 'citation-changed',
        firstSeen: '2026-10-03T10:00:00Z',
        lastSeen: '2026-10-03T10:00:00Z',
        lastChecked: '2026-10-03T10:00:00Z',
        attemptCount: 1,
        events: [],
      })),
      counts: {decisionMemories: 55, 'needs-decision': 55, 'waiting-evidence': 18, retired: 7},
      groups: [
        {
          causeKey: 'repository:unavailable',
          project: 'threadnote',
          disposition: 'waiting-evidence',
          reason: 'repository-unavailable',
          repositoryId: 'repository',
          affectedMemories: 18,
        },
      ],
      omittedCases: 50,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(snapshot))),
    );
    await render(
      <ContextMaintenanceView
        {...props}
        project="threadnote"
        report={report()}
        onDecisionCountChange={onDecisionCountChange}
      />,
    );
    expect(document.body.textContent).toContain('55 memories need your decision');
    expect(onDecisionCountChange).toHaveBeenLastCalledWith('threadnote', 55);
    expect(document.body.textContent).toContain('18 affected memories');
    expect(document.body.textContent).toContain('7 retired');
    expect(document.body.textContent).toContain('18 waiting for evidence');
    expect(document.body.textContent).toContain('50 additional case details');
    expect(document.body.textContent).not.toContain('No blocked recovery groups');
    await act(async () => root?.unmount());
    root = undefined;
    expect(onDecisionCountChange).toHaveBeenLastCalledWith('threadnote', undefined);
  });

  it('loads remaining decisions directly in the decision queue without requiring History', async () => {
    const cases: ManagerContextMaintenanceStatusV2['cases'] = EffectArray.map(['first', 'second'], name => ({
      caseId: name,
      project: 'threadnote',
      memoryId: name,
      family: 'citation',
      slot: 'anchor',
      disposition: 'needs-decision',
      reason: 'source-changed',
      evidenceRevision: 'revision',
      subjectContentHashes: [{uri: `threadnote://user/tester/memories/${name}.md`, hash: 'hash'}],
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    }));
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST');
      const next = new URL(input, 'http://manager.test').searchParams.get('caseCursor') === 'next-decisions';
      return new Response(
        JSON.stringify({
          ...status(),
          cases: [cases[next ? 1 : 0]],
          counts: {decisionMemories: 2, 'needs-decision': 2},
          page: {generation: 'same-generation', caseNextCursor: next ? undefined : 'next-decisions'},
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    const queue = document.querySelector('[aria-label="Needs your decision"]');
    expect(queue?.querySelectorAll('article')).toHaveLength(1);
    const more = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...queue!.querySelectorAll<HTMLButtonElement>('button')],
        button => button.textContent === 'Load more memories to review',
      ),
    );
    expect(more).toBeDefined();
    await act(async () => more!.click());
    expect(queue?.querySelectorAll('article')).toHaveLength(2);
    expect(queue?.querySelectorAll('h3')[2].textContent).toBe('second');
    expect(queue?.textContent).not.toContain('Load more memories to review');
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Needs a decision');
  });

  it('routes V2 health reports through the canonical service without starting the legacy citation worker', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        return new Response(
          JSON.stringify(Effect.pipe(url, EffectString.startsWith('/api/context-health?')) ? report() : status()),
          {
            headers: {'content-type': 'application/json'},
          },
        );
      }),
    );
    await render(
      <ContextHealthPanel
        onProjectChange={() => undefined}
        onOpenLibrary={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    expect(document.body.textContent).toContain('Needs your decision');
    expect(EffectArray.some(requests, url => Effect.pipe(url, EffectString.includes('/citations/jobs')))).toBe(false);
    expect(
      EffectArray.some(requests, url => Effect.pipe(url, EffectString.includes('/attention/context-maintenance'))),
    ).toBe(true);
  });

  it('carries the saved excerpt from the active health view into the citation dialog', async () => {
    const source = report();
    const uri = 'threadnote://memory/quoted-source';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(status()))),
    );
    await render(
      <ContextMaintenanceView
        {...props}
        project="threadnote"
        report={{
          ...source,
          repositoryEvidence: {state: 'available'},
          findings: [
            {
              category: 'citation-changed',
              id: 'finding-quote',
              classification: 'actionable',
              confidence: 'high',
              severity: 'high',
              repairability: 'reviewable',
              summary: 'Source changed',
              uris: [uri],
              repair: {
                kind: 'repair-citation',
                subjectUri: uri,
                targetUri: `${uri}#citation`,
                summary: 'Review source',
              },
            },
          ],
          recordPreviews: [
            {uri, title: 'Review source', excerpt: 'Review the source before applying.', kind: 'durable', code: []},
          ],
        }}
      />,
    );
    const compare = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        Array.from(document.querySelectorAll('button')),
        item => item.textContent === 'Compare evidence and preview change',
      ),
    );
    expect(compare).toBeDefined();
    await act(async () => compare?.click());
    expect(document.querySelector('dialog .memory-excerpt blockquote')?.textContent).toBe(
      'Review the source before applying.',
    );
  });

  it('combines multiple supported checks into one memory decision with a scoped agent task', async () => {
    const source = report();
    const categories: ReadonlyArray<ManagerContextHealthResponseV1['findings'][number]['category']> = [
      'citation-changed',
      'semantic-contradiction',
    ];
    const findings: ManagerContextHealthResponseV1['findings'] = EffectArray.map(
      categories,
      (category, index): ManagerContextHealthResponseV1['findings'][number] => ({
        category,
        id: `finding-${index}`,
        caseId: `case-${index}`,
        classification: 'actionable',
        confidence: 'medium',
        severity: 'high',
        repairability: 'manual-review',
        summary: 'Current source contradicts the stored claim.',
        uris: ['threadnote://memory/example'],
        repair: {kind: 'review-memory', subjectUri: 'threadnote://memory/example', summary: 'Review claim'},
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(status()), {headers: {'content-type': 'application/json'}})),
    );
    await render(
      <ContextMaintenanceView
        {...props}
        project="threadnote"
        report={{
          ...source,
          findings,
          maintenance: {...source.maintenance!, affectedMemories: 1, actionableFindings: 2},
          recordPreviews: [
            {
              uri: 'threadnote://memory/example',
              title: 'Supported claim',
              excerpt: 'Stored advice refers to a removed function.',
              kind: 'durable',
              code: [],
            },
          ],
        }}
      />,
    );
    expect(document.querySelectorAll('.health-record')).toHaveLength(1);
    expect(document.body.textContent).toContain('1 memory needs your decision');
    const prepare = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        Array.from(document.querySelectorAll('button')),
        item => item.textContent === 'Review with agent…',
      ),
    );
    await act(async () => prepare?.click());
    expect(document.querySelector('dialog')?.open).toBe(true);
    const task = document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value;
    expect(task).toContain('$threadnote-health');
    expect(task).toContain('case-0');
    expect(task).toContain('case-1');
  });

  it('shows partial coverage and automatic work without creating thousands of decisions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(status()), {headers: {'content-type': 'application/json'}})),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    expect(document.body.textContent).toContain('No decisions needed; evidence checks are incomplete');
    expect(document.body.textContent).toContain('96 of 1,712 background checks completed');
    expect(document.body.textContent).toContain('Current source checks96');
    expect(document.body.textContent).toContain('Extraction coverage can remain partial after scanning finishes');
    expect(document.body.textContent).toContain('Run maintenance now');
    expect(document.body.textContent).not.toContain('Repair all');
    expect(document.body.textContent).not.toContain('2,013 issues');
  });
  it.each(['extraction', 'comparison'] as const)(
    'keeps the scan in progress while semantic %s work remains',
    async phase => {
      const current = {
        ...status(),
        projects: [{...status().projects[0], checked: 1_712}],
        semanticCoverage: [
          {
            project: 'threadnote',
            state: 'partial',
            eligibleRecords: 18,
            checkedBatches: 2,
            totalBatches: 3,
            extractedRecords: phase === 'extraction' ? 16 : 18,
            totalRecords: 18,
            extractionComplete: phase !== 'extraction',
            comparisonComplete: false,
            comparedClaimPairs: 256,
            ...(phase === 'comparison' ? {totalClaimPairs: 1_024} : {}),
            unsupportedRecords: 0,
            unsupportedClaims: 0,
            bodyLimitedRecords: 0,
            outputOmittedFindings: 0,
            churnCount: 0,
            dirtyRecordPairsRemaining: 0,
          },
        ],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify(current), {
              headers: {'content-type': 'application/json'},
            }),
        ),
      );
      await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
      expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain('Scanning');
      expect(document.querySelector('[aria-label="Semantic scan progress"]')?.textContent).toContain(
        phase === 'extraction' ? '16 of 18 durable memories read' : '256 of 1,024 claim comparisons checked',
      );
      expect(document.querySelector('[aria-label="Claim comparison progress"]') === null).toBe(phase === 'extraction');
    },
  );
  it('uses completed maintenance coverage while preserving unsupported and omitted evidence warnings', async () => {
    const current = {
      ...status(),
      projects: [{...status().projects[0], checked: 1_712}],
      semanticCoverage: [
        {
          project: 'threadnote',
          state: 'partial',
          eligibleRecords: 18,
          checkedBatches: 3,
          totalBatches: 3,
          extractedRecords: 18,
          totalRecords: 18,
          extractionComplete: true,
          comparisonComplete: true,
          comparedClaimPairs: 1_024,
          totalClaimPairs: 1_024,
          unsupportedRecords: 2,
          unsupportedClaims: 3,
          bodyLimitedRecords: 1,
          outputOmittedFindings: 4,
          churnCount: 2,
          dirtyRecordPairsRemaining: 0,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(current), {
            headers: {'content-type': 'application/json'},
          }),
      ),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain('Caught up');
    const scan = document.querySelector('[aria-label="Semantic scan progress"]')?.textContent;
    expect(scan).toContain('18 of 18 durable memories read');
    expect(scan).toContain('1,024 comparison checks performed across source revisions');
    expect(scan).toContain('Current comparisons finished.');
    expect(scan).toContain('3 claims in 2 memories could not be interpreted');
    expect(scan).toContain('1 memory exceeded the supported text limit');
    expect(scan).toContain('4 findings are outside the retained output limit');
    expect(scan).toContain('2 source changes invalidated affected work');
    expect(scan).toContain('Completed checks do not prove that memories agree');
    expect(document.querySelector('[aria-label="Evidence coverage"] > header')?.textContent).toContain('partial');
  });
  it('reports completed heuristic traversal even when the direct report is limited to a prefix', async () => {
    const current = {
      ...status(),
      projects: [{...status().projects[0], checked: 1_712}],
      semanticCoverage: [
        {
          project: 'threadnote',
          state: 'complete',
          eligibleRecords: 18,
          checkedBatches: 3,
          totalBatches: 3,
          extractedRecords: 18,
          totalRecords: 18,
          extractionComplete: true,
          comparisonComplete: true,
          comparedClaimPairs: 1_024,
          totalClaimPairs: 1_024,
          unsupportedRecords: 0,
          unsupportedClaims: 0,
          bodyLimitedRecords: 0,
          outputOmittedFindings: 0,
          churnCount: 0,
          dirtyRecordPairsRemaining: 0,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(current), {
            headers: {'content-type': 'application/json'},
          }),
      ),
    );
    const health = report();
    await render(
      <ContextMaintenanceView
        {...props}
        project="threadnote"
        report={{
          ...health,
          maintenance: {
            ...health.maintenance!,
            citationCoverage: {...health.maintenance!.citationCoverage, state: 'complete'},
          },
        }}
      />,
    );
    expect(document.querySelector('[aria-label="Evidence coverage"] > header')?.textContent).toContain('complete');
    expect(document.querySelector('[aria-label="Semantic scan progress"]')?.textContent).toContain('Checked');
    expect(document.querySelector('[aria-label="Semantic scan progress"]')?.textContent).not.toContain(
      'Checked with gaps',
    );
    expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain('Caught up');
  });
  it.each([false, true])('only marks an empty project caught up after inventory completes (%s)', async complete => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({...status(), projects: [], preparation: {complete, admittedRecords: 0}}), {
            headers: {'content-type': 'application/json'},
          }),
      ),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={{...report(), recordsScanned: 0}} />);
    expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain(
      complete ? 'Caught up' : 'Scanning',
    );
    expect(document.querySelector('[aria-label="Preparing background maintenance"]') === null).toBe(complete);
  });
  it('keeps global pause usable while a project run is pending and ignores its late on response', async () => {
    const actions: Array<{url: string; action: string}> = [];
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.body) {
          const action = JSON.parse(String(init.body)).action;
          actions.push({url, action});
          if (action === 'run-now') return pending.promise;
          return new Response(JSON.stringify({paused: true}));
        }
        return new Response(JSON.stringify(EffectString.includes('view=controls')(url) ? {paused: false} : status()));
      }),
    );
    function CombinedControls() {
      const [controlGeneration, setControlGeneration] = React.useState(0);
      return (
        <>
          <MaintenanceControls project="threadnote" onChanged={() => setControlGeneration(value => value + 1)} />
          <ContextMaintenanceView
            {...props}
            controlGeneration={controlGeneration}
            project="threadnote"
            report={report()}
          />
        </>
      );
    }
    await render(<CombinedControls />);
    const button = (label: string) =>
      EffectOption.getOrThrow(
        EffectArray.findFirst(
          Array.from(document.querySelectorAll('button')),
          item => EffectString.trim(item.textContent ?? '') === label,
        ),
      );
    await act(async () => button('Automatic recovery').click());
    await act(async () => button('Run maintenance now').click());
    expect(button('Pause automatic maintenance').disabled).toBe(false);
    await act(async () => button('Pause automatic maintenance').click());
    expect(
      document.querySelector('[aria-label="Automatic maintenance controls"] .health-status-badge')?.textContent,
    ).toBe('Off');
    const projectRun = document.querySelector<HTMLButtonElement>('[aria-label="Project maintenance actions"] button')!;
    expect(projectRun.disabled).toBe(true);
    await act(async () => projectRun.click());
    expect(actions).toHaveLength(2);
    await act(async () => pending.resolve(new Response(JSON.stringify(status()))));
    expect(
      document.querySelector('[aria-label="Automatic maintenance controls"] .health-status-badge')?.textContent,
    ).toBe('Off');
    expect(actions).toEqual([
      {url: '/api/attention/context-maintenance', action: 'run-now'},
      {url: '/api/attention/context-maintenance?view=controls', action: 'pause'},
    ]);
  });
  it('refreshes a paused project after enabling the global setting without live support', async () => {
    let paused = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (EffectString.includes('view=controls')(url)) {
          if (init?.body) paused = false;
          return new Response(JSON.stringify({paused}));
        }
        if (EffectString.startsWith('/api/context-health')(url)) return new Response(JSON.stringify(report()));
        if (EffectString.startsWith('/api/attention/context-maintenance')(url))
          return new Response(JSON.stringify({...status(), paused}));
        return new Response(JSON.stringify({version: 1, project: 'threadnote', items: [], omitted: 0}));
      }),
    );
    await render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={0} />);
    const button = (label: string) =>
      EffectOption.getOrThrow(
        EffectArray.findFirst(
          Array.from(document.querySelectorAll('button')),
          item => EffectString.trim(item.textContent ?? '') === label,
        ),
      );
    await act(async () => button('Automatic recovery').click());
    expect(button('Run maintenance now').disabled).toBe(true);
    await act(async () => button('Enable automatic maintenance').click());
    expect(button('Run maintenance now').disabled).toBe(false);
  });
  it('rejects a late status response after changing projects', async () => {
    const pending = Promise.withResolvers<Response>();
    const release = pending.resolve;
    const first = pending.promise;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Effect.pipe(url, EffectString.includes('threadnote'))
          ? first
          : new Response(JSON.stringify({...status(), paused: true, projects: [], cases: [], receipts: []}), {
              headers: {'content-type': 'application/json'},
            }),
      ),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    await act(async () => root?.render(<ContextMaintenanceView {...props} project="other" report={report('other')} />));
    await act(async () =>
      release?.(
        new Response(JSON.stringify({...status(), error: {reason: 'OLD PROJECT ERROR', at: 'now'}}), {
          headers: {'content-type': 'application/json'},
        }),
      ),
    );
    expect(document.body.textContent).toContain('Automatic maintenance is paused');
    expect(
      document.querySelector('[aria-label="Background scan"] .health-status-badge')?.getAttribute('data-tone'),
    ).toBe('warning');
    expect(document.body.textContent).not.toContain('OLD PROJECT ERROR');
  });
  it('reports undo conflicts without claiming a reverted mutation', async () => {
    const receipt = {
      receiptId: 'receipt-one',
      project: 'threadnote',
      subjectUri: 'threadnote://memory/example',
      timestamp: '2026-10-03T10:00:00Z',
      postHash: Effect.pipe('a', EffectString.repeat(64)),
      state: 'applied' as const,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.body
                ? {status: 'conflict', receiptId: receipt.receiptId, reason: 'memory-changed'}
                : {...status(), receipts: [receipt]},
            ),
            {status: init?.body ? 409 : 200, headers: {'content-type': 'application/json'}},
          ),
      ),
    );
    const openMemory = vi.fn();
    await render(
      <ContextMaintenanceView {...props} onOpenLibrary={openMemory} project="threadnote" report={report()} />,
    );
    const undo = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        Array.from(document.querySelectorAll('button')),
        item => item.textContent === 'Undo this change',
      ),
    );
    await act(async () => undo?.click());
    expect(document.body.textContent).toContain('The memory changed after maintenance');
    expect(document.body.textContent).toContain('Inspect its current contents');
    expect(document.body.textContent).not.toContain('HTTP 409');
    expect(
      EffectArray.some(
        Array.from(document.querySelectorAll('button')),
        item => item.textContent === 'Inspect current memory',
      ),
    ).toBe(true);
    const inspect = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        Array.from(document.querySelectorAll('button')),
        item => item.textContent === 'Inspect current memory',
      ),
    );
    await act(async () => inspect?.click());
    expect(openMemory).toHaveBeenCalledWith(receipt.subjectUri);
    expect(document.body.textContent).not.toContain('Change undone');
  });
});

it('refreshes a stale selected source and displays changed current code without rewriting its citation', async () => {
  const uri = 'threadnote://memory/selected';
  const item = {
    caseId: 'selected-source',
    project: 'threadnote',
    memoryId: 'selected',
    family: 'citation',
    slot: 'anchor',
    evidenceRevision: 'old',
    disposition: 'needs-decision' as const,
    reason: 'source-changed',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const openMemory = vi.fn();
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (EffectString.startsWith('/api/memory')(path)) return new Response(JSON.stringify({content: 'Saved advice.'}));
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({
        action: 'refresh-case',
        project: 'threadnote',
        caseId: item.caseId,
      });
      return new Response(
        JSON.stringify({
          outcome: 'ready',
          item: {...item, evidenceRevision: 'fresh'},
          packet: {
            version: 2,
            project: 'threadnote',
            caseId: item.caseId,
            memoryUri: uri,
            evidenceRevision: 'fresh',
            expectedContentHash: 'same-memory',
            reason: 'source-changed',
            choices: [],
            allowedOperations: [],
            instructions: 'Compare.',
            reference: {path: 'source.ts', citationId: 'citation-one', status: 'changed'},
            evidence: {
              coverage: 'available',
              generation: 'fresh',
              attemptedSteps: [],
              excerpts: [
                {
                  content: 'recorded source',
                  provenance: 'historical-verified',
                  supportsCitation: true,
                  excerptHash: 'recorded',
                  startLine: 1,
                  endLine: 1,
                  fileBytesHash: 'source-file-hash',
                  source: {path: 'source.ts', sourceCommit: 'source-commit', sourceSnapshotId: 'source-snapshot'},
                },
                {
                  content: 'changed current source',
                  provenance: 'current-verified',
                  supportsCitation: false,
                  excerptHash: 'current',
                  startLine: 1,
                  endLine: 1,
                  fileBytesHash: 'source-file-hash',
                  source: {path: 'source.ts', sourceCommit: 'source-commit', sourceSnapshotId: 'source-snapshot'},
                },
              ],
            },
          },
        }),
      );
    }
    if (EffectString.includes('view=status')(path)) return new Response(JSON.stringify({...status(), cases: [item]}));
    return new Response(JSON.stringify({error: 'Saved observation is stale.'}), {status: 409});
  });
  vi.stubGlobal('fetch', fetch);
  await render(
    <MaintenanceCaseDialog
      project="threadnote"
      caseId={item.caseId}
      initialCase={item}
      onClose={() => {}}
      onTask={() => {}}
      onOpenLibrary={openMemory}
    />,
  );
  expect(document.querySelector('dialog')?.textContent).toContain('recorded source');
  expect(document.querySelector('dialog')?.textContent).toContain('changed current source');
  expect(document.querySelector('dialog')?.textContent).toContain(
    'Source changed. Review the claim before updating its citation.',
  );
  const edit = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('button')],
      button => button.textContent === 'Edit advice for source.ts',
    ),
  );
  await act(async () => edit!.click());
  expect(openMemory).toHaveBeenCalledWith(uri);
  expect(EffectArray.filter(fetch.mock.calls, ([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('adopts one refreshed case when live status already includes its old and new observations', () => {
  const current = {
    caseId: 'new',
    project: 'threadnote',
    memoryId: 'selected',
    family: 'semantic-contradiction',
    slot: 'pair',
    evidenceRevision: 'fresh',
    disposition: 'needs-decision' as const,
    reason: 'opposing-canonical-claims',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const before = {...current, caseId: 'before'};
  const after = {...current, caseId: 'after'};
  const historical = {...current, caseId: 'old', disposition: 'historical' as const};
  for (const selected of [
    [historical, current],
    [current, historical],
  ]) {
    const adopted = adoptMaintenanceEvidence([before, ...selected, after], current, historical.caseId);
    expect(EffectArray.map(adopted, item => item.caseId)).toEqual(['before', 'new', 'after']);
    expect(adoptMaintenanceEvidence(adopted, current, historical.caseId)).toEqual(adopted);
  }
});

it('keeps an initially stale selected observation in flight without aborting it into a competing read', async () => {
  vi.useFakeTimers();
  const item = {
    caseId: 'initial-stale-source',
    project: 'threadnote',
    memoryId: 'initial-stale-memory',
    family: 'citation',
    slot: 'anchor',
    evidenceRevision: 'old',
    disposition: 'needs-decision' as const,
    reason: 'source-changed',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
  const selected = Promise.withResolvers<Response>();
  let serverLockHeld = false;
  const calls: {method: string; signal?: AbortSignal | null}[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (EffectString.startsWith('/api/memory')(input)) return response({content: 'Retained selected advice.'});
      if (!EffectString.startsWith('/api/attention/context-maintenance')(input))
        throw new Error('Unexpected fixture route');
      calls.push({method: init?.method ?? 'GET', signal: init?.signal});
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          action: 'refresh-case',
          project: 'threadnote',
          caseId: item.caseId,
        });
        if (serverLockHeld)
          return response({error: 'Fixture selected observation still holds the maintenance lock.'}, 500);
        serverLockHeld = true;
        // A client abort does not release this controlled server operation until its barrier is completed.
        return selected.promise;
      }
      return EffectString.includes('view=status')(input)
        ? response({...status(), cases: [item]})
        : response({error: 'Fixture saved observation is stale.'}, 409);
    }),
  );
  try {
    await render(
      <MaintenanceCaseDialog
        project="threadnote"
        caseId={item.caseId}
        initialCase={item}
        stale
        onClose={() => {}}
        onTask={() => {}}
        onOpenLibrary={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    const trace = EffectArray.map(calls, call => ({method: call.method, aborted: call.signal?.aborted ?? false}));
    expect(trace).toEqual([{method: 'POST', aborted: false}]);
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Current evidence could not be checked.');
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          [...document.querySelectorAll<HTMLButtonElement>('button')],
          button =>
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
            ) === 'Refresh evidence',
        ),
      )?.disabled,
    ).toBe(true);
  } finally {
    serverLockHeld = false;
    await act(async () =>
      selected.resolve(
        response({
          outcome: 'ready',
          item,
          packet: {
            version: 2,
            project: 'threadnote',
            caseId: item.caseId,
            evidenceRevision: 'fresh',
            expectedContentHash: 'same-memory',
            reason: 'source-changed',
            choices: [],
            allowedOperations: [],
            instructions: 'Compare.',
          },
        }),
      ),
    );
  }
});

it('observes initial freshness and each later stale/manual transition once', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.array(fc.constantFrom('stale', 'fresh', 'manual'), {maxLength: 6}),
      async (initialStale, actions) => {
        const item = {
          caseId: 'transition-source',
          project: 'threadnote',
          memoryId: 'transition-memory',
          family: 'citation',
          slot: 'anchor',
          evidenceRevision: 'current',
          disposition: 'needs-decision' as const,
          reason: 'source-changed',
          firstSeen: 'now',
          lastSeen: 'now',
          lastChecked: 'now',
          attemptCount: 1,
          events: [],
        };
        const packet = {
          version: 2,
          project: item.project,
          caseId: item.caseId,
          evidenceRevision: item.evidenceRevision,
          expectedContentHash: 'same-memory',
          reason: item.reason,
          choices: [],
          allowedOperations: [],
          instructions: 'Compare.',
        };
        const methods: string[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: string, init?: RequestInit) => {
            if (EffectString.startsWith('/api/memory')(input))
              return new Response(JSON.stringify({content: 'Selected advice.'}));
            methods.push(init?.method ?? 'GET');
            if (init?.method === 'POST') {
              expect(JSON.parse(String(init.body))).toMatchObject({
                action: 'refresh-case',
                project: item.project,
                caseId: item.caseId,
              });
              return new Response(JSON.stringify({outcome: 'ready', item, packet}));
            }
            return new Response(
              JSON.stringify(EffectString.includes('view=status')(input) ? {...status(), cases: [item]} : packet),
            );
          }),
        );
        const element = (stale: boolean) => (
          <MaintenanceCaseDialog
            project={item.project}
            caseId={item.caseId}
            initialCase={item}
            stale={stale}
            onClose={() => {}}
            onTask={() => {}}
            onOpenLibrary={() => {}}
          />
        );
        let stale = initialStale;
        let observations = initialStale ? 1 : 0;
        try {
          await render(element(stale));
          for (const action of actions) {
            if (action === 'manual') {
              observations++;
              const button = EffectOption.getOrUndefined(
                EffectArray.findFirst(
                  [...document.querySelectorAll<HTMLButtonElement>('button')],
                  value =>
                    EffectOption.getOrUndefined(
                      EffectOption.map(EffectOption.fromNullishOr(value.textContent), text => EffectString.trim(text)),
                    ) === 'Refresh evidence',
                ),
              )!;
              expect(button.disabled).toBe(false);
              await act(async () => button.click());
            } else {
              const next = action === 'stale';
              if (!stale && next) observations++;
              stale = next;
              await act(async () => root?.render(element(stale)));
            }
            expect(EffectArray.filter(methods, method => method === 'POST')).toHaveLength(observations);
            expect(document.body.textContent).not.toContain('Current evidence could not be checked.');
          }
          expect(EffectArray.filter(methods, method => method === 'GET')).toHaveLength(initialStale ? 0 : 2);
          expect(EffectArray.filter(methods, method => method === 'POST')).toHaveLength(observations);
        } finally {
          await act(async () => root?.unmount());
          root = undefined;
          document.body.replaceChildren();
        }
      },
    ),
    {numRuns: 16},
  );
});

it.each(['project-change', 'unmount'] as const)(
  'cancels an initial selected observation on %s and ignores its late result',
  async change => {
    const item = {
      caseId: 'cancel-source',
      project: 'threadnote',
      memoryId: 'cancel-memory',
      family: 'citation',
      slot: 'anchor',
      evidenceRevision: 'old',
      disposition: 'needs-decision' as const,
      reason: 'source-changed',
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    };
    const barrier = Promise.withResolvers<Response>();
    let pendingSignal: AbortSignal | null | undefined;
    const adopted = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (EffectString.startsWith('/api/memory')(input))
          return new Response(JSON.stringify({content: 'Selected advice.'}));
        if (init?.method === 'POST') {
          pendingSignal = init.signal;
          return barrier.promise;
        }
        return new Response(JSON.stringify({error: 'Other project does not authorize this source.'}), {status: 403});
      }),
    );
    const element = (project: string) => (
      <MaintenanceCaseDialog
        project={project}
        caseId={item.caseId}
        initialCase={item}
        stale
        onEvidenceUpdated={adopted}
        onClose={() => {}}
        onTask={() => {}}
        onOpenLibrary={() => {}}
      />
    );
    await render(element('threadnote'));
    expect(pendingSignal?.aborted).toBe(false);
    if (change === 'project-change') await act(async () => root?.render(element('other')));
    else {
      await act(async () => root?.unmount());
      root = undefined;
    }
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () =>
      barrier.resolve(
        new Response(
          JSON.stringify({
            outcome: 'ready',
            item,
            packet: {
              version: 2,
              project: item.project,
              caseId: item.caseId,
              evidenceRevision: 'late',
              reason: 'LATE_SOURCE_MUST_NOT_ADOPT',
            },
          }),
        ),
      ),
    );
    expect(adopted).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('LATE_SOURCE_MUST_NOT_ADOPT');
  },
);

async function pollingEvidenceCase() {
  const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/polling.md';
  let item: ManagerContextMaintenanceCaseV2 = {
    caseId: 'polling-selected-case',
    project: 'threadnote',
    memoryId: 'polling-selected-memory',
    subjectUri: uri,
    subjectContentHashes: [{uri, hash: 'same-memory'}],
    family: 'citation',
    slot: 'anchor',
    evidenceRevision: 'selected-current',
    disposition: 'needs-decision',
    reason: 'graph-stale',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const packet = (): ManagerContextMaintenancePacketV2 => ({
    version: 2,
    project: item.project,
    caseId: item.caseId,
    memoryUri: uri,
    evidenceRevision: item.evidenceRevision,
    expectedContentHash: 'same-memory',
    reason: item.reason,
    choices: [],
    allowedOperations: [],
    instructions: 'Review the selected evidence.',
    evidenceSelectors: Array.from({length: 4}, (_, i) => ({
      caseId: item.caseId,
      memoryUri: uri,
      citationId: `reference-${i}`,
      anchorId: `anchor-${i}`,
    })),
  });
  const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), {status: code});
  const selected = Promise.withResolvers<Response>();
  const polls: {resolve: (value: Response) => void; health: boolean}[] = [];
  const posts: {signal?: AbortSignal | null; body: unknown}[] = [];
  const reads: string[] = [];
  let holdPolls = false,
    holdSelected = true,
    selectedStatus = 200,
    parentStatus = 200;
  const snapshot = () => ({...status(), cases: [item], counts: {'needs-decision': 1, decisionMemories: 1}});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://manager.test');
      if (init?.method !== 'POST') reads.push(url.pathname + url.search);
      if (url.pathname === '/api/memory') return response({content: 'Retained polling memory.'});
      if (url.pathname === '/api/attention/context-maintenance' && init?.method === 'POST') {
        posts.push({signal: init.signal, body: JSON.parse(String(init.body))});
        if (selectedStatus !== 200) return response({error: 'Selected access failed'}, selectedStatus);
        if (!holdSelected) return response({outcome: 'ready', item, packet: packet()});
        if (posts.length > 1) return response({error: 'Controlled operation is still occupied'}, 503);
        const observer = Promise.withResolvers<Response>();
        const abort = () => observer.reject(new DOMException('Cancelled observer', 'AbortError'));
        init?.signal?.addEventListener('abort', abort, {once: true});
        // Aborting the observer deliberately does not complete the simulated server operation.
        void selected.promise.then(value => {
          init?.signal?.removeEventListener('abort', abort);
          observer.resolve(value);
        });
        return observer.promise;
      }
      const health = url.pathname === '/api/context-health';
      if (health || (url.pathname === '/api/attention/context-maintenance' && !url.searchParams.has('caseId'))) {
        if (holdPolls) {
          const pending = Promise.withResolvers<Response>();
          polls.push({resolve: pending.resolve, health});
          return pending.promise;
        }
        return parentStatus === 200
          ? response(health ? report() : snapshot())
          : response({error: 'Parent access failed'}, parentStatus);
      }
      if (url.pathname === '/api/attention/context-maintenance')
        return response(url.searchParams.get('view') === 'status' ? snapshot() : packet());
      return response({version: 1, project: 'threadnote', items: [], omitted: 0});
    }),
  );
  await render(<ContextHealthPanel {...props} project="threadnote" refreshGeneration={0} />);
  const open = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      button =>
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
        ) === 'Review memory and evidence',
    ),
  );
  expect(open).toBeDefined();
  await act(async () => open!.click());
  const refresh = () =>
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('dialog button')],
        button =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
          ) === 'Refresh evidence',
      ),
    )!;
  return {
    posts,
    polls,
    reads,
    refresh,
    setHoldPolls: (value: boolean) => {
      holdPolls = value;
    },
    settlePolls: async (healthFirst = true) => {
      holdPolls = false;
      const pending = polls
        .splice(0)
        .sort((a, b) => (healthFirst ? Number(b.health) - Number(a.health) : Number(a.health) - Number(b.health)));
      for (const poll of pending)
        await act(async () =>
          poll.resolve(
            parentStatus === 200
              ? response(poll.health ? report() : snapshot())
              : response({error: 'Parent access failed'}, parentStatus),
          ),
        );
    },
    completeSelected: async () =>
      act(async () => {
        holdSelected = false;
        selected.resolve(response({outcome: 'ready', item, packet: packet()}));
      }),
    setSelectedStatus: (value: number) => {
      selectedStatus = value;
      holdSelected = false;
    },
    setParentStatus: (value: number) => {
      parentStatus = value;
    },
    changeRevision: () => {
      item = {...item, evidenceRevision: 'selected-changed'};
    },
  };
}

it('keeps one manual selected observation through unchanged real-parent pending and settled polls', async () => {
  vi.useFakeTimers();
  const fixture = await pollingEvidenceCase();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(29_000));
    await act(async () => fixture.refresh().click());
    expect(fixture.posts).toHaveLength(1);
    fixture.setHoldPolls(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fixture.polls.length).toBeGreaterThan(0);
    await fixture.settlePolls();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect({
      selected: EffectArray.map(fixture.posts, post => ({body: post.body, aborted: post.signal?.aborted})),
      references: document.querySelectorAll('.health-evidence-selectors button').length,
    }).toEqual({
      selected: [
        {
          body: {
            action: 'refresh-case',
            project: 'threadnote',
            caseId: 'polling-selected-case',
            memoryUri: 'threadnote://user/tester/memories/durable/projects/threadnote/polling.md',
          },
          aborted: false,
        },
      ],
      references: 4,
    });
    expect(document.querySelector('dialog')?.textContent).not.toContain('Current evidence could not be checked.');
  } finally {
    await fixture.completeSelected();
  }
  expect(document.querySelector('dialog [aria-label="Case evidence"]')?.getAttribute('aria-busy')).toBe('false');
});

it('keeps selected observations invariant under bounded unchanged parent poll sequences', async () => {
  vi.useFakeTimers();
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), {minLength: 1, maxLength: 4}), async order => {
      const fixture = await pollingEvidenceCase();
      try {
        await fixture.completeSelected();
        await act(async () => fixture.refresh().click());
        expect(fixture.posts).toHaveLength(1);
        for (const healthFirst of order) {
          fixture.setHoldPolls(true);
          await act(async () => vi.advanceTimersByTimeAsync(30_000));
          expect(fixture.polls.length).toBeGreaterThan(0);
          const run = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              [...document.querySelectorAll<HTMLButtonElement>('button')],
              button =>
                EffectOption.getOrUndefined(
                  EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
                ) === 'Run maintenance now',
            ),
          );
          expect(run).toBeDefined();
          expect(run!.disabled).toBe(true);
          await fixture.settlePolls(healthFirst);
          expect(fixture.posts).toHaveLength(1);
          expect(document.querySelectorAll('.health-evidence-selectors button')).toHaveLength(4);
          expect(document.querySelector('dialog')?.textContent).not.toContain('Current evidence could not be checked.');
        }
      } finally {
        await act(async () => root?.unmount());
        root = undefined;
        document.body.replaceChildren();
      }
    }),
    {numRuns: 16},
  );
});

it('refreshes a genuinely changed selected revision while unrelated poll progress remains read-only', async () => {
  vi.useFakeTimers();
  const fixture = await pollingEvidenceCase();
  await fixture.completeSelected();
  fixture.changeRevision();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(fixture.posts).toHaveLength(1);
  expect(document.querySelector('dialog')?.textContent).toContain('selected-changed');
  expect(document.querySelectorAll('.health-evidence-selectors button')).toHaveLength(4);
  const before = fixture.reads.length;
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('.health-evidence-selectors button')][1].click(),
  );
  expect(
    EffectArray.some(
      fixture.reads.slice(before),
      path => new URL(path, 'http://manager.test').searchParams.get('citationId') === 'reference-1',
    ),
  ).toBe(true);
  expect(fixture.posts).toHaveLength(1);
});

it('retains actual selected failure after three attempts until an explicit successful retry', async () => {
  vi.useFakeTimers();
  const fixture = await pollingEvidenceCase();
  await fixture.completeSelected();
  fixture.setSelectedStatus(503);
  await act(async () => fixture.refresh().click());
  await act(async () => vi.advanceTimersByTimeAsync(1_500));
  expect(fixture.posts).toHaveLength(3);
  expect(document.querySelector('dialog')?.textContent).toContain('Current evidence could not be checked.');
  expect(document.querySelectorAll('.health-evidence-selectors button')).toHaveLength(4);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(fixture.posts).toHaveLength(3);
  expect(document.querySelector('dialog')?.textContent).toContain('Current evidence could not be checked.');
  fixture.setSelectedStatus(200);
  await act(async () => fixture.refresh().click());
  expect(fixture.posts).toHaveLength(4);
  expect(document.querySelector('dialog')?.textContent).not.toContain('Current evidence could not be checked.');
});

it.each([401, 403, 404])('redacts a selected observation after access status %s without retrying it', async code => {
  vi.useFakeTimers();
  const fixture = await pollingEvidenceCase();
  await fixture.completeSelected();
  fixture.setSelectedStatus(code);
  await act(async () => fixture.refresh().click());
  expect(fixture.posts).toHaveLength(1);
  expect(document.querySelectorAll('.health-evidence-selectors button')).toHaveLength(0);
  expect(document.querySelector('dialog')?.textContent).toContain('Selected access failed');
});

it.each([401, 403, 404])(
  'unmounts the selected review when its actual parent poll loses access with %s',
  async code => {
    vi.useFakeTimers();
    const fixture = await pollingEvidenceCase();
    await fixture.completeSelected();
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    fixture.setParentStatus(code);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(document.body.textContent).not.toContain('Retained polling memory.');
    expect(fixture.posts).toHaveLength(0);
  },
);

async function pendingParentDenial(kind: 'cases' | 'receipts' | 'run-now' | 'undo', holdEvidence = false) {
  const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/private-pagination.md';
  const item: ManagerContextMaintenanceCaseV2 = {
    caseId: 'pending-parent-case',
    project: 'threadnote',
    memoryId: 'pending-parent-memory',
    subjectUri: uri,
    subjectContentHashes: [{uri, hash: 'private-hash'}],
    family: 'citation',
    slot: 'anchor',
    evidenceRevision: 'private-current',
    disposition: 'needs-decision',
    reason: 'source-changed',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const snapshot = {
    ...status(),
    cases: [item],
    receipts: [
      {
        receiptId: 'private-receipt',
        project: 'threadnote',
        subjectUri: uri,
        timestamp: '2026-10-03T10:00:00Z',
        postHash: EffectString.repeat(64)('a'),
        state: 'applied' as const,
      },
    ],
    page: {generation: 'private-history', caseNextCursor: 'cases-next', receiptNextCursor: 'receipts-next'},
  };
  const packet: ManagerContextMaintenancePacketV2 = {
    version: 2,
    project: item.project,
    caseId: item.caseId,
    memoryUri: uri,
    evidenceRevision: item.evidenceRevision,
    expectedContentHash: 'private-hash',
    reason: item.reason,
    choices: [],
    allowedOperations: [],
    instructions: 'PRIVATE SELECTED EVIDENCE',
  };
  const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), {status: code});
  const pending = Promise.withResolvers<Response>(),
    memory = Promise.withResolvers<Response>(),
    evidence = Promise.withResolvers<Response>();
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://manager.test');
      if (
        (init?.method === 'POST' && ['run-now', 'undo'].includes(JSON.parse(String(init.body)).action)) ||
        url.searchParams.has('caseCursor') ||
        url.searchParams.has('receiptCursor')
      ) {
        requests.push(
          init?.method === 'POST'
            ? JSON.parse(String(init.body)).action
            : url.searchParams.has('caseCursor')
              ? 'cases'
              : 'receipts',
        );
        return pending.promise;
      }
      if (url.pathname === '/api/memory')
        return holdEvidence ? memory.promise : response({content: 'PRIVATE STORED MEMORY'});
      if (url.pathname === '/api/attention/context-maintenance')
        return url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status'
          ? holdEvidence
            ? evidence.promise
            : response(packet)
          : response(snapshot);
      return response({version: 1, project: 'threadnote', items: [], omitted: 0});
    }),
  );
  await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
  const button = (label: string) =>
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        value =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(value.textContent), text => EffectString.trim(text)),
          ) === label,
      ),
    )!;
  await act(async () => button('History').click());
  const details = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('details')],
      value => value.querySelector('summary')?.textContent === 'Bounded maintenance diagnostics',
    ),
  )!;
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(true);
  await act(async () =>
    button(
      kind === 'cases'
        ? 'Load more retained cases'
        : kind === 'receipts'
          ? 'Load more retained changes and undo'
          : kind === 'undo'
            ? 'Undo this change'
            : 'Run maintenance now',
    ).click(),
  );
  expect(requests).toEqual([kind]);
  const inspect = button('Inspect exact case and evidence');
  expect(inspect.disabled).toBe(false);
  await act(async () => inspect.click());
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  return {
    finish: async (code: number) => act(async () => pending.resolve(response({error: 'PARENT REQUEST DENIED'}, code))),
    memory: async () => act(async () => memory.resolve(response({content: 'PRIVATE STORED MEMORY'}))),
    packet: async () => act(async () => evidence.resolve(response(packet))),
  };
}

it.each([401, 403, 404])('redacts an open review when gated history pagination returns %s', async code => {
  const pending = await pendingParentDenial('cases');
  expect(document.querySelector('dialog')?.textContent).toContain('PRIVATE STORED MEMORY');
  expect(document.querySelector('dialog')?.textContent).toContain('PRIVATE SELECTED EVIDENCE');
  await pending.finish(code);
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(document.body.textContent).not.toContain('PRIVATE STORED MEMORY');
  expect(document.body.textContent).not.toContain('PRIVATE SELECTED EVIDENCE');
});

it.each([401, 403, 404])('redacts an open review when a gated same-parent run action returns %s', async code => {
  const pending = await pendingParentDenial('run-now');
  expect(document.querySelector('dialog')?.textContent).toContain('PRIVATE STORED MEMORY');
  expect(document.querySelector('dialog')?.textContent).toContain('PRIVATE SELECTED EVIDENCE');
  await pending.finish(code);
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(document.body.textContent).not.toContain('PRIVATE STORED MEMORY');
  expect(document.body.textContent).not.toContain('PRIVATE SELECTED EVIDENCE');
});

it('redacts protected review state independently of delayed history/action and evidence completion order', async () => {
  const orders = [
    ['memory', 'packet', 'denial'],
    ['packet', 'denial', 'memory'],
    ['denial', 'memory', 'packet'],
    ['packet', 'memory', 'denial'],
    ['memory', 'denial', 'packet'],
    ['denial', 'packet', 'memory'],
  ] as const;
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('cases' as const, 'receipts' as const, 'run-now' as const),
      fc.constantFrom(401, 403, 404),
      fc.constantFrom(...orders),
      async (kind, code, order) => {
        const pending = await pendingParentDenial(kind, true);
        try {
          let denied = false;
          for (const event of order) {
            if (event === 'denial') {
              await pending.finish(code);
              denied = true;
            } else await pending[event]();
            if (denied) {
              expect(document.querySelector('dialog[open]')).toBeNull();
              expect(document.body.textContent).not.toContain('PRIVATE STORED MEMORY');
              expect(document.body.textContent).not.toContain('PRIVATE SELECTED EVIDENCE');
            }
          }
        } finally {
          await pending.memory();
          await pending.packet();
          await act(async () => root?.unmount());
          root = undefined;
          document.body.replaceChildren();
        }
      },
    ),
    {numRuns: 24},
  );
});

it.each(['cases', 'receipts', 'run-now'] as const)(
  'preserves an authorized open review after transient %s request failure',
  async kind => {
    const pending = await pendingParentDenial(kind);
    const dialog = document.querySelector('dialog[open]');
    await pending.finish(503);
    expect(document.querySelector('dialog[open]')).toBe(dialog);
    expect(dialog?.textContent).toContain('PRIVATE STORED MEMORY');
    expect(dialog?.textContent).toContain('PRIVATE SELECTED EVIDENCE');
    expect(document.body.textContent).toContain('PARENT REQUEST DENIED');
  },
);

it('keeps the exact open review and undo409 conflict handling after a delayed undo conflict', async () => {
  const pending = await pendingParentDenial('undo');
  const dialog = document.querySelector('dialog[open]');
  await pending.finish(409);
  expect(document.querySelector('dialog[open]')).toBe(dialog);
  expect(dialog?.textContent).toContain('PRIVATE STORED MEMORY');
  expect(dialog?.textContent).toContain('PRIVATE SELECTED EVIDENCE');
  expect(document.body.textContent).toContain('Undo stopped: PARENT REQUEST DENIED.');
  expect(
    EffectArray.some(
      [...document.querySelectorAll('button')],
      button => button.textContent === 'Inspect current memory',
    ),
  ).toBe(true);
});
