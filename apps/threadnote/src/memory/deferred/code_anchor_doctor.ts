import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import type {DoctorCheck} from '../../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {observeDeferredCodeAnchorCallerCheckout} from './code_anchor_checkout.js';
import {listDeferredCodeAnchorIntents, type StoredDeferredCodeAnchorIntent} from './code_anchor.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_INSPECTIONS = 25;
const CONCURRENCY = 4;

export const deferredCodeAnchorDoctorCheck = Effect.fn('memoryCodeAnchor.doctorCheck')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const entries = yield* listDeferredCodeAnchorIntents(config);
  const invalid = EffectArray.filter(entries, entry => entry.kind === 'invalid').length;
  if (invalid > 0) {
    return {
      detail: `${invalid} malformed or unreadable private intent(s); run \`threadnote finalize-code-refs\` for a bounded failure receipt`,
      name: 'deferred code anchors',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  if (entries.length === 0) {
    return {
      detail: 'no pending private code-anchor intents',
      name: 'deferred code anchors',
      status: 'ok',
    } satisfies DoctorCheck;
  }
  const inspected = EffectArray.filter(
    entries.slice(0, MAX_INSPECTIONS),
    (entry): entry is StoredDeferredCodeAnchorIntent => entry.kind === 'valid',
  );
  const attribution = yield* Effect.forEach(
    inspected,
    entry =>
      observeDeferredCodeAnchorCallerCheckout(entry.intent.callerCwd).pipe(
        Effect.catchCause(() => Effect.succeed({state: 'unobserved'} as const)),
        Effect.map(observation => {
          const reason =
            observation.state === 'missing'
              ? 'caller checkout missing'
              : observation.state === 'unobserved'
                ? 'checkout unobserved/read failure'
                : observation.repositoryId === entry.intent.repositoryId &&
                    observation.worktreeId === entry.intent.worktreeId
                  ? 'present matching'
                  : 'caller repository identity changed';
          return `${Effect2.pipe(entry.intent.worktreeId, EffectString.slice(0, 12))} ${reason}`;
        }),
      ),
    {concurrency: CONCURRENCY},
  );
  const remaining = entries.length - inspected.length;
  return {
    detail: `${entries.length} private code-anchor intent(s) are pending finalization across ${new Set(EffectArray.map(inspected, entry => entry.intent.worktreeId)).size} worktree(s): ${EffectArray.join([...new Set(attribution)], ', ')}${remaining > 0 ? `; attribution partial (${remaining} remaining)` : ''}`,
    name: 'deferred code anchors',
    status: 'warn',
  } satisfies DoctorCheck;
});
