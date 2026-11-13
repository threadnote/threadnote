import {Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri} from '@threadnote/semantic/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {semanticAgentQueryHost, type SemanticAgentQueryHost} from './agent_queries.js';
import {
  SemanticReadinessRequest,
  SemanticReadinessResult,
  type SemanticEndpointReadiness,
} from './agent_query_protocol.js';
import {readSemanticHostProfile, semanticHostProfileName} from './host_profile.js';
import {SemanticLanguage} from './provider.js';
import {LspFault} from './lsp_transport.js';
import {semanticHostSelection} from './host_catalog.js';

const unavailable = (): SemanticReadinessResult => ({
  version: 1,
  status: 'unavailable',
  reason: 'Readiness requires the current protected profile and standalone coordinator; inspect semantic setup',
});
/** CLI and MCP share host-derived identity; no public request can supply a provider command, witness or job budget. */
export const runSemanticReadinessWith = Effect.fn('semantic.readinessWith')(function* (
  host: Pick<SemanticAgentQueryHost, 'runtimeIdentity' | 'connect'>,
  config: RuntimeConfig,
  input: unknown,
) {
  const parsed = yield* Schema.decodeUnknownEffect(SemanticReadinessRequest, {onExcessProperty: 'error'})(input).pipe(
    Effect.result,
  );
  if (parsed._tag === 'Failure')
    return {
      version: 1,
      status: 'invalid-request',
      reason: 'Provide explicit saved-disk readiness start, status or cancel JSON',
    } satisfies SemanticReadinessResult;
  const request = parsed.success;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(request.callerCwd))
    return {
      version: 1,
      status: 'invalid-request',
      reason: 'callerCwd must be absolute',
    } satisfies SemanticReadinessResult;
  const root = yield* fs.realPath(request.callerCwd);
  const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
  const selected = yield* readSemanticHostProfile(config, worktree);
  const runtimeIdentity = yield* host.runtimeIdentity;
  const principal = EffectString.slice(0, -5)(semanticHostProfileName(config, worktree));
  const scope = {worktree, profile: selected.digest, principal};
  let body: SemanticEndpointReadiness;
  if (request.action === 'start') {
    if (
      !Schema.is(SemanticLanguage)(request.language) ||
      !selected.profile.catalog[semanticHostSelection[request.language].slot]
    )
      return unavailable();
    const projectPath = path.resolve(root, request.project ?? '.');
    const file = EffectString.startsWith('file:')(request.file)
      ? yield* Effect.try({try: () => new URL(request.file), catch: () => LspFault.make({code: 'protocol'})}).pipe(
          Effect.flatMap(url => path.fromFileUrl(url)),
        )
      : path.resolve(projectPath, request.file);
    if (
      !(projectPath === root || EffectString.startsWith(root + path.sep)(projectPath)) ||
      !EffectString.startsWith(projectPath + path.sep)(file) ||
      EffectString.split(path.sep)(file).includes('.git') ||
      (yield* fs.realPath(projectPath)) !== projectPath ||
      (yield* fs.realPath(file)) !== file ||
      (yield* fs.stat(file)).type !== 'File'
    )
      return {
        version: 1,
        status: 'invalid-request',
        reason: 'Source must remain in the selected canonical worktree',
      } satisfies SemanticReadinessResult;
    body = {
      ...scope,
      action: 'start',
      project: canonicalFileUri((yield* path.toFileUrl(projectPath)).href),
      uri: canonicalFileUri((yield* path.toFileUrl(file)).href),
      language: request.language,
      ...(request.environment === undefined ? {} : {environment: request.environment}),
    };
  } else body = {...scope, action: request.action, job: request.job};
  const endpoint = yield* host.connect({
    enabled: true,
    dataHome: selected.home,
    worktree,
    runtimeIdentity,
    ...selected.profile.catalog,
  });
  const result = yield* Schema.decodeUnknownEffect(SemanticReadinessResult)(
    yield* endpoint.request({operation: 'agent-readiness', request: body}),
  );
  const closing = yield* readSemanticHostProfile(config, worktree).pipe(Effect.result);
  if (closing._tag === 'Failure' || closing.success.digest !== selected.digest) {
    if (request.action === 'start' && result.status === 'ok' && result.job)
      yield* endpoint
        .request({operation: 'agent-readiness', request: {...scope, action: 'cancel', job: result.job}})
        .pipe(Effect.ignore);
    return {
      version: 1,
      status: 'stale',
      reason: 'Host profile changed during readiness dispatch',
    } satisfies SemanticReadinessResult;
  }
  return result;
});
export const runSemanticReadiness = (config: RuntimeConfig, input: unknown) =>
  runSemanticReadinessWith(semanticAgentQueryHost, config, input).pipe(Effect.orElseSucceed(unavailable));
