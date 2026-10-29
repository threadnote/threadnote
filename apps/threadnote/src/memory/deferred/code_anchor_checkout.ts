import {Effect, FileSystem, Result, Schema} from 'effect';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphRepositoryError} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export type DeferredCodeAnchorCallerCheckoutObservation =
  | {readonly state: 'missing'}
  | {readonly state: 'unobserved'}
  | {readonly repositoryId: string; readonly state: 'present'; readonly worktreeId: string};

export type DeferredCodeAnchorCallerCheckoutAdmission =
  | {readonly state: 'eligible'}
  | {
      readonly reason: 'caller-checkout-missing' | 'caller-repository-identity-changed';
      readonly state: 'conflict';
    };

function isUnusableDeferredCodeAnchorCallerCheckout(error: unknown): boolean {
  return (
    Schema.is(CodeGraphRepositoryError)(error) &&
    Effect2.pipe(error.message, EffectString.startsWith('Not a Git repository'))
  );
}

export const observeDeferredCodeAnchorCallerCheckout = Effect.fn('memoryCodeAnchor.observeCallerCheckout')(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(cwd))) return {state: 'missing'} as const;
  const identity = yield* resolveRepositoryIdentity(cwd).pipe(Effect.result);
  if (Result.isSuccess(identity)) {
    return {
      repositoryId: identity.success.repositoryId,
      state: 'present' as const,
      worktreeId: identity.success.worktreeId,
    };
  }
  if (isUnusableDeferredCodeAnchorCallerCheckout(identity.failure)) {
    return {state: 'missing'} as const;
  }
  return {state: 'unobserved'} as const;
});

export const classifyDeferredCodeAnchorCallerCheckoutAdmission = Effect.fn(
  'memoryCodeAnchor.classifyCallerCheckoutAdmission',
)(function* (
  threadnoteHome: string,
  intent: {readonly callerCwd: string; readonly repositoryId: string; readonly worktreeId: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const query = yield* CodeGraphQueryService;
  const checkout = yield* observeDeferredCodeAnchorCallerCheckout(intent.callerCwd);
  if (checkout.state === 'missing') {
    return {
      reason: 'caller-checkout-missing',
      state: 'conflict',
    } satisfies DeferredCodeAnchorCallerCheckoutAdmission;
  }
  const status = yield* query
    .status(threadnoteHome, intent.callerCwd, {
      observeWorktree: true,
      requestMaintenance: false,
    })
    .pipe(Effect.result);
  if (Result.isFailure(status)) {
    if (isUnusableDeferredCodeAnchorCallerCheckout(status.failure) || !(yield* fs.exists(intent.callerCwd))) {
      return {
        reason: 'caller-checkout-missing',
        state: 'conflict',
      } satisfies DeferredCodeAnchorCallerCheckoutAdmission;
    }
    return yield* Effect.fail(status.failure);
  }
  if (
    status.success.identity.repositoryId !== intent.repositoryId ||
    status.success.identity.worktreeId !== intent.worktreeId
  ) {
    return {
      reason: 'caller-repository-identity-changed',
      state: 'conflict',
    } satisfies DeferredCodeAnchorCallerCheckoutAdmission;
  }
  return {state: 'eligible'} satisfies DeferredCodeAnchorCallerCheckoutAdmission;
});
