import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {validateNativeCycleReview} from '../src/cycle_review.js';
import type {NativeCycleReview, NativeCycleSnapshot} from '../src/cycle_review.js';

const hash = (char: string) => char.repeat(64);
const objectId = (char: string) => char.repeat(40);

const snapshot = (overrides: Partial<NativeCycleSnapshot> = {}): NativeCycleSnapshot => ({
  format: 'threadnote-native-cycle-snapshot',
  version: 1,
  snapshotId: 'snapshot-2',
  phaseId: 'phase-1',
  phaseHash: hash('a'),
  repo: 'repo',
  head: objectId('b'),
  baseTree: objectId('c'),
  scopeBase: objectId('c'),
  declaredBaseHead: objectId('c'),
  scopeFiles: ['src/change.ts'],
  tree: objectId('d'),
  previous: 'snapshot-1',
  previousTree: objectId('e'),
  acceptedHead: objectId('b'),
  files: ['src/change.ts'],
  pinnedRef: 'refs/heads/main',
  ...overrides,
});

const finding = (overrides: Partial<NativeCycleReview['findings'][number]> = {}) => ({
  id: 'finding-1',
  file: 'src/change.ts',
  line: 12,
  body: 'Input is accepted without validation.',
  trigger: 'Submit an invalid request.',
  impact: 'An attacker can bypass the intended check.',
  evidence: 'The handler forwards the value directly to the write operation.',
  severity: 'important' as const,
  category: 'security' as const,
  confidence: 90,
  state: 'carried' as const,
  ...overrides,
});

const review = (
  overrides: Partial<NativeCycleReview> = {},
  current: NativeCycleSnapshot = snapshot(),
): NativeCycleReview => ({
  snapshotId: current.snapshotId,
  phaseHash: current.phaseHash,
  snapshotTree: current.tree,
  status: 'complete',
  mode: 'incremental',
  selected: ['orchestrator', 'security'],
  lanes: [
    {name: 'orchestrator', status: 'complete'},
    {name: 'security', status: 'complete'},
  ],
  findings: [finding()],
  ...overrides,
});

const priorSnapshot = snapshot({
  snapshotId: 'snapshot-1',
  head: objectId('b'),
  tree: objectId('e'),
  previous: undefined,
  previousTree: undefined,
  acceptedHead: undefined,
});

const priorReview: NativeCycleReview = {
  snapshotId: priorSnapshot.snapshotId,
  phaseHash: priorSnapshot.phaseHash,
  snapshotTree: priorSnapshot.tree,
  status: 'complete',
  mode: 'full',
  selected: ['orchestrator', 'security'],
  lanes: [
    {name: 'orchestrator', status: 'complete'},
    {name: 'security', status: 'complete'},
  ],
  findings: [finding({state: 'new'})],
};

