import {Array as EffectArray, Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalFileUri} from '@threadnote/semantic/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  inspectSemanticHostProfile,
  SemanticHostProfile,
  SemanticHostProfileFault,
  writeSemanticHostProfile,
} from './host_profile.js';
import {
  makeSemanticAdmission,
  semanticSessionLimits,
  SemanticCompatibilityFault,
  verifyJavaSemanticCandidate,
  verifyNativeSemanticCandidate,
  verifySemanticNodeCandidate,
  inspectSemanticEndpoint,
} from './coordinator.js';
import {SemanticLanguage, SemanticSetupFault} from './provider.js';
import {semanticHostSelection} from './host_catalog.js';
import {semanticAgentQueryHost} from './agent_queries.js';

const RuntimeStatus = Schema.Struct({
  sessions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8)),
  failures: Schema.Array(
    Schema.Struct({
      attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      cause: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(256)),
});

const Request = Schema.Struct({
  version: Schema.Literal(1),
  callerCwd: Schema.String,
  language: Schema.optional(SemanticLanguage),
  profile: Schema.optional(SemanticHostProfile),
  expectedDigest: Schema.optional(Schema.String),
  apply: Schema.optional(Schema.Boolean),
});
const actions = {
  missing:
    'Configure an explicit private host profile with already installed, pinned provider and SDK artifacts; preview semantic setup first',
  disabled:
    'Graph and memory remain available; explicitly enable the known profile with semantic setup when analysis is wanted',
  incompatible:
    'Use a client supporting the retained state version, or restore a separately verified compatible configuration; do not remove recovery records',
  invalid: 'Correct the private host profile schema without discarding unknown configuration or recovery records',
  untrusted:
    'Check canonical paths, account ownership, private permissions and ACL proof; setup never repairs permissions automatically',
  'unsupported-platform':
    'Private profile ACL and descriptor proof is unavailable on this platform; use a qualified host. Graph and memory remain independent',
  indeterminate:
    'Setup publication is indeterminate; inspect the retained profile with a qualified client before retrying. Do not assume no write or remove recovery evidence',
} as const;

