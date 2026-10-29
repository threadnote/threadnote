import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {workflowScenarios} from '../src/scenarios.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

describe('native workflow manifest', () => {
  it('ships no Python under the current native manifest schema', async () => {
    const manifestValue: unknown = JSON.parse(await readFile('config/dev-skills.json', 'utf8'));
    const manifestSchema = Schema.Struct({
      schemaVersion: Schema.Int,
      skills: Schema.Array(Schema.Struct({id: Schema.String, files: Schema.Array(Schema.String)})),
    });
    if (!Schema.is(manifestSchema)(manifestValue)) throw new Error('Expected a current native skill manifest');
    const manifest = manifestValue;
    const shipped = EffectArray.flatMap(manifest.skills, skill =>
      EffectArrayPipe(skill.files, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (file, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && Effect.pipe(file, EffectString.endsWith('.py')),
        ),
      ),
    );
    expect(manifest.schemaVersion).toBe(2);
    expect(shipped).toEqual([]);
  });
});

describe('workflow representative scenarios', () => {
  it('uses unique IDs and covers the required workflow families', () => {
    const ids = EffectArray.map(workflowScenarios, item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(EffectArray.map(workflowScenarios, item => item.category));
    expect(categories).toEqual(new Set(['context', 'capacity', 'autonomy', 'design-challenger', 'watcher']));
    const byId = new Map(EffectArray.map(workflowScenarios, item => [item.id, item]));
    for (const id of [
      'autonomy-mechanical-edit',
      'autonomy-bounded-edit',
      'autonomy-high-risk',
      'autonomy-infrastructure-failure',
      'autonomy-resume',
      'autonomy-phase-pr-watch-handoff',
      'context-stale-readiness',
      'context-ready-graph-both-workflows',
      'context-bounded-first-slice-inspection',
      'capacity-least-sufficient-model-effort',
      'challenger-routine-skip',
      'challenger-material-alternative-wins',
      'challenger-no-better-alternative',
      'challenger-out-of-scope-rejected',
      'challenger-evidence-unavailable',
      'challenger-design-change-invalidates-review',
      'watcher-bootstrap-unresolved-commented-review',
      'watcher-thread-changes-pagination',
      'watcher-crash-replay-ack',
      'watcher-consumer-loss',
      'watcher-rate-limit',
      'watcher-head-race',
      'watcher-unchanged-waits',
    ])
      expect(byId.has(id)).toBe(true);
    expect(byId.get('challenger-routine-skip')).toMatchObject({
      category: 'design-challenger',
    });
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('challenger-routine-skip')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/routine work does not require/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('challenger-material-alternative-wins')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/selected alternative and tradeoff/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('challenger-no-better-alternative')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/current design is retained/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('challenger-out-of-scope-rejected')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/scope boundary is preserved/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('challenger-evidence-unavailable')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/no invented comparison result/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('challenger-design-change-invalidates-review')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/invalidates stale review/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('autonomy-high-risk')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/authorized implementation can proceed autonomously/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('autonomy-high-risk')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/only genuinely unauthorized actions block/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('autonomy-infrastructure-failure')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/does not trigger approval escalation/i);
    expect(byId.get('autonomy-resume')?.category).toBe('autonomy');
    expect(byId.get('autonomy-phase-pr-watch-handoff')?.category).toBe('autonomy');
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('context-ready-graph-both-workflows')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/dev-plan and dev-cycle/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('context-ready-graph-both-workflows')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/fallback is reported only when graph evidence is unavailable/i);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(byId.get('capacity-least-sufficient-model-effort')?.expectedInvariants),
          __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ' '),
        ),
      ),
    ).toMatch(/no automatic escalation without an evidenced need/i);
    for (const item of workflowScenarios) {
      expect(item.expectedInvariants.length).toBeGreaterThan(0);
      expect(item.measurements.length).toBeGreaterThan(0);
    }
  });
});
