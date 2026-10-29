import {Array as EffectArray} from 'effect';
import {ScriptError} from '../effect/errors.js';
import {Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const STAGE3_PHASES = [
  'linked-worktrees',
  'blocked-writer-discovery',
  'strict-current-boundary',
  'latest-demand-convergence',
  'pre-spawn-recovery',
  'adopted-child-recovery',
  'privacy-scan',
] as const;
export type Stage3Phase = (typeof STAGE3_PHASES)[number];

export interface Stage3PlanOptions {
  readonly mode: 'plan';
}

export interface Stage3ExecuteOptions {
  readonly mode: 'execute';
  readonly candidateCommit: string;
  readonly candidateRef: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly output: string;
}

export type Stage3Options = Stage3PlanOptions | Stage3ExecuteOptions;

export function stage3Usage(): string {
  return EffectArray.join(
    [
      'Usage: bun run gate:code-graph:stage3 -- [options]',
      '',
      'Runs the live Stage 3 code-graph release gate or prints its non-executing plan.',
      'Plan: --mode plan',
      'Execute: --mode execute --candidate-commit <40-hex> --candidate-ref <ref>',
      '  --candidate-executable <absolute-path> --candidate-executable-sha256 <64-hex> --output <absolute-path>',
    ],
    '\n',
  );
}

/** There is deliberately no observation-file, evidence-input, or replay mode. */
export function parseStage3Arguments(arguments_: readonly string[]): Stage3Options {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--mode',
    '--candidate-commit',
    '--candidate-ref',
    '--candidate-executable',
    '--candidate-executable-sha256',
    '--output',
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    assertStage3(
      allowed.has(key) && !values.has(key) && value !== undefined && !Effect.pipe(value, EffectString.startsWith('--')),
      'arguments',
    );
    values.set(key, value);
  }
  const value = (key: string) => {
    const result = values.get(key);
    assertStage3(
      result !== undefined &&
        result.length > 0 &&
        EffectArray.every(
          [...result],
          character =>
            Effect.pipe(
              character,
              EffectString.charCodeAt(0),
              Effect.Option.getOrElse(() => NaN),
            ) >= 32,
        ),
      'arguments',
    );
    return result;
  };
  const mode = value('--mode');
  assertStage3(mode === 'plan' || mode === 'execute', 'arguments');
  if (mode === 'plan') {
    assertStage3(values.size === 1, 'arguments');
    return {mode};
  }
  const candidateCommit = value('--candidate-commit');
  const candidateExecutableSha256 = value('--candidate-executable-sha256');
  assertStage3(/^[0-9a-f]{40}$/u.test(candidateCommit), 'candidate-identity');
  assertStage3(/^[0-9a-f]{64}$/u.test(candidateExecutableSha256), 'candidate-identity');
  const candidateRef = value('--candidate-ref');
  assertStage3(!Effect.pipe(candidateRef, EffectString.startsWith('-')), 'candidate-identity');
  const candidateExecutable = value('--candidate-executable');
  const output = value('--output');
  assertStage3(
    Effect.pipe(candidateExecutable, EffectString.startsWith('/')) && Effect.pipe(output, EffectString.startsWith('/')),
    'absolute-path-required',
  );
  return {mode, candidateCommit, candidateRef, candidateExecutable, candidateExecutableSha256, output};
}

export function stage3Plan() {
  return {
    type: 'code-graph-stage3-plan',
    version: 1,
    executed: false,
    phases: STAGE3_PHASES,
    linkedWorktrees: 3,
    simultaneousMcpHosts: 2,
    runtime: 'exact-clean-candidate-managed-development-payload',
    evidence: 'live-process-observations-only',
    measurements: 'states-and-bounded-retry-guidance-only',
    prerequisites: ['posix-signals', 'git', 'bun', 'installed-exact-candidate', 'private-temporary-storage'],
  } as const;
}

export function assertStage3(condition: unknown, code: string): asserts condition {
  if (!condition) throw ScriptError.make({message: `Stage 3 gate refused: ${code}.`});
}

export function stage3Record(value: unknown): Record<string, unknown> {
  assertStage3(Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value), 'response-shape');
  return value;
}

export interface Stage3Refresh {
  readonly state: 'active' | 'queued' | 'deferred' | 'idle';
  readonly currentTargetToken?: string;
  readonly latestDesiredToken?: string;
  readonly queueToken?: string;
  readonly retryAfterMilliseconds?: number;
}

