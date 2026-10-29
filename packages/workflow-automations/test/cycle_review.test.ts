import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {validateNativeCycleReview, validateNativeCycleReviewHistory} from '../src/cycle_review.js';
import type {NativeCycleReview, NativeCycleSnapshot} from '../src/cycle_review.js';
import {Array as EffectArray, String as EffectString} from 'effect';
import * as Effect2 from 'effect';

const hash = (char: string) => Effect2.pipe(char, EffectString.repeat(64));
const objectId = (char: string) => Effect2.pipe(char, EffectString.repeat(40));

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
  selected: ['correctness', 'simplicity', 'security'],
  lanes: [
    {name: 'correctness', status: 'complete'},
    {name: 'simplicity', status: 'complete'},
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
      {...valid, selected: ['correctness', 'security'], lanes: [{name: 'correctness', status: 'complete'}]},
      {...valid, selected: ['correctness', 'security', 'security']},
      {...valid, lanes: [...valid.lanes, valid.lanes[1]]},
      {...valid, selected: ['security'], lanes: [{name: 'security', status: 'complete'}]},
      {...valid, lanes: [{name: 'correctness', status: 'running'}, valid.lanes[1]]},
    ])
      expect(caught(() => validateNativeCycleReview(snapshot(), input, previous))).toMatchObject({
        code: 'invalid-cycle-review',
      });
  });

  it('rejects self-review even alongside both independent mandatory lanes', () => {
    const current = snapshot({previous: undefined, previousTree: undefined});
    const rootOnly = review(
      {mode: 'full', selected: ['root'], lanes: [{name: 'root', status: 'complete'}], findings: []},
      current,
    );
    expect(caught(() => validateNativeCycleReview(current, rootOnly))).toMatchObject({
      code: 'invalid-cycle-review',
      message: 'Select the required correctness review lane and include its complete report.',
    });
    const orchestratorOnly = {
      ...rootOnly,
      selected: ['orchestrator'],
      lanes: [{name: 'orchestrator', status: 'complete'}],
    };
    for (const selected of [
      orchestratorOnly.selected,
      ['orchestrator', 'simplicity'],
      ['correctness', 'simplicity', 'orchestrator'],
    ])
      expect(
        caught(() =>
          validateNativeCycleReview(current, {
            ...rootOnly,
            selected,
            lanes: EffectArray.map(selected, name => ({name, status: 'complete'})),
          }),
        ),
      ).toMatchObject({
        code: 'invalid-cycle-review',
        message: 'The orchestrator must not review source. Use independent correctness and simplicity review lanes.',
      });
    const valid = review({mode: 'full', findings: []}, current);
    for (const input of [
      {...valid, selected: [...valid.selected, 'orchestrator']},
      {...valid, lanes: [...valid.lanes, {name: 'orchestrator', status: 'complete'}]},
    ])
      expect(caught(() => validateNativeCycleReview(current, input))).toMatchObject({
        code: 'invalid-cycle-review',
      });
  });

  it.each(['full', 'incremental'] as const)(
    'requires separate selected and completed correctness and simplicity in every new %s report',
    mode => {
      const current = mode === 'full' ? snapshot({previous: undefined, previousTree: undefined}) : snapshot();
      const valid = review({mode, findings: [finding({state: mode === 'full' ? 'new' : 'carried'})]}, current);
      const history = mode === 'incremental' ? previous : undefined;
      expect(validateNativeCycleReview(current, valid, history).review.selected).toEqual([
        'correctness',
        'simplicity',
        'security',
      ]);
      for (const required of ['correctness', 'simplicity'])
        for (const input of [
          {
            ...valid,
            selected: EffectArray.filter(valid.selected, name => name !== required),
            lanes: EffectArray.filter(valid.lanes, lane => lane.name !== required),
          },
          {...valid, lanes: EffectArray.filter(valid.lanes, lane => lane.name !== required)},
          {...valid, selected: EffectArray.filter(valid.selected, name => name !== required)},
          {
            ...valid,
            lanes: EffectArray.map(valid.lanes, lane => (lane.name === required ? {...lane, status: 'running'} : lane)),
          },
          {...valid, selected: [...valid.selected, required]},
          {...valid, lanes: [...valid.lanes, {name: required, status: 'complete'}]},
        ])
          expect(caught(() => validateNativeCycleReview(current, input, history))).toMatchObject({
            code: 'invalid-cycle-review',
          });
    },
  );

  it('reads legacy review history unchanged while refusing it for current submission or acceptance', () => {
    const original = JSON.stringify(priorReview);
    const stored = validateNativeCycleReviewHistory(priorSnapshot, priorReview);
    expect(stored.review).toEqual(priorReview);
    expect(stored.review.selected).not.toContain('simplicity');
    expect(JSON.stringify(priorReview)).toBe(original);
    expect(caught(() => validateNativeCycleReview(priorSnapshot, stored.review))).toMatchObject({
      code: 'invalid-cycle-review',
      message: 'The orchestrator must not review source. Use independent correctness and simplicity review lanes.',
    });
    expect(caught(() => validateNativeCycleReviewHistory(priorSnapshot, {...priorReview, lanes: []}))).toMatchObject({
      code: 'invalid-cycle-review',
    });
    const legacyWithSimplicity = {
      ...priorReview,
      selected: [...priorReview.selected, 'simplicity'],
      lanes: [...priorReview.lanes, {name: 'simplicity', status: 'complete'}],
    };
    expect(validateNativeCycleReviewHistory(priorSnapshot, legacyWithSimplicity).review).toEqual(legacyWithSimplicity);
    expect(caught(() => validateNativeCycleReview(priorSnapshot, legacyWithSimplicity))).toMatchObject({
      code: 'invalid-cycle-review',
    });
  });

  it('admits bounded lane combinations only when both mandatory lanes are selected and complete', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.uniqueArray(fc.constantFrom('security', 'performance', 'architecture'), {maxLength: 3}),
        (
          incremental,
          correctnessSelected,
          simplicitySelected,
          correctnessComplete,
          simplicityComplete,
          orchestratorSelected,
          specialists,
        ) => {
          const current = incremental ? snapshot() : snapshot({previous: undefined, previousTree: undefined});
          const selected = [
            ...specialists,
            ...(correctnessSelected ? ['correctness'] : []),
            ...(simplicitySelected ? ['simplicity'] : []),
            ...(orchestratorSelected ? ['orchestrator'] : []),
          ];
          const completed = [...specialists, ...(orchestratorSelected ? ['orchestrator'] : [])];
          if (correctnessComplete) completed.push('correctness');
          if (simplicityComplete) completed.push('simplicity');
          const input = review(
            {
              mode: incremental ? 'incremental' : 'full',
              selected,
              lanes: EffectArray.map(completed, name => ({name, status: 'complete'})),
              findings: [],
            },
            current,
          );
          // Keep the existing predecessor ledger valid so this property isolates lane admission.
          const history = incremental ? {...previous, review: {...priorReview, findings: []}} : undefined;
          const error = caught(() => validateNativeCycleReview(current, input, history));
          if (
            correctnessSelected &&
            correctnessComplete &&
            simplicitySelected &&
            simplicityComplete &&
            !orchestratorSelected
          )
            expect(error).toBeUndefined();
          else expect(error).toMatchObject({code: 'invalid-cycle-review'});
        },
      ),
      {numRuns: 60},
    );
  });

  it('round-trips immutable legacy lane reports without rewriting their source or finding identities', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('simplicity', 'correctness', 'performance'), {maxLength: 3}),
        additional => {
          const selected = ['orchestrator', 'security', ...additional];
          const legacy = {
            ...priorReview,
            selected,
            lanes: EffectArray.map(selected, name => ({name, status: 'complete'})),
          };
          const bytes = JSON.stringify({snapshot: priorSnapshot, review: legacy});
          const decoded = JSON.parse(bytes);
          expect(validateNativeCycleReviewHistory(decoded.snapshot, decoded.review).review).toEqual(legacy);
          expect(JSON.stringify(decoded)).toBe(bytes);
          expect(caught(() => validateNativeCycleReview(decoded.snapshot, decoded.review))).toMatchObject({
            code: 'invalid-cycle-review',
          });
        },
      ),
      {numRuns: 40},
    );
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
      ...EffectArray.map(badLocations, file => [finding({file})]),
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
          .filter(items => new Set(EffectArray.map(items, item => item.id)).size === items.length),
        items => {
          const current = snapshot({previous: undefined, previousTree: undefined});
          const findings = EffectArray.map(items, item =>
            finding({id: `finding-${item.id}`, severity: item.severity, state: 'new'}),
          );
          const result = validateNativeCycleReview(current, review({findings, mode: 'full'}, current));
          const expected = EffectArray.reduce(
            items,
            {
              critical: 0,
              important: 0,
              minor: 0,
              informational: 0,
            },
            (counts, item) => ({...counts, [item.severity]: counts[item.severity] + 1}),
          );
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
          const priorFindings = EffectArray.map(severities, (severity, index) =>
            finding({
              id: `finding-${index}`,
              severity,
              state: 'new',
            }),
          );
          const before = {...previous, review: {...priorReview, findings: priorFindings}};
          const resolvedIds = new Set(
            EffectArray.map(
              EffectArray.filter(
                EffectArray.filter(
                  priorFindings,
                  item => item.severity === 'critical' || item.severity === 'important',
                ),
                (_, index) => index % 2 === 0,
              ),
              item => item.id,
            ),
          );
          const afterFindings = EffectArray.map(priorFindings, item =>
            resolvedIds.has(item.id)
              ? {...item, state: 'resolved' as const, reason: 'The reported path is now guarded.'}
              : {...item, state: 'carried' as const},
          );
          const result = validateNativeCycleReview(current, review({findings: afterFindings}, current), before);
          const remainingBlockers = EffectArray.filter(
            priorFindings,
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
