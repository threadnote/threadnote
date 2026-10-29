import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import type {NativeCloseoutAdmission} from '@threadnote/workflow-automations/closeout';
import {createNativeDocument} from '@threadnote/workflow-automations/templates';
import {encodeAuthoringDocument} from '../../src/workflow_automation/authoring_artifacts.js';
import {planNativeCloseoutDocuments} from '../../src/workflow_automation/closeout_documents.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const admission = (
  count: number,
  withBehavior = false,
  content = 'Complete original rationale.',
): NativeCloseoutAdmission => ({
  format: 'threadnote-native-closeout-admission',
  version: 1,
  featureId: 'feature',
  project: 'project',
  planDocumentHash: Effect2.pipe('a', EffectString.repeat(64)),
  architecture: {
    summary: 'Complete implementation.',
    components: ['Reader'],
    contracts: [],
    diagram: 'flowchart TD\n Reader --> Store',
    invariants: [],
    unknowns: [],
    deviations: [],
    codeRefs: ['source.ts'],
  },
  architectureVerification: 'Verified.',
  combinedChecks: [],
  phaseEvidence: [],
  decisions: [],
  scenarios: [],
  documents: {
    architecture: createNativeDocument({
      kind: 'architecture-current',
      title: 'Feature — Implemented architecture',
      sections: {summary: content, components: 'Reader'},
    }),
    decisions: Array.from({length: count}, (_, index) =>
      createNativeDocument({
        kind: 'decisions',
        title: 'Decision ' + index,
        sections: {decision: 'Decision ' + index, alternatives: 'Rejected alternative.', rationale: content},
      }),
    ),
    handoff: createNativeDocument({
      kind: 'handoff',
      title: 'Feature — Closeout handoff',
      sections: {task: 'Complete.', verification: 'Checked.', 'next-step': 'Maintain.'},
    }),
    ...(withBehavior
      ? {
          behavior: createNativeDocument({
            kind: 'spec',
            title: 'Verified behavior',
            sections: {
              summary: 'Complete.',
              requirements: 'Preserve all data.',
              acceptance: 'Every field is returned.',
            },
          }),
        }
      : {}),
  },
});
const owned = (count: number, suffix = '') =>
  Array.from({length: count}, (_, index) => ({
    uri: 'threadnote://user/test/memories/drafts/' + index + suffix,
    memoryId: 'tn_source_' + index,
    revision: Effect2.pipe('b', EffectString.repeat(64)),
    destination: 'threadnote://user/test/memories/archive/' + index + suffix,
  }));
const uri = (key: string) => 'threadnote://user/test/memories/knowledge/' + key;
const preflight = (key: string, _body: string) => Effect.succeed({uri: uri(key)});

describe('native closeout final document planning', () => {
  it.effect('admits exact bodies and preserves bottom-up dependencies including the behavior backlink', () =>
    Effect.gen(function* () {
      const input = admission(14, true);
      const seen: {key: string; body: string}[] = [];
      const plan = yield* planNativeCloseoutDocuments(input, owned(2), (key, body) => {
        seen.push({key, body});
        return preflight(key, body);
      });
      expect(seen).toEqual(EffectArray.map(plan, ({key, body}) => ({key, body})));
      expect(EffectArray.map(plan, p => p.key)).toEqual([
        ...Array.from({length: 14}, (_, i) => 'decision-' + i),
        'decisions-2',
        'decisions-0',
        'behavior',
        'handoff',
        'history-0',
        'architecture',
        'behavior',
      ]);
      expect(EffectOption.getOrUndefined(EffectArray.findFirst(plan, p => p.key === 'decision-0'))?.body).toBe(
        encodeAuthoringDocument(input.documents.decisions[0]),
      );
      expect(plan.at(-1)?.relations).toEqual([{type: 'references', uri: uri('architecture')}]);
      expect(EffectOption.getOrUndefined(EffectArray.findFirst(plan, p => p.key === 'architecture'))?.body).toContain(
        '- [Knowledge](' + uri('decisions-0') + ')',
      );
      const available = new Set<string>();
      for (const item of plan) {
        for (const relation of item.relations) expect(available.has(relation.uri)).toBe(true);
        available.add(item.uri);
        expect(new TextEncoder().encode(item.body).byteLength).toBeLessThanOrEqual(60_000);
      }
      expect(Object.isFrozen(plan)).toBe(true);
    }),
  );

  it.effect('retains every decision and history identity across bounded generated page counts', () =>
    Effect.gen(function* () {
      for (const [decisions, drafts] of fc.sample(
        fc.tuple(fc.integer({min: 0, max: 64}), fc.integer({min: 0, max: 55})),
        {seed: 714, numRuns: 24},
      )) {
        const sources = owned(drafts, Effect2.pipe('界', EffectString.repeat(60)));
        const plan = yield* planNativeCloseoutDocuments(admission(decisions), sources, preflight);
        const byUri = new Map(EffectArray.map(plan, item => [item.uri, item]));
        const visited = new Set<string>();
        const visit = (target: string): void => {
          if (visited.has(target)) return;
          visited.add(target);
          for (const ref of byUri.get(target)?.relations ?? []) visit(ref.uri);
        };
        visit(uri('architecture'));
        expect(
          EffectArray.filter(plan, item => Effect2.pipe(item.key, EffectString.startsWith('decision-'))),
        ).toHaveLength(decisions);
        for (let index = 0; index < decisions; index++) expect(visited.has(uri('decision-' + index))).toBe(true);
        const history = EffectArray.join(
          EffectArray.map(
            EffectArray.filter(plan, item => Effect2.pipe(item.key, EffectString.startsWith('history-'))),
            item => item.body,
          ),
          '\n',
        );
        for (const item of sources) {
          expect(history).toContain(item.uri);
          expect(history).toContain(item.destination);
          expect(history).toContain(item.revision);
        }
      }
    }),
  );

  it.effect('rejects final reference expansion before returning any write plan', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* planNativeCloseoutDocuments(admission(1), owned(1), (key, _body) => {
        calls.push(key);
        return Effect.succeed({uri: uri(key) + Effect2.pipe('界', EffectString.repeat(12_000))});
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual(['decision-0']);
    }),
  );

  it.effect('uses UTF8 byte bounds and preserves preflight domain failures', () =>
    Effect.gen(function* () {
      const oversized = admission(0, false, Effect2.pipe('界', EffectString.repeat(12_000)));
      let calls = 0;
      const result = yield* planNativeCloseoutDocuments(oversized, [], (key, body) => {
        calls++;
        return preflight(key, body);
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(1); // Handoff admission is harmless; final architecture cannot be written.
      const failure = {code: 'private-preflight-denied'};
      const denied = yield* planNativeCloseoutDocuments(admission(1), [], () => Effect.fail(failure)).pipe(
        Effect.result,
      );
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) expect(denied.failure).toBe(failure);
    }),
  );
});
