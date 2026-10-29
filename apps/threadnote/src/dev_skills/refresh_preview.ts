import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  DevSkillsBundle,
  DevSkillsConsumer,
  DevSkillsInstalled,
  DevSkillsIssue,
  DevSkillsRefreshPlan,
  DevSkillsRuntimeCapabilities,
} from './contract.js';
import {
  assertSafePath,
  compareWrite,
  decode,
  fail,
  hash,
  isRecord,
  json,
  readOptional,
  requireValue,
  stableJson,
} from './files.js';
import {consumerId, enrollmentContext, homeIndexPath, parseHomeIndex, readReceipt, receiptPath} from './registry.js';
import {inspectOwned, verifyReceiptProjection} from './inspection.js';
import {loadDevSkillsBundleAt, parseNativeRequirements} from './manifest.js';
import {installedSummary} from './capabilities.js';
import {compareVersions} from '../release/version/compare.js';
import {withRuntimeCoordinator} from './lease.js';
import {
  parseCapabilities,
  parseRefreshState,
  readRefreshStateAt,
  refreshStatePath,
  version,
  type RefreshMember,
  type RefreshRequest,
  type RefreshState,
} from './refresh_state.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface DevSkillsRefreshCandidate {
  readonly releaseRoot: string;
  readonly releaseVersion: string;
  readonly capabilities: DevSkillsRuntimeCapabilities;
  /** Internal verified installer staging source; never an enrollment destination. */
  readonly bundleRoot?: string;
}
const prepared = new WeakMap<
  DevSkillsRefreshPlan,
  {candidate: DevSkillsRefreshCandidate; request: RefreshRequest; bundle: DevSkillsBundle}
>();
export const requirementsIssues = (
  installed: DevSkillsInstalled,
  capabilities: DevSkillsRuntimeCapabilities,
): DevSkillsIssue[] =>
  (installed.manifestSchema === 2 &&
    (capabilities.schemaVersion !== 2 ||
      !capabilities.manifestSchemas?.includes(2) ||
      !installed.nativeRequirements ||
      !capabilities.nativeFeatures ||
      EffectArray.some(
        EffectRecord.toEntries(installed.nativeRequirements),
        ([key, required]) => capabilities.nativeFeatures?.[key] !== required,
      ))) ||
  !capabilities.workflowProtocols.includes(installed.workflowProtocol) ||
  !capabilities.stateSchemas.includes(installed.stateSchema) ||
  compareVersions(capabilities.runtimeVersion, installed.minimumRuntime) < 0
    ? [
        {
          code: 'incompatible',
          message: `Candidate ${capabilities.runtimeVersion} cannot run retained workflows ${installed.releaseVersion} (${installed.digest}).`,
        },
      ]
    : [];
