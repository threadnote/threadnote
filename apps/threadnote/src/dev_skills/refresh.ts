import {DateTime, Effect, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {activeInstalledRelease, executingInstalledRelease, withStandaloneInstallationLock} from '../installations.js';
import {installationRoot} from '../process/standalone_lease.js';
import type {DevSkillsIssue, DevSkillsRefreshOutcome} from './contract.js';
import {compareWrite, decode, fail, json, readOptional, stableJson} from './files.js';
import {consumerId, enrollmentContext, readHomeIndex, readReceipt} from './registry.js';
import {loadDevSkillsBundle} from './manifest.js';
import {readDevSkillsRuntimeCapabilities, installedSummary} from './capabilities.js';
import {inspectOwned, verifyReceiptProjection} from './inspection.js';
import {withHomeLease, withPhysicalLock, withRuntimeCoordinator} from './lease.js';
import {selectDevSkillsTarget} from './plan.js';
import {applyCapturedDevSkills} from './mutation.js';
import {restoreOwnedProjection} from './maintenance.js';
import {readTransactionConsumer, recoverTransaction} from './transaction.js';
import {requirementsIssues} from './refresh_preview.js';
import {
  digest,
  parseRefreshState,
  readRefreshStateAt,
  refreshResult,
  refreshStatePath,
  type RefreshMember,
  type RefreshState,
} from './refresh_state.js';

export {previewDevSkillsRefresh, prepareDevSkillsRefresh} from './refresh_preview.js';
export type {DevSkillsRefreshCandidate} from './refresh_preview.js';
export {readDevSkillsRefresh} from './refresh_state.js';
/** This identity-free configuration is used only by the file/ownership service. */
const fileConfig = (path: Path.Path, home: string): RuntimeConfig => ({
  account: 'local',
  user: '',
  agentId: 'threadnote',
  agentContextHome: home,
  manifestPath: path.join(home, 'manifest.yaml'),
});
export const runDevSkillsRefresh = Effect.fn('devSkills.runRefresh')(function* (
  config: RuntimeConfig,
  intentId: string,
) {
  if (!digest(intentId)) return yield* fail('invalid-intent', 'Refresh requires its exact prepared intent identifier.');
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const context = yield* enrollmentContext(config);
  const initial = yield* readRefreshStateAt(context.root);
  if (!initial.state)
    return yield* fail('missing-intent', 'No prepared workflow refresh exists for this installation.');
  if (context.root !== installationRoot(path, system))
    return refreshResult(initial.state, [
      {
        code: 'enrollment-conflict',
        message: 'Executing installation differs from the home’s recorded enrollment root.',
      },
    ]);
  // Fully capture the executing release before waiting. A force replacement while
  // waiting cannot make this process silently use another release's bytes.
  const captured = yield* loadDevSkillsBundle().pipe(Effect.result);
  if (captured._tag === 'Failure')
    return refreshResult(initial.state, [{code: 'invalid-bundle', message: String(captured.failure).slice(0, 512)}]);
  const capabilities = yield* readDevSkillsRuntimeCapabilities();
  return yield* withStandaloneInstallationLock(
    Effect.gen(function* () {
      const read = yield* readRefreshStateAt(context.root);
      if (!read.state) return yield* fail('missing-intent', 'Prepared refresh disappeared.');
      let state: RefreshState = read.state;
      if (state.intentId !== intentId) {
        const history = yield* readOptional(path.join(context.root, 'dev-skills-refresh-history', `${intentId}.json`));
        if (history !== null) state = yield* decode(history, value => parseRefreshState(value, context.root, path));
        return refreshResult(state, [
          {
            code: 'stale-active-release',
            message: 'A newer refresh intent superseded this child. Retry the active runtime update.',
          },
        ]);
      }
      const active = yield* activeInstalledRelease();
      const executing = yield* executingInstalledRelease();
      const expected = {releaseRoot: state.request.release.releaseRoot, version: state.request.release.releaseVersion};
      if (
        stableJson(active) !== stableJson(expected) ||
        stableJson(executing) !== stableJson(expected) ||
        capabilities.runtimeVersion !== expected.version ||
        captured.success.manifest.digest !== state.request.release.bundleDigest ||
        stableJson(captured.success.manifest) !== stableJson(state.request.desired)
      )
        return refreshResult(state, [
          {
            code: 'stale-active-release',
            message: 'Active release, executing binary and prepared workflow payload must match exactly.',
          },
        ]);
      return yield* withRuntimeCoordinator(context.root, coordinator =>
        Effect.gen(function* () {
          let content = read.content!;
          const persist = (next: RefreshState) =>
            Effect.gen(function* () {
              const nextContent = json(next);
              if (Buffer.byteLength(nextContent) > 8_000_000)
                return yield* fail('state-capacity', 'Refresh progress exceeds its bounded capacity.');
              yield* decode(nextContent, value => parseRefreshState(value, context.root, path));
              yield* compareWrite(refreshStatePath(path, context.root), content, nextContent);
              content = nextContent;
              state = next;
            });
          const checkpoint = (
            id: string,
            status: DevSkillsRefreshOutcome['state'],
            issues: readonly DevSkillsIssue[],
          ) =>
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              const outcome: DevSkillsRefreshOutcome = {
                intentId,
                requestedReleaseVersion: state.request.release.releaseVersion,
                requestedBundleDigest: state.request.release.bundleDigest,
                state: status,
                attemptedAt: now,
                ...(status === 'pending' ? {} : {completedAt: now}),
                issues,
              };
              yield* persist({...state, outcomes: {...state.outcomes, [id]: outcome}});
            });
          // Enrollment may have changed after preparation released the coordinator.
          // A new enabled consumer needs fresh intent authority, including its own
          // retained-generation compatibility proof; never append it to this request.
          const preparedEnabled = new Set(
            state.request.members
              .filter(member => member.enrollment.state === 'enrolled' && member.enrollment.enabled)
              .map(member => member.consumerId),
          );
          const currentMembers = (yield* enrollmentContext(config)).runtimeIndex.enrollments;
          const added = Object.entries(currentMembers).filter(
            ([id, entry]) => entry.state === 'enrolled' && entry.enabled && !preparedEnabled.has(id),
          );
          if (added.length) {
            const issues = [
              {
                code: 'enrollment-drift',
                message: `${added.length} enabled workflow consumer(s) changed since preparation. Run threadnote update again to prepare the current membership.`,
              },
            ];
            // Unattempted outcomes need a durable timestamp too: the parent must
            // read back exactly the same result returned by this child.
            for (const id of [
              ...state.request.members.map(member => member.consumerId),
              ...state.request.affected.map(consumerId),
            ])
              if (!state.outcomes[id]) yield* checkpoint(id, 'pending', issues);
            yield* persist({...state, issues});
            return refreshResult(state);
          }
          if (state.issues?.length) yield* persist({...state, issues: []});
          const groups = new Map<string, RefreshMember[]>();
          for (const member of state.request.members) {
            const root = member.enrollment.target.skillRoot;
            groups.set(root, [...(groups.get(root) ?? []), member]);
          }
          for (const [root, unsorted] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
            const original = yield* readTransactionConsumer(root).pipe(Effect.result);
            const originalId =
              original._tag === 'Success' && original.success ? consumerId(original.success) : undefined;
            const members = [...unsorted].sort((a, b) =>
              a.consumerId === originalId
                ? -1
                : b.consumerId === originalId
                  ? 1
                  : a.enrollment.home.localeCompare(b.enrollment.home) || a.consumerId.localeCompare(b.consumerId),
            );
            for (const member of members) {
              const attempt = yield* Effect.gen(function* () {
                const current = yield* enrollmentContext(config);
                const enrollment = current.runtimeIndex.enrollments[member.consumerId];
                if (!enrollment)
                  return yield* fail(
                    'enrollment-conflict',
                    'Prepared consumer is no longer registered; refresh cannot enroll it.',
                  );
                if (
                  stableJson(enrollment.target) !== stableJson(member.enrollment.target) ||
                  enrollment.home !== member.enrollment.home
                )
                  return yield* fail('enrollment-conflict', 'Prepared target identity changed.');
                const ownConfig = fileConfig(path, enrollment.home);
                const home = yield* readHomeIndex(ownConfig);
                if (!home.index || home.index.installationRoot !== context.root)
                  return yield* fail(
                    'enrollment-conflict',
                    'Registered home enrollment is inaccessible or differs; refresh does not reconstruct it.',
                  );
                const selector = {
                  agent: enrollment.target.surfaceId,
                  profile: enrollment.target.profile,
                  scope: enrollment.target.scope,
                  cwd: enrollment.target.cwd,
                };
                if (stableJson(yield* selectDevSkillsTarget(ownConfig, selector)) !== stableJson(enrollment.target))
                  return yield* fail(
                    'enrollment-conflict',
                    'Recorded native target no longer matches its supported selector.',
                  );
                return yield* withHomeLease(ownConfig, coordinator, lease =>
                  Effect.gen(function* () {
                    // An interrupted physical mutation can change both indexes. Resume
                    // its original consumer before interpreting consent; ordinary opt-outs
                    // still skip without creating a physical lock or destination.
                    if (originalId === member.consumerId)
                      yield* withPhysicalLock(
                        root,
                        recoverTransaction({
                          home: enrollment.home,
                          installationRoot: context.root,
                          target: enrollment.target,
                        }),
                      );
                    // The home lease first recovers a validated enablement journal.
                    // Only its recovered indexes may authorize a skip or a write.
                    const recovered = yield* enrollmentContext(ownConfig);
                    const currentEnrollment = recovered.runtimeIndex.enrollments[member.consumerId];
                    if (
                      !currentEnrollment ||
                      recovered.homeContent === null ||
                      recovered.root !== context.root ||
                      stableJson(currentEnrollment.target) !== stableJson(enrollment.target) ||
                      currentEnrollment.home !== enrollment.home ||
                      stableJson(recovered.homeIndex.targets[member.consumerId]) !== stableJson(currentEnrollment)
                    )
                      return yield* fail(
                        'enrollment-conflict',
                        'Recovered home and runtime enrollment differ; refresh does not reconstruct consent.',
                      );
                    if (currentEnrollment.state === 'removed' || !currentEnrollment.enabled) return 'skipped' as const;
                    if (member.enrollment.state !== 'enrolled' || !member.enrollment.enabled)
                      return yield* fail(
                        'enrollment-conflict',
                        'Consumer was enabled after this intent; prepare a new refresh.',
                      );
                    yield* withPhysicalLock(
                      root,
                      Effect.gen(function* () {
                        const consumer = {
                          home: enrollment.home,
                          installationRoot: context.root,
                          target: enrollment.target,
                        };
                        yield* recoverTransaction(consumer);
                        const receipt = (yield* readReceipt(enrollment.target)).receipt;
                        if (!receipt || stableJson(receipt.consumers[member.consumerId]) !== stableJson(consumer))
                          return yield* fail(
                            'enrollment-conflict',
                            'Physical ownership does not match the prepared consumer.',
                          );
                        if (
                          member.installed &&
                          ![member.installed.digest, state.request.release.bundleDigest].includes(
                            receipt.manifest.digest,
                          )
                        )
                          return yield* fail(
                            'preimage-conflict',
                            'A different generation replaced the prepared target; preserve it and preview again.',
                          );
                        for (const manifest of Object.values(receipt.generations)) {
                          const incompatible = requirementsIssues(installedSummary(manifest), capabilities);
                          if (incompatible.length) return yield* fail('incompatible', incompatible[0].message);
                        }
                        yield* restoreOwnedProjection(ownConfig, consumer);
                      }),
                    );
                    yield* applyCapturedDevSkills(ownConfig, captured.success, 'update', selector, {lease});
                    return yield* withPhysicalLock(
                      root,
                      Effect.gen(function* () {
                        const receipt = (yield* readReceipt(enrollment.target)).receipt;
                        if (
                          !receipt?.consumers[member.consumerId] ||
                          receipt.manifest.digest !== state.request.release.bundleDigest
                        )
                          return yield* fail(
                            'readback-conflict',
                            'Refreshed ownership does not match the prepared generation.',
                          );
                        yield* verifyReceiptProjection(enrollment.target, receipt);
                        const inspection = yield* inspectOwned(enrollment.target, receipt);
                        if (inspection.issues.length)
                          return yield* fail(
                            'readback-conflict',
                            inspection.issues.map(issue => issue.message).join(' '),
                          );
                        return 'current' as const;
                      }),
                    );
                  }),
                );
              }).pipe(Effect.result);
              if (attempt._tag === 'Success')
                yield* checkpoint(
                  member.consumerId,
                  attempt.success,
                  attempt.success === 'skipped'
                    ? [{code: 'disabled', message: 'Consumer is disabled or removed; no maintenance was requested.'}]
                    : [],
                );
              else
                yield* checkpoint(member.consumerId, 'pending', [
                  {code: 'refresh-pending', message: String(attempt.failure).slice(0, 512)},
                ]);
            }
          }
          // Foreign installation consumers are reported, never opened as private homes
          // or written into this installation's enrollment index.
          for (const consumer of state.request.affected) {
            const verified = yield* Effect.gen(function* () {
              const receipt = (yield* readReceipt(consumer.target)).receipt;
              if (!receipt || stableJson(receipt.consumers[consumerId(consumer)]) !== stableJson(consumer))
                return yield* fail('enrollment-conflict', 'Shared consumer ownership changed.');
              yield* verifyReceiptProjection(consumer.target, receipt);
              const inspection = yield* inspectOwned(consumer.target, receipt);
              if (inspection.issues.length)
                return yield* fail('readback-conflict', 'Shared projection is pending recovery.');
              return receipt.manifest.digest === state.request.release.bundleDigest;
            }).pipe(Effect.result);
            yield* checkpoint(consumerId(consumer), verified._tag === 'Success' ? 'skipped' : 'pending', [
              {
                code: 'shared-consumer',
                message:
                  verified._tag === 'Success' && verified.success
                    ? 'Shared physical generation was refreshed; this foreign enrollment and private home were not changed.'
                    : 'Foreign enrollment is not managed by this installation; its shared physical target was not verified at the requested release.',
              },
            ]);
          }
          return refreshResult(state);
        }),
      );
    }),
  );
});
