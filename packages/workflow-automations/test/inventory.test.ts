import {describe, expect, it} from 'vitest';
import {readFile, readdir} from '@threadnote/testing/node-fs-promises';
import {workflowInventory} from '../src/inventory.js';
import {workflowScenarios} from '../src/scenarios.js';

describe('workflow contract inventory', () => {
  it('ships no Python and preserves the exact independent historical oracle inventory', async () => {
    const manifest = JSON.parse(await readFile('config/dev-skills.json', 'utf8')) as {
      schemaVersion: number;
      skills: {id: string; files: string[]}[];
    };
    const shipped = manifest.skills
      .flatMap(skill =>
        skill.files.filter(file => file.endsWith('.py')).map(file => `config/agent-skills/${skill.id}/${file}`),
      )
      .sort();
    expect(manifest.schemaVersion).toBe(2);
    expect(shipped).toEqual([]);
    const oracleRoot = 'apps/threadnote/test/dev-skills/python/oracle-skills';
    const historical = (await readdir(oracleRoot, {recursive: true}))
      .filter(file => file.endsWith('.py'))
      .map(file => `config/agent-skills/${file.replaceAll('\\', '/')}`)
      .sort();
    expect(historical).toHaveLength(16);
    expect(new Set(historical).size).toBe(16);
    expect(workflowInventory).toHaveLength(16);
    expect(workflowInventory.map(item => item.path).sort()).toEqual(historical);
  });

  it('has unique paths and explicit owner, command, state, and native replacement route classifications', () => {
    const paths = workflowInventory.map(item => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const item of workflowInventory) {
      expect(['spec', 'plan', 'cycle', 'watch-pr']).toContain(item.owner);
      expect(Array.isArray(item.commands)).toBe(true);
      expect(Array.isArray(item.mutableLocalState)).toBe(true);
      expect(item.nativeRoute.length).toBeGreaterThan(0);
    }
    const phaseState = workflowInventory.find(item => item.path.endsWith('/phase_state.py'))!;
    expect(phaseState.mutableLocalState.some(state => state.includes('plan.json'))).toBe(true);
    const cloudCloseout = workflowInventory.find(item => item.path.endsWith('/cloud_closeout.py'))!;
    expect(cloudCloseout.mutableLocalState.some(state => state.includes('cloud-publication.json'))).toBe(true);
    const devPlan = workflowInventory.find(item => item.path.endsWith('/dev_plan.py'))!;
    expect(devPlan.mutableLocalState.join(' ')).toMatch(/recover rewrites receipt state/i);
    expect(devPlan.mutableLocalState.join(' ')).toMatch(/load writes imported draft and receipts/i);
    const workflow = workflowInventory.find(item => item.path.endsWith('/workflow.py'))!;
    expect(workflow.mutableLocalState.join(' ')).toMatch(/preparation outputs/i);
    expect(workflow.mutableLocalState.join(' ')).toMatch(/final cycle-plan rewrite/i);
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