const errorIssue = (error: unknown): DevSkillsIssue => ({
  code: 'inspection-pending',
  message: `Ownership could not be verified: ${Effect2.pipe(String(error), EffectString.slice(0, 3000))}`,
});
export const previewDevSkillsRefresh = Effect.fn('devSkills.previewRefresh')(function* (
  config: RuntimeConfig,
  candidate: DevSkillsRefreshCandidate,
) {
  const path = yield* Path.Path;
  const context = yield* enrollmentContext(config);
  const capabilities = yield* decode(json(candidate.capabilities), parseCapabilities);
  if (
    !version(candidate.releaseVersion) ||
    capabilities.runtimeVersion !== candidate.releaseVersion ||
    candidate.releaseRoot !== path.join(context.root, 'versions', candidate.releaseVersion)
  )
    return yield* fail(
      'invalid-candidate',
      'Candidate must be the exact recorded installation version root and executable version.',
    );
  const source = candidate.bundleRoot ?? candidate.releaseRoot;
  if (source !== candidate.releaseRoot) {
    const segments = Effect2.pipe(
      path.relative(path.join(context.root, 'versions'), source),
      EffectString.split(path.sep),
    );
    if (
      segments.length !== 2 ||
      segments[1] !== 'release' ||
      !/^\.threadnote-update-[0-9A-Za-z._-]+$/u.test(segments[0])
    )
      return yield* fail('invalid-candidate', 'Candidate source is outside the verified installer staging layout.');
  }
  yield* assertSafePath(source);
  const releaseContent = yield* readOptional(path.join(source, 'release.json'));
  if (releaseContent === null) return yield* fail('invalid-candidate', 'Candidate release metadata is missing.');
  yield* decode(releaseContent, value => {
    requireValue(isRecord(value) && value.version === candidate.releaseVersion, 'Candidate release metadata differs.');
    return value;
  });
  const bundle = yield* loadDevSkillsBundleAt(source, candidate.releaseVersion, true);
  if (bundle.manifest.releaseVersion !== candidate.releaseVersion)
    return yield* fail('invalid-candidate', 'Candidate bundle version differs from its executable.');
  const globalIssues: DevSkillsIssue[] = [];
  if (
    !EffectArray.every([1, 2], schema => capabilities.enrollmentSchemas.includes(schema)) ||
    !capabilities.workflowProtocols.includes(1) ||
    !capabilities.stateSchemas.includes(1)
  )
    globalIssues.push({
      code: 'incompatible',
      message: 'Candidate lacks the shipped workflow/state and legacy/current enrollment protocols.',
    });
  globalIssues.push(...requirementsIssues(installedSummary(bundle.manifest), capabilities));
  const members: RefreshMember[] = [];
  const affected = new Map<string, DevSkillsConsumer>();
  for (const [id, enrollment] of EffectRecord.toEntries(context.runtimeIndex.enrollments).sort(([a], [b]) =>
    Effect2.pipe(a, EffectString.localeCompare(b)),
  )) {
    const issues: DevSkillsIssue[] = [];
    let retained: DevSkillsInstalled[] = [];
    let installed: DevSkillsInstalled | undefined;
    let receiptHash: string | null = null;
    let observedHash: string | null = null;
    let homeHash: string | null = null;
    const physical = yield* Effect.gen(function* () {
      const read = yield* readReceipt(enrollment.target);
      receiptHash = read.content === null ? null : hash(read.content);
      if (
        enrollment.state === 'enrolled' &&
        stableJson(read.receipt?.consumers[id]) !==
          stableJson({home: enrollment.home, installationRoot: enrollment.installationRoot, target: enrollment.target})
      )
        issues.push({code: 'enrollment-conflict', message: 'Runtime enrollment does not match physical ownership.'});
      if (read.receipt && EffectRecord.keys(read.receipt.consumers).length) {
        installed = installedSummary(read.receipt.manifest);
        retained = EffectArray.map(EffectRecord.values(read.receipt.generations), installedSummary).sort((a, b) =>
          Effect2.pipe(a.digest, EffectString.localeCompare(b.digest)),
        );
        for (const requirement of retained) issues.push(...requirementsIssues(requirement, capabilities));
        const inspection = yield* inspectOwned(enrollment.target, read.receipt);
        issues.push(...inspection.issues);
        observedHash = hash(stableJson(inspection.contents));
        const projection = yield* verifyReceiptProjection(enrollment.target, read.receipt).pipe(Effect.result);
        if (projection._tag === 'Failure') issues.push(errorIssue(projection.failure));
        for (const [otherId, consumer] of EffectRecord.toEntries(read.receipt.consumers))
          if (!context.runtimeIndex.enrollments[otherId]) affected.set(otherId, consumer);
      }
    }).pipe(Effect.result);
    if (physical._tag === 'Failure') {
      issues.push(errorIssue(physical.failure));
      // A future/corrupt receipt cannot be used as write authority. Still reject
      // concrete incompatible requirements visible in its bounded metadata.
      yield* Effect.gen(function* () {
        const content = yield* readOptional(receiptPath(path, enrollment.target.skillRoot));
        if (content === null) return;
        const requirements = yield* decode(content, value => {
          if (!isRecord(value) || !isRecord(value.generations) || EffectRecord.keys(value.generations).length > 1024)
            return [];
          return EffectArray.filter(EffectRecord.values(value.generations), (item): item is Record<string, unknown> =>
            isRecord(item),
          );
        });
        for (const item of requirements) {
          if (
            version(item.releaseVersion) &&
            version(item.minimumRuntime) &&
            typeof item.digest === 'string' &&
            /^[a-f0-9]{64}$/u.test(item.digest) &&
            Number.isSafeInteger(item.workflowProtocol) &&
            Number.isSafeInteger(item.stateSchema)
          ) {
            if (typeof item.workflowProtocol === 'number' && typeof item.stateSchema === 'number')
              issues.push(
                ...requirementsIssues(
                  {
                    releaseVersion: item.releaseVersion,
                    minimumRuntime: item.minimumRuntime,
                    digest: item.digest,
                    workflowProtocol: item.workflowProtocol,
                    stateSchema: item.stateSchema,
                  },
                  capabilities,
                ),
              );
            if (
              item.schemaVersion === 2 &&
              typeof item.workflowProtocol === 'number' &&
              typeof item.stateSchema === 'number'
            ) {
              const native = yield* decode(json(item.nativeRequirements), parseNativeRequirements).pipe(Effect.result);
              if (native._tag === 'Failure')
                issues.push({
                  code: 'incompatible',
                  message: 'A retained native generation has invalid feature requirements.',
                });
              else
                issues.push(
                  ...requirementsIssues(
                    {
                      releaseVersion: item.releaseVersion,
                      minimumRuntime: item.minimumRuntime,
                      digest: item.digest,
                      workflowProtocol: item.workflowProtocol,
                      stateSchema: item.stateSchema,
                      manifestSchema: 2,
                      nativeRequirements: native.success,
                    },
                    capabilities,
                  ),
                );
            }
            if (typeof item.schemaVersion === 'number' && ![1, 2].includes(item.schemaVersion))
              issues.push({
                code: 'incompatible',
                message: 'A retained generation declares an unsupported manifest schema.',
              });
          }
        }
      }).pipe(Effect.ignore);
    }
    const home = yield* Effect.gen(function* () {
      const content = yield* readOptional(homeIndexPath(path, enrollment.home));
      homeHash = content === null ? null : hash(content);
      const index = content === null ? undefined : yield* decode(content, parseHomeIndex);
      if (
        !index ||
        index.home !== enrollment.home ||
        index.installationRoot !== context.root ||
        stableJson(index.targets[id]) !== stableJson(enrollment)
      )
        issues.push({
          code: 'enrollment-conflict',
          message: 'Registered home is missing or has different enrollment; setup must recover its own state.',
        });
    }).pipe(Effect.result);
    if (home._tag === 'Failure') issues.push(errorIssue(home.failure));
    members.push({
      consumerId: id,
      enrollment,
      retained,
      ...(installed ? {installed} : {}),
      receiptHash,
      observedHash,
      homeHash,
      issues,
    });
  }
  const request: RefreshRequest = {
    schemaVersion: 1,
    release: {
      installationRoot: context.root,
      releaseRoot: candidate.releaseRoot,
      releaseVersion: candidate.releaseVersion,
      bundleDigest: bundle.manifest.digest,
    },
    capabilities,
    desired: bundle.manifest,
    runtimeHash: context.runtimeContent === null ? null : hash(context.runtimeContent),
    members,
    affected: [...affected.values()].sort((a, b) =>
      Effect2.pipe(consumerId(a), EffectString.localeCompare(consumerId(b))),
    ),
  };
  const issues = [...globalIssues, ...EffectArray.flatMap(members, member => member.issues)];
  const plan: DevSkillsRefreshPlan = {
    schemaVersion: 1,
    release: request.release,
    targets: EffectArray.map(members, member => ({
      consumerId: member.consumerId,
      home: member.enrollment.home,
      target: member.enrollment.target,
      enabled: member.enrollment.enabled,
      enrollmentState: member.enrollment.state,
      ...(member.installed ? {installed: member.installed} : {}),
      issues: member.issues,
    })),
    compatibility: EffectArray.some(issues, issue => issue.code === 'incompatible')
      ? 'incompatible'
      : EffectArray.some(issues, issue => ['inspection-pending', 'enrollment-conflict'].includes(issue.code))
        ? 'unknown'
        : 'compatible',
    issues,
    previewDigest: hash(stableJson(request)),
  };
  prepared.set(plan, {candidate: {...candidate}, request, bundle});
  return plan;
});
export const prepareDevSkillsRefresh = Effect.fn('devSkills.prepareRefresh')(function* (
  config: RuntimeConfig,
  plan: DevSkillsRefreshPlan,
  options: {readonly expectedDigest: string},
) {
  const original = prepared.get(plan);
  if (!original || plan.previewDigest !== options.expectedDigest)
    return yield* fail('stale-preview', 'Refresh requires its exact internally prepared candidate preview.');
  return yield* withRuntimeCoordinator(plan.release.installationRoot, () =>
    Effect.gen(function* () {
      const current = yield* previewDevSkillsRefresh(config, original.candidate);
      if (current.previewDigest !== options.expectedDigest)
        return yield* fail('stale-preview', 'Enrollment or candidate bytes changed since refresh preview.');
      if (current.compatibility === 'incompatible')
        return yield* fail(
          'incompatible',
          EffectArray.join(
            EffectArray.map(
              EffectArray.filter(current.issues, issue => issue.code === 'incompatible'),
              issue => issue.message,
            ),
            ' ',
          ),
        );
      const request = prepared.get(current)!.request;
      const path = yield* Path.Path;
      const old = yield* readRefreshStateAt(request.release.installationRoot);
      // A successful partial refresh changes ownership hashes. Reuse the original intent
      // for the same release and membership, so response-loss retries retain their identity.
      const sameMembership = (a: RefreshRequest, b: RefreshRequest) =>
        stableJson(EffectArray.map(a.members, member => member.enrollment)) ===
        stableJson(EffectArray.map(b.members, member => member.enrollment));
      if (
        old.state &&
        stableJson(old.state.request.release) === stableJson(request.release) &&
        sameMembership(old.state.request, request) &&
        stableJson(old.state.request.affected) === stableJson(request.affected) &&
        EffectArray.every(old.state.request.members, prior => {
          const actual = EffectOption.getOrUndefined(
            EffectArray.findFirst(request.members, member => member.consumerId === prior.consumerId),
          )?.installed;
          return (
            !prior.installed ||
            !actual ||
            [prior.installed.digest, request.release.bundleDigest].includes(actual.digest)
          );
        })
      )
        return {intentId: old.state.intentId, release: old.state.request.release};
      const state: RefreshState = {schemaVersion: 1, intentId: hash(stableJson(request)), request, outcomes: {}};
      const content = json(state);
      const reservation = {
        ...state,
        issues: [{code: 'enrollment-drift', message: Effect2.pipe(String.fromCharCode(0), EffectString.repeat(512))}],
        outcomes: EffectRecord.fromEntries(
          EffectArray.map(
            [
              ...EffectArray.map(request.members, member => member.consumerId),
              ...EffectArray.map(request.affected, consumerId),
            ],
            id => [
              id,
              {
                intentId: state.intentId,
                requestedReleaseVersion: request.release.releaseVersion,
                requestedBundleDigest: request.release.bundleDigest,
                state: 'current',
                attemptedAt: '2000-01-01T00:00:00.000Z',
                completedAt: '2000-01-01T00:00:00.000Z',
                issues: [
                  {
                    code: Effect2.pipe('x', EffectString.repeat(128)),
                    message: Effect2.pipe(String.fromCharCode(0), EffectString.repeat(512)),
                  },
                ],
              },
            ],
          ),
        ),
      };
      if (Buffer.byteLength(json(reservation)) > 8_000_000)
        return yield* fail(
          'state-capacity',
          'Refresh intent and complete bounded outcomes exceed the journal capacity.',
        );
      yield* decode(content, value => parseRefreshState(value, request.release.installationRoot, path));
      if (old.state) {
        const history = path.join(
          request.release.installationRoot,
          'dev-skills-refresh-history',
          `${old.state.intentId}.json`,
        );
        const existing = yield* readOptional(history);
        const destination =
          existing !== null && existing !== old.content
            ? path.join(
                request.release.installationRoot,
                'dev-skills-refresh-history',
                `${old.state.intentId}-${hash(old.content!)}.json`,
              )
            : history;
        yield* compareWrite(destination, null, old.content);
      }
      yield* compareWrite(refreshStatePath(path, request.release.installationRoot), old.content, content);
      return {intentId: state.intentId, release: request.release};
    }),
  );
});
