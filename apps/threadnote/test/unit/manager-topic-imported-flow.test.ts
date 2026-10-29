import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {managerImportedTopicFixture} from '../helpers/manager-imported-topic.js';
import {loadCandidateReview} from '@threadnote/memory/candidate';
import {runObsidianSourceRemove} from '@threadnote/integration-obsidian/source';
import {handleManagerAttentionRequest} from '../../src/manager/attention.js';
import {topicObsidianReviewId} from '../../src/memory/context/maintenance_obsidian.js';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';

effectIt.effect(
  'registered MCP reads imported packets before and after explicit capture without treating case identity as an excerpt selector',
  () =>
    Effect.gen(function* () {
      const f = yield* managerImportedTopicFixture();
      const server = new EffectMcpServerRegistry();
      registerContextMaintenanceTools(server, f.config);
      const packet = (input: Record<string, unknown>) => server.invokeTool('context_maintenance_packet', input);
      const pinDirectory = f.path.join(f.home, 'threadnote', 'sources', 'obsidian', 'notes', 'evidence');
      const before = yield* f.store.read(f.location, f.uri);
      const pins = yield* f.fs.readDirectory(pinDirectory);
      const first = yield* packet({caseId: f.caseId});
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        caseId: f.caseId,
        topicEvidence: {sourceKind: 'obsidian', outcome: 'ready', canDraft: false},
      });
      for (const selection of [
        {citationId: 'tnob_unselected'},
        {memoryUri: f.uri},
        {startLine: 1},
        {maximumLines: 24},
      ]) {
        expect((yield* packet({caseId: f.caseId, ...selection})).isError).toBe(true);
      }
      expect(yield* f.fs.readDirectory(pinDirectory)).toEqual(pins);
      expect(yield* f.store.read(f.location, f.uri)).toBe(before);
      const captured = yield* server.invokeTool('context_maintenance_capture', f.captureInput);
      expect(captured.isError).not.toBe(true);
      const afterCapture = yield* f.fs.readDirectory(pinDirectory);
      expect(afterCapture).toHaveLength(2);
      const current = yield* packet({caseId: f.caseId});
      expect(current.isError).not.toBe(true);
      expect(current.structuredContent).toMatchObject({
        topicEvidence: {sourceKind: 'obsidian', outcome: 'ready', canDraft: true},
      });
      expect(yield* f.fs.readDirectory(pinDirectory)).toEqual(afterCapture);
      expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect(
  'enrolls and captures through real Manager adapters without a checkout, then withholds revoked evidence',
  () =>
    Effect.gen(function* () {
      const f = yield* managerImportedTopicFixture();
      const pinDirectory = f.path.join(f.home, 'threadnote', 'sources', 'obsidian', 'notes', 'evidence');
      expect(yield* f.fs.readDirectory(pinDirectory)).toHaveLength(1);
      const captured = yield* f.request('POST', '/api/attention/topic-review', f.captureInput);
      expect(captured?.status).toBe(200);
      expect(captured?.body).toMatchObject({
        topicEvidence: {
          sourceKind: 'obsidian',
          canDraft: true,
          obsidian: {capture: {state: 'captured', fragment: f.currentText}},
        },
      });
      expect(yield* f.fs.readDirectory(pinDirectory)).toHaveLength(2);
      const reviewId = topicObsidianReviewId(f.uri);
      const journal = yield* loadCandidateReview(f.home, reviewId);
      expect(journal.maintenanceCapture?.stage).toBe('captured');
      expect((yield* f.request('POST', '/api/attention/topic-review', f.captureInput))?.status).toBe(200);
      expect(yield* f.fs.readDirectory(pinDirectory)).toHaveLength(2);
      expect((yield* loadCandidateReview(f.home, reviewId)).maintenanceCapture).toEqual(journal.maintenanceCapture);
      const generic = yield* f.request('POST', '/api/reviews/preview', {project: 'notes', reviewId});
      expect(generic?.status).toBe(409);
      expect(JSON.stringify(generic?.body)).not.toContain(f.currentText);
      const inbox = yield* handleManagerAttentionRequest({
        config: f.config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=notes'),
      });
      expect(inbox?.body).toMatchObject({pendingCount: 0, items: []});
      yield* runObsidianSourceRemove(f.config, {apply: true, id: 'notes'});
      const unavailable = yield* f.request(
        'GET',
        `/api/attention/context-maintenance?project=notes&caseId=${f.caseId}`,
      );
      expect(unavailable?.status).toBe(409);
      expect(unavailable?.body).toMatchObject({
        error: expect.stringContaining('source evidence changed or is unavailable'),
      });
      expect(JSON.stringify(unavailable?.body)).not.toMatch(
        /Original note fact|Current note fact|Old descriptive claim|Historical constraint/u,
      );
      const enrollment = yield* f.request('GET', `/api/attention/topic-enrollment?uri=${encodeURIComponent(f.uri)}`);
      expect(enrollment?.status).toBe(409);
      expect(JSON.stringify(enrollment?.body)).not.toContain('Old descriptive claim');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);