/** Project by allowlist; unexpected fields in the privacy boundary fail instead of being silently stripped. */
export function stage3Refresh(value: unknown): Stage3Refresh {
  const record = stage3Record(value);
  const allowed = new Set([
    'type',
    'version',
    'state',
    'currentTargetToken',
    'latestDesiredToken',
    'queueToken',
    'retryAfterMilliseconds',
  ]);
  assertStage3(
    EffectArray.every(EffectRecord.keys(record), key => allowed.has(key)),
    'refresh-private-field',
  );
  assertStage3(record.type === 'code-graph-refresh-continuity' && record.version === 1, 'refresh-version');
  const state = record.state;
  assertStage3(state === 'active' || state === 'queued' || state === 'deferred' || state === 'idle', 'refresh-state');
  const tokens: {currentTargetToken?: string; latestDesiredToken?: string; queueToken?: string} = {};
  for (const key of ['currentTargetToken', 'latestDesiredToken', 'queueToken'] as const) {
    if (record[key] === undefined) continue;
    assertStage3(typeof record[key] === 'string' && /^cgdq_[0-9a-f]{32}$/u.test(record[key]), 'refresh-token');
    tokens[key] = record[key];
  }
  if (record.retryAfterMilliseconds !== undefined) {
    assertStage3(
      typeof record.retryAfterMilliseconds === 'number' &&
        Number.isSafeInteger(record.retryAfterMilliseconds) &&
        record.retryAfterMilliseconds >= 0 &&
        record.retryAfterMilliseconds <= 60_000,
      'retry-bound',
    );
    return {state, ...tokens, retryAfterMilliseconds: record.retryAfterMilliseconds};
  }
  return {state, ...tokens};
}

export interface Stage3Observation {
  readonly phase: Stage3Phase;
  readonly state: 'observed' | 'indexing' | 'deferred' | 'timed-out' | 'current' | 'stale' | 'idle';
  readonly operation?: 'query' | 'node' | 'neighbors' | 'explain' | 'path' | 'impact';
  readonly host?: 'a' | 'b';
  readonly target?: 'f1' | 'f2' | 'f3';
  readonly refresh?: Stage3Refresh;
  readonly retryAfterMilliseconds?: number;
}

/** Retained observations have no free-text lane; provenance is scanned separately as exact runtime evidence. */
export function scanStage3Observations(observations: readonly Stage3Observation[], forbidden: readonly string[]): void {
  assertStage3(observations.length > 0 && observations.length <= 128, 'privacy-size');
  const encoded = JSON.stringify(observations);
  assertStage3(encoded.length <= 64 * 1024, 'privacy-size');
  // Numeric identifiers are excluded structurally; substring matching them would collide with opaque tokens.
  assertStage3(
    !EffectArray.some(
      forbidden,
      value => value.length > 0 && !/^\d+$/u.test(value) && Effect.pipe(encoded, EffectString.includes(value)),
    ),
    'privacy-literal',
  );
  for (const observation of observations) {
    const record = stage3Record(observation);
    assertStage3(
      EffectArray.every(EffectRecord.keys(record), key =>
        ['phase', 'state', 'operation', 'host', 'target', 'refresh', 'retryAfterMilliseconds'].includes(key),
      ),
      'privacy-field',
    );
    assertStage3(STAGE3_PHASES.includes(observation.phase), 'privacy-phase');
    assertStage3(
      ['observed', 'indexing', 'deferred', 'timed-out', 'current', 'stale', 'idle'].includes(observation.state),
      'privacy-state',
    );
    assertStage3(
      observation.operation === undefined ||
        ['query', 'node', 'neighbors', 'explain', 'path', 'impact'].includes(observation.operation),
      'privacy-operation',
    );
    assertStage3(observation.host === undefined || ['a', 'b'].includes(observation.host), 'privacy-host');
    assertStage3(observation.target === undefined || ['f1', 'f2', 'f3'].includes(observation.target), 'privacy-target');
    if (observation.refresh !== undefined)
      stage3Refresh({type: 'code-graph-refresh-continuity', version: 1, ...observation.refresh});
    if (observation.retryAfterMilliseconds !== undefined) {
      assertStage3(
        Number.isSafeInteger(observation.retryAfterMilliseconds) &&
          observation.retryAfterMilliseconds >= 0 &&
          observation.retryAfterMilliseconds <= 60_000,
        'retry-bound',
      );
    }
  }
}