/** Local operational projection. No source, host paths, provider stderr or private capabilities enter the response. */
export const runSemanticDoctor = Effect.fn('semantic.doctor')(function* (
  config: RuntimeConfig,
  input: unknown,
  action: 'doctor' | 'status' | 'setup' | 'disable' = 'doctor',
) {
  let javaImportPolicy = 'not-assessed';
  let javaImportMode: string | undefined;
  const result = (state: string, nextAction: string, details: object = {}) => ({
    version: 1 as const,
    action,
    state,
    nextAction,
    graphAndMemory: 'available-independently' as const,
    versions: {profile: 1, bootstrap: 1, admission: 1, proposal: 1, journal: 1, writer: 'threadnote-writer-v1'},
    limits: semanticSessionLimits,
    policy: {
      automaticDownload: false,
      repositoryBuildPermission: false,
      javaImport: {
        state: javaImportPolicy,
        execution:
          javaImportMode === 'trusted-java-build-import-unconfined-v1'
            ? 'explicit-unconfined-grant-owned-build-support-required'
            : 'independent-pinned-importer-enforcement-required',
      },
      sourceReplay: false,
      productionQualified: false,
    },
    ...details,
  });
  const parsed = yield* Schema.decodeUnknownEffect(Request, {onExcessProperty: 'error'})(input).pipe(Effect.result);
  if (parsed._tag === 'Failure')
    return result(
      'invalid-request',
      'Provide bounded version:1 JSON with an absolute callerCwd and only the selected operation fields',
    );
  const request = parsed.success;
  if (
    (action !== 'setup' && request.profile !== undefined) ||
    (!['setup', 'disable'].includes(action) && (request.apply !== undefined || request.expectedDigest !== undefined))
  )
    return result('invalid-request', 'Profile and apply fields are limited to explicit local setup or disable');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(request.callerCwd))
    return result('invalid-request', 'callerCwd must be an absolute worktree root');
  const execute = Effect.gen(function* () {
    const root = yield* fs.realPath(request.callerCwd);
    if ((yield* fs.stat(root)).type !== 'Directory')
      return result('invalid-request', 'callerCwd must identify a worktree directory');
    const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
    const existing = yield* inspectSemanticHostProfile(config, worktree).pipe(Effect.result);
    if (
      existing._tag === 'Failure' &&
      !(
        action === 'setup' &&
        request.profile &&
        Schema.is(SemanticHostProfileFault)(existing.failure) &&
        existing.failure.reason === 'missing'
      )
    )
      return yield* existing.failure;
    const selected = existing._tag === 'Success' ? existing.success : undefined;
    javaImportPolicy = selected?.profile.javaImport ? (selected.profile.enabled ? 'configured' : 'disabled') : 'absent';
    javaImportMode = selected?.profile.javaImport?.mode;
    const profile = action === 'setup' ? (request.profile ?? selected?.profile) : selected?.profile;
    if (!profile) return result('missing', actions.missing);
    if (profile.worktree !== worktree) return result('incompatible', actions.incompatible);
    if (action === 'setup' && JSON.stringify(profile.javaImport) !== JSON.stringify(selected?.profile.javaImport))
      return result(
        'incompatible',
        'Use explicit local semantic import policy controls to establish, change or revoke Java import policy',
      );
    if (action === 'disable') {
      if (!request.apply)
        return result(
          'preview',
          'Pass apply:true and the current profileDigest to disable analysis; user content and recovery records are retained',
          {profileDigest: selected?.digest},
        );
      if (!selected || request.expectedDigest !== selected.digest) return result('incompatible', actions.incompatible);
      const written = yield* writeSemanticHostProfile(config, worktree, {...profile, enabled: false}, selected.digest);
      javaImportPolicy = profile.javaImport ? 'disabled' : 'absent';
      javaImportMode = profile.javaImport?.mode;
      return result('disabled', actions.disabled, {profileDigest: written.digest, changed: written.changed});
    }
    if (!profile.enabled && action !== 'setup')
      return result('disabled', actions.disabled, {profileDigest: selected?.digest});
    const catalog = profile.catalog;
    const providers: {id: string; state: string; cause?: string; nextAction: string; productionQualified: false}[] = [];
    const checks = [
      ...(catalog.candidate
        ? [{id: 'typescript-language-server', verify: verifySemanticNodeCandidate(catalog.candidate, true)}]
        : []),
      ...(catalog.python ? [{id: 'basedpyright', verify: verifySemanticNodeCandidate(catalog.python, true)}] : []),
      ...(catalog.go ? [{id: 'gopls', verify: verifyNativeSemanticCandidate(catalog.go, 'gopls')}] : []),
      ...(catalog.rust
        ? [{id: 'rust-analyzer', verify: verifyNativeSemanticCandidate(catalog.rust, 'rust-analyzer')}]
        : []),
      ...(catalog.java ? [{id: 'jdtls', verify: verifyJavaSemanticCandidate(catalog.java)}] : []),
    ];
    for (const check of checks) {
      if (action !== 'setup' && request.language && semanticHostSelection[request.language].provider !== check.id)
        continue;
      if (action === 'status') {
        providers.push({
          id: check.id,
          state: 'not-assessed',
          nextAction: 'Run semantic doctor to verify exact pinned artifacts without starting an analysis provider',
          productionQualified: false,
        });
        continue;
      }
      const verified = yield* check.verify.pipe(Effect.timeoutOption(15000), Effect.result);
      const okay = verified._tag === 'Success' && verified.success._tag === 'Some';
      providers.push({
        id: check.id,
        state: okay ? 'pinned-candidate' : 'unavailable',
        ...(okay
          ? {}
          : {
              cause:
                verified._tag === 'Success'
                  ? 'deadline'
                  : Schema.is(SemanticSetupFault)(verified.failure)
                    ? verified.failure.reason
                    : 'incompatible-or-unreadable',
            }),
        nextAction: okay
          ? 'Experimental host candidate only; license, distribution and platform release qualification remain gated'
          : verified._tag === 'Failure' && Schema.is(SemanticSetupFault)(verified.failure)
            ? verified.failure.nextAction
            : 'Verify the configured exact provider, SDK and runtime versions and SHA-256 digests, permissions and artifact bounds; no download is performed',
        productionQualified: false,
      });
    }
    // Reactivate only an existing, exact-preserved policy-only bootstrap. Nonempty catalogs still need verification.
    const policyOnlyReactivation =
      action === 'setup' &&
      request.language === undefined &&
      request.profile !== undefined &&
      selected?.profile.javaImport !== undefined &&
      !selected.profile.enabled &&
      profile.enabled &&
      JSON.stringify(selected.profile.catalog) === '{}' &&
      JSON.stringify(catalog) === '{}';
    if ((checks.length === 0 && !policyOnlyReactivation) || (request.language && providers.length === 0))
      return result('missing', actions.missing, {providers});
    if (EffectArray.some(providers, provider => provider.state === 'unavailable'))
      return result('unavailable', 'Correct the pinned host artifacts and retry; prior configuration is retained', {
        providers,
        profileDigest: selected?.digest,
      });
    if (action === 'setup') {
      if (!request.apply)
        return result(
          'preview',
          'Pass apply:true to save this exact private host profile; replacement also requires the current expectedDigest',
          {providers, profileDigest: selected?.digest},
        );
      const written = yield* writeSemanticHostProfile(config, worktree, profile, request.expectedDigest);
      javaImportPolicy = profile.javaImport ? (profile.enabled ? 'configured' : 'disabled') : 'absent';
      javaImportMode = profile.javaImport?.mode;
      return result(
        profile.enabled ? 'configured' : 'disabled',
        profile.enabled
          ? policyOnlyReactivation
            ? 'Java import policy re-enabled; positive import still requires independently established pinned-importer enforcement'
            : 'Start an explicit semantic query; no analysis process was started by setup'
          : actions.disabled,
        {providers, profileDigest: written.digest, changed: written.changed},
      );
    }
    const directory = path.join(selected!.home, 'semantic', 'admission-v1');
    const admission = (yield* fs.exists(directory))
      ? yield* (yield* makeSemanticAdmission({directory, readOnly: true})).status
      : {
          providers: 0,
          imports: 0,
          queued: 0,
          quarantined: 0,
          nextAction: 'No semantic admission state; analysis starts only on an explicit query',
        };
    const runtime = yield* Effect.gen(function* () {
      const runtimeIdentity = yield* semanticAgentQueryHost.runtimeIdentity;
      const raw = yield* inspectSemanticEndpoint({dataHome: selected!.home, worktree, runtimeIdentity});
      if (raw === undefined) return {state: 'not-running' as const};
      const status = yield* Schema.decodeUnknownEffect(RuntimeStatus)(raw);
      return {
        state: 'running' as const,
        sessions: status.sessions,
        failures: EffectArray.map(status.failures, failure => ({
          attempts: failure.attempts,
          cause: ['exit', 'write', 'protocol', 'timeout', 'shutdown', 'prerequisite', 'capacity', 'rejected'].includes(
            failure.cause ?? '',
          )
            ? failure.cause
            : 'unknown',
          nextAction:
            failure.attempts >= 2
              ? 'Correct prerequisites; restart only after the coordinator is idle and owned cleanup is confirmed'
              : 'Reattach an explicit view once prerequisites are ready',
        })),
      };
    }).pipe(
      Effect.catch(error =>
        Effect.succeed({
          state: Schema.is(SemanticCompatibilityFault)(error) ? ('incompatible' as const) : ('not-assessed' as const),
        }),
      ),
    );
    return result('configured', admission.nextAction, {
      providers,
      profileDigest: selected?.digest,
      admission,
      runtime,
      recovery:
        'Unknown or undrained processes retain occupied reservations; inspect owned processes, then explicitly restart an idle coordinator. Writer recovery uses semantic change recover and never replays source writes',
      enforcement:
        'Admission counts and sampled registered-provider-leader RSS; no OS hard memory limit or detached-descendant containment claim',
    });
  });
  return yield* execute.pipe(
    Effect.catch(error => {
      if (Schema.is(SemanticHostProfileFault)(error))
        return Effect.succeed(result(error.reason, actions[error.reason]));
      if (Schema.is(SemanticCompatibilityFault)(error))
        return Effect.succeed(result('incompatible', actions.incompatible, {component: error.component}));
      return Effect.succeed(
        result(
          'unavailable',
          'Check host filesystem permissions, pinned artifacts and bounded process availability; existing state is retained',
        ),
      );
    }),
  );
});
