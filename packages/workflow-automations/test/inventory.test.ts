import {describe, expect, it} from 'vitest';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {workflowScenarios} from '../src/scenarios.js';

describe('native workflow manifest', () => {
  it('ships no Python under the current native manifest schema', async () => {
    const manifest = JSON.parse(await readFile('config/dev-skills.json', 'utf8')) as {
      schemaVersion: number;
      skills: {id: string; files: string[]}[];
    };
    const shipped = manifest.skills.flatMap(skill => skill.files.filter(file => file.endsWith('.py')));
    expect(manifest.schemaVersion).toBe(2);
    expect(shipped).toEqual([]);
  });
});

describe('workflow representative scenarios', () => {
  it('uses unique IDs and covers the required workflow families', () => {
    const ids = workflowScenarios.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(workflowScenarios.map(item => item.category));
    expect(categories).toEqual(new Set(['context', 'capacity', 'autonomy', 'design-challenger', 'watcher']));
    const byId = new Map(workflowScenarios.map(item => [item.id, item]));
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
    expect(byId.get('challenger-routine-skip')).toMatchObject({category: 'design-challenger'});
    expect(byId.get('challenger-routine-skip')?.expectedInvariants.join(' ')).toMatch(/routine work does not require/i);
    expect(byId.get('challenger-material-alternative-wins')?.expectedInvariants.join(' ')).toMatch(
      /selected alternative and tradeoff/i,
    );
    expect(byId.get('challenger-no-better-alternative')?.expectedInvariants.join(' ')).toMatch(
      /current design is retained/i,
    );
    expect(byId.get('challenger-out-of-scope-rejected')?.expectedInvariants.join(' ')).toMatch(
      /scope boundary is preserved/i,
    );
    expect(byId.get('challenger-evidence-unavailable')?.expectedInvariants.join(' ')).toMatch(
      /no invented comparison result/i,
    );
    expect(byId.get('challenger-design-change-invalidates-review')?.expectedInvariants.join(' ')).toMatch(
      /invalidates stale review/i,
    );
    expect(byId.get('autonomy-high-risk')?.expectedInvariants.join(' ')).toMatch(
      /authorized implementation can proceed autonomously/i,
    );
    expect(byId.get('autonomy-high-risk')?.expectedInvariants.join(' ')).toMatch(
      /only genuinely unauthorized actions block/i,
    );
    expect(byId.get('autonomy-infrastructure-failure')?.expectedInvariants.join(' ')).toMatch(
      /does not trigger approval escalation/i,
    );
    expect(byId.get('autonomy-resume')?.category).toBe('autonomy');
    expect(byId.get('autonomy-phase-pr-watch-handoff')?.category).toBe('autonomy');
    expect(byId.get('context-ready-graph-both-workflows')?.expectedInvariants.join(' ')).toMatch(
      /dev-plan and dev-cycle/i,
    );
    expect(byId.get('context-ready-graph-both-workflows')?.expectedInvariants.join(' ')).toMatch(
      /fallback is reported only when graph evidence is unavailable/i,
    );
    expect(byId.get('capacity-least-sufficient-model-effort')?.expectedInvariants.join(' ')).toMatch(
      /no automatic escalation without an evidenced need/i,
    );
    for (const item of workflowScenarios) {
      expect(item.expectedInvariants.length).toBeGreaterThan(0);
      expect(item.measurements.length).toBeGreaterThan(0);
    }
  });
});