const previous = {snapshot: priorSnapshot, review: priorReview};
const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('native cycle review validation', () => {
  it('accepts a complete full review and resolves an existing blocker with a reason', () => {
    const fullSnapshot = snapshot({
      snapshotId: 'snapshot-1',
      previous: undefined,
      previousTree: undefined,
      acceptedHead: undefined,
      tree: objectId('e'),
    });
    const full = review(
      {
        snapshotId: fullSnapshot.snapshotId,
        snapshotTree: fullSnapshot.tree,
        mode: 'full',
        findings: [finding({state: 'new'})],
      },
      fullSnapshot,
    );

    expect(validateNativeCycleReview(fullSnapshot, full).summary).toMatchObject({
      blockingIssueCount: 1,
      counts: {important: 1},
    });

    const resolved = review({
      findings: [finding({state: 'resolved', reason: 'The handler now validates the value before writing.'})],
    });
    expect(validateNativeCycleReview(snapshot(), resolved, previous).summary).toMatchObject({
      blockingIssueCount: 0,
      resolved: ['finding-1'],
    });
  });

  it('rejects malformed reviews and incomplete, missing, or duplicate selected lanes', () => {
    const valid = review();
    for (const input of [
      {...valid, unexpected: true},
      {...valid, status: 'running'},
      {...valid, selected: ['orchestrator', 'security'], lanes: [{name: 'orchestrator', status: 'complete'}]},
      {...valid, selected: ['orchestrator', 'security', 'security']},
      {...valid, lanes: [...valid.lanes, valid.lanes[1]]},
      {...valid, selected: ['security'], lanes: [{name: 'security', status: 'complete'}]},
      {...valid, lanes: [{name: 'orchestrator', status: 'running'}, valid.lanes[1]]},
    ])
      expect(caught(() => validateNativeCycleReview(snapshot(), input, previous))).toMatchObject({
        code: 'invalid-cycle-review',
      });
  });

  it('identifies the missing orchestrator even when selected and completed names match', () => {
    const current = snapshot({previous: undefined, previousTree: undefined});
    const rootOnly = review(
      {mode: 'full', selected: ['root'], lanes: [{name: 'root', status: 'complete'}], findings: []},
      current,
    );
    expect(caught(() => validateNativeCycleReview(current, rootOnly))).toMatchObject({
      code: 'invalid-cycle-review',
      message: 'Select the required orchestrator review lane and include its complete report.',
    });
    const orchestratorOnly = {
      ...rootOnly,
      selected: ['orchestrator'],
      lanes: [{name: 'orchestrator', status: 'complete'}],
    };
    expect(validateNativeCycleReview(current, orchestratorOnly).summary.blockingIssueCount).toBe(0);
    expect(
      caught(() => validateNativeCycleReview(current, {...orchestratorOnly, selected: ['orchestrator', 'simplicity']})),
    ).toMatchObject({code: 'invalid-cycle-review', message: 'Selected and completed review lanes differ.'});
  });

  it('rejects stale source identity, tree, and mode', () => {
    const current = snapshot();
    for (const input of [
      {...review({}, current), snapshotId: 'other-snapshot'},
      {...review({}, current), phaseHash: hash('f')},
      {...review({}, current), snapshotTree: objectId('f')},
      {...review({}, current), mode: 'full'},
    ])
      expect(caught(() => validateNativeCycleReview(current, input, previous))).toMatchObject({
        code: 'invalid-cycle-review',
      });

    expect(caught(() => validateNativeCycleReview(current, review({mode: 'incremental'})))).toMatchObject({
      code: 'invalid-cycle-review',
    });
  });

  it('rejects changed baseline, history, and accepted-head mismatches', () => {
    const current = snapshot();
    const baseChanged = snapshot({baseTree: objectId('f')});
    const historyChanged = snapshot({phaseId: 'phase-2'});
    const unacceptedHead = snapshot({head: objectId('f'), acceptedHead: objectId('b')});
    for (const candidate of [baseChanged, historyChanged, unacceptedHead])
      expect(caught(() => validateNativeCycleReview(candidate, review({}, candidate), previous))).toMatchObject({
        code: 'invalid-cycle-review',
      });

    const acceptedHead = snapshot({head: objectId('f'), acceptedHead: objectId('f')});
    expect(validateNativeCycleReview(acceptedHead, review({}, acceptedHead), previous).summary.blockingIssueCount).toBe(
      1,
    );
    expect(
      caught(() =>
        validateNativeCycleReview(current, review({}, current), {
          snapshot: snapshot({tree: objectId('f')}),
          review: priorReview,
        }),
      ),
    ).toMatchObject({code: 'invalid-cycle-review'});
  });

  it('requires and carries the prior finding ledger across a full source restart', () => {
    const restarted = snapshot({
      snapshotId: 'snapshot-restart',
      phaseHash: hash('f'),
      previous: undefined,
      supersedes: priorSnapshot.snapshotId,
      previousTree: undefined,
    });
    const carriedFullReport = review(
      {
        snapshotId: restarted.snapshotId,
        phaseHash: restarted.phaseHash,
        snapshotTree: restarted.tree,
        mode: 'full',
        findings: [finding({state: 'carried'})],
      },
      restarted,
    );

    expect(caught(() => validateNativeCycleReview(restarted, carriedFullReport))).toMatchObject({
      code: 'invalid-cycle-review',
    });
    expect(
      caught(() =>
        validateNativeCycleReview(restarted, review({...carriedFullReport, findings: []}, restarted), previous),
      ),
    ).toMatchObject({code: 'invalid-cycle-review'});
    for (const disposition of [
      finding({state: 'resolved'}),
      finding({state: 'rejected'}),
      finding({severity: 'minor'}),
    ])
      expect(
        caught(() =>
          validateNativeCycleReview(
            restarted,
            review({...carriedFullReport, findings: [disposition]}, restarted),
            previous,
          ),
        ),
      ).toMatchObject({code: 'invalid-cycle-review'});

    const restartResult = validateNativeCycleReview(restarted, carriedFullReport, previous);
    expect(restartResult.review.findings).toMatchObject([{id: 'finding-1', state: 'carried'}]);
    expect(restartResult.summary.blockingIssueCount).toBe(1);

    const next = snapshot({
      snapshotId: 'snapshot-after-restart',
      phaseHash: restarted.phaseHash,
      previous: restarted.snapshotId,
      previousTree: restarted.tree,
    });
    const nextReview = review({findings: [finding({state: 'carried'})]}, next);
    expect(
      validateNativeCycleReview(next, nextReview, {snapshot: restarted, review: restartResult.review}).review.findings,
    ).toMatchObject([{id: 'finding-1', state: 'carried'}]);

    const resolvedFullReport = review(
      {
        snapshotId: restarted.snapshotId,
        phaseHash: restarted.phaseHash,
        snapshotTree: restarted.tree,
        mode: 'full',
        findings: [finding({state: 'resolved', reason: 'The reviewed input path now validates before access.'})],
      },
      restarted,
    );
    expect(validateNativeCycleReview(restarted, resolvedFullReport, previous).summary).toMatchObject({
      blockingIssueCount: 0,
      resolved: ['finding-1'],
    });
  });

  it('requires blockers to remain present and prevents unsupported disposition or downgrade', () => {
    const current = snapshot();
    for (const findings of [[], [finding({severity: 'minor'})], [finding({state: 'resolved'})]])
      expect(caught(() => validateNativeCycleReview(current, review({findings}), previous))).toMatchObject({
        code: 'invalid-cycle-review',
      });

    expect(
      caught(() =>
        validateNativeCycleReview(
          current,
          review({
            findings: [finding({state: 'resolved', reason: 'Fixed.'})],
          }),
          previous,
        ),
      ),
    ).toBeUndefined();
    expect(
      caught(() =>
        validateNativeCycleReview(
          current,
          review({
            findings: [finding({severity: 'minor', reason: 'The revised impact is limited to a local style issue.'})],
          }),
          previous,
        ),
      ),
    ).toBeUndefined();
  });

  it('rejects duplicate IDs, unsafe locations, missing evidence, and empty disposition reasons', () => {
    const current = snapshot();
    const badLocations = [
      '/etc/passwd',
      '../secret',
      'src/../secret.ts',
      'src\\secret.ts',
      'C:/secret.ts',
      'src//file.ts',
    ];
    const invalidFindings = [
      [finding(), finding({id: 'finding-1', line: 13})],
      ...badLocations.map(file => [finding({file})]),
      [finding({evidence: '  '})],
      [finding({body: ''})],
      [finding({state: 'resolved', reason: '   '})],
    ];
    for (const findings of invalidFindings)
      expect(caught(() => validateNativeCycleReview(current, review({findings}), previous))).toMatchObject({
        code: 'invalid-cycle-review',
      });
  });

  it('derives active counts and preserves them across bounded unique findings', () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.record({
              id: fc.integer({min: 1, max: 1000}),
              severity: fc.constantFrom(
                'critical' as const,
                'important' as const,
                'minor' as const,
                'informational' as const,
              ),
            }),
            {minLength: 1, maxLength: 24},
          )
          .filter(items => new Set(items.map(item => item.id)).size === items.length),
        items => {
          const current = snapshot({previous: undefined, previousTree: undefined});
          const findings = items.map(item =>
            finding({id: `finding-${item.id}`, severity: item.severity, state: 'new'}),
          );
          const result = validateNativeCycleReview(current, review({findings, mode: 'full'}, current));
          const expected = items.reduce((counts, item) => ({...counts, [item.severity]: counts[item.severity] + 1}), {
            critical: 0,
            important: 0,
            minor: 0,
            informational: 0,
          });
          expect(result.summary.counts).toEqual(expected);
          expect(result.summary.blockingIssueCount).toBe(expected.critical + expected.important);
        },
      ),
      {numRuns: 60},
    );
  });

  it('resolving with a reason removes only blockers actually resolved', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('critical' as const, 'important' as const, 'minor' as const), {
          minLength: 1,
          maxLength: 20,
        }),
        severities => {
          const current = snapshot();
          const priorFindings = severities.map((severity, index) =>
            finding({
              id: `finding-${index}`,
              severity,
              state: 'new',
            }),
          );
          const before = {...previous, review: {...priorReview, findings: priorFindings}};
          const resolvedIds = new Set(
            priorFindings
              .filter(item => item.severity === 'critical' || item.severity === 'important')
              .filter((_, index) => index % 2 === 0)
              .map(item => item.id),
          );
          const afterFindings = priorFindings.map(item =>
            resolvedIds.has(item.id)
              ? {...item, state: 'resolved' as const, reason: 'The reported path is now guarded.'}
              : {...item, state: 'carried' as const},
          );
          const result = validateNativeCycleReview(current, review({findings: afterFindings}, current), before);
          const remainingBlockers = priorFindings.filter(
            item => (item.severity === 'critical' || item.severity === 'important') && !resolvedIds.has(item.id),
          ).length;
          expect(result.summary.blockingIssueCount).toBe(remainingBlockers);
          expect(result.summary.resolved.sort()).toEqual([...resolvedIds].sort());
        },
      ),
      {numRuns: 60},
    );
  });
});
