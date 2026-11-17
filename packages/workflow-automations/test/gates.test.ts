import {Schema} from 'effect';
import {NativeCycleWaiverSchema, nativeCycleWaiverId} from '../src/cycle_runtime.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {describe, expect, it} from 'vitest';
import {
  decideGate,
  nativeGates,
  nativeNextCommand,
  nativeTaskViewNext,
  nativeWaivableGateIds,
  nativeWorkflowPolicyOf,
  type GateId,
} from '../src/gates.js';

const next = nativeTaskViewNext('run-1', '/checkout');
const violation = {files: ['docs/unplanned.md']};
const waiver = {id: 'waiver-1'};

describe('dev-cycle gate decisions', () => {
  const cases: readonly [GateId, 'standard' | 'strict', boolean, 'pass' | 'warn' | 'refuse'][] = [
    ['scope.out-of-plan', 'standard', false, 'warn'],
    ['scope.out-of-plan', 'strict', false, 'refuse'],
    ['review.required', 'standard', false, 'refuse'],
    ['review.required', 'strict', false, 'refuse'],
    ['review.required', 'strict', true, 'warn'],
    ['review.blocking', 'standard', false, 'refuse'],
    ['review.blocking', 'standard', true, 'warn'],
  ];
  it.each(cases)('%s under %s with waiver=%s decides %s', (gate, policy, waived, expected) => {
    const decision = decideGate(policy, gate, violation, waived ? waiver : undefined, next);
    expect(decision._tag).toBe(expected);
    if (decision._tag === 'refuse') expect(decision).toMatchObject({gate, detail: violation, next});
    if (decision._tag === 'warn') expect(decision.waiverId).toBe(waived ? waiver.id : undefined);
  });

  it('passes every gate when nothing is violated', () => {
    for (const gate of EffectRecord.keys(nativeGates))
      expect(decideGate('strict', gate, undefined, undefined, next)).toEqual({_tag: 'pass'});
  });

  it('offers waivers only for the review gates', () => {
    expect(nativeWaivableGateIds).toEqual(['review.required', 'review.blocking']);
  });

  it('treats a run without a recorded policy as strict', () => {
    expect(nativeWorkflowPolicyOf({})).toBe('strict');
    expect(nativeWorkflowPolicyOf({policy: {mode: 'standard'}})).toBe('standard');
  });

  it('renders a next command for MCP and for the CLI with placeholders for unknown values', () => {
    expect(
      nativeNextCommand(
        'workflow_task_snapshot',
        'record',
        {command: 'task-action record-snapshot', flags: {runId: 'run-1', callerCwd: '/a b', reason: '<reason>'}},
        {runId: 'run-1', callerCwd: '/a b', snapshot: {command: 'record', reason: '<reason>'}},
      ),
    ).toEqual({
      tool: 'workflow_task_snapshot',
      command: 'record',
      cli: 'threadnote workflow-automation task-action record-snapshot --run-id run-1 --caller-cwd "/a b" --reason <reason>',
      arguments: {runId: 'run-1', callerCwd: '/a b', snapshot: {command: 'record', reason: '<reason>'}},
    });
  });
});

describe('audited waiver records', () => {
  const waiver = {
    gate: 'review.required' as const,
    phaseId: 'one',
    snapshotId: 'tree-1',
    tree: EffectString.repeat(40)('a'),
    intentHash: EffectString.repeat(64)('b'),
    reason: 'The reviewer is unavailable.',
    userAuthority: 'User: proceed without review.',
  };
  const decode = Schema.decodeUnknownExit(NativeCycleWaiverSchema);

  it('derives a stable identity from its content', () => {
    expect(nativeCycleWaiverId(waiver)).toBe(nativeCycleWaiverId({...waiver}));
    expect(nativeCycleWaiverId({...waiver, tree: EffectString.repeat(40)('c')})).not.toBe(nativeCycleWaiverId(waiver));
    expect(nativeCycleWaiverId({...waiver, intentHash: EffectString.repeat(64)('d')})).not.toBe(
      nativeCycleWaiverId(waiver),
    );
    expect(decode({id: nativeCycleWaiverId(waiver), ...waiver})._tag).toBe('Success');
  });

  it('never records a waiver of a gate that no decision consults, such as intent confirmation', () => {
    for (const gate of ['intent.confirmation', 'validation.required', 'scope.out-of-plan'])
      expect(decode({id: nativeCycleWaiverId(waiver), ...waiver, gate})._tag).toBe('Failure');
  });
});
