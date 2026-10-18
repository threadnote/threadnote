import {Effect, Result, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  topicExpansionDigest,
  validateTopicDependencyExpansionInput,
  type TopicDependencyExpansionPreview,
} from '@threadnote/memory/topic-maintenance-expansion';
import type {
  ManagerTopicExpansionInspection,
  ManagerTopicExpansionPreview,
  ManagerTopicExpansionSelection,
} from '@threadnote/manager/attention/topic-expansion-contracts';
import {
  inspectTopicDependencyExpansion,
  previewTopicDependencyExpansion,
  applyTopicDependencyExpansion,
  restartTopicDependencyExpansion,
  loadTopicDependencyExpansionPreview,
  inspectTopicDependencyExpansionRecovery,
} from '../memory/maintenance/topic_expansion.js';
import {managerAttentionProjectRoot} from './attention.js';

export class ManagerTopicExpansionError extends Schema.TaggedError<ManagerTopicExpansionError>()(
  'ManagerTopicExpansionError',
  {
    message: Schema.String,
    recovery: Schema.optionalKey(
      Schema.Struct({
        action: Schema.Literal('restart'),
        targetUri: Schema.String,
        project: Schema.String,
        revision: Schema.String,
        approvalDigest: Schema.String,
      }),
    ),
  },
) {}
const fail = () =>
  ManagerTopicExpansionError.make({
    message:
      'The selected topic or scoped source evidence is unavailable, incomplete or changed, or required evidence cannot be retained. Inspect the scope again; prepare its project graph manually if needed.',
  });
const HASH = /^[a-f0-9]{64}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const privateUri = (uri: unknown): uri is string =>
  typeof uri === 'string' &&
  uri.length <= 4096 &&
  /^threadnote:\/\/user\/[^/]+\/memories\/durable\/projects\//u.test(uri) &&
  !uri.includes('/shared/');
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const publicSelection = ({
  root: _root,
  project: _project,
  ...selection
}: TopicDependencyExpansionPreview['input']): ManagerTopicExpansionSelection => selection;
const coverage = (preview: TopicDependencyExpansionPreview) =>
  preview.proof.reads.map(read => ({
    seedId: read.seedId,
    status: 'exhaustive' as const,
    visitedNodes: read.coverage.visitedNodes,
    inspectedEdges: read.coverage.inspectedEdges,
  }));

export interface TopicExpansionSurfaceInput {
  readonly action: 'inspect' | 'discover' | 'preview' | 'apply' | 'restart';
  readonly uri: string;
  readonly project: string;
  readonly callerCwd: string;
  readonly selection?: unknown;
  readonly revision?: string;
  readonly approvalDigest?: string;
  readonly approved?: boolean;
}

/** Shared transport adapter: the domain owns graph admission, proof validation and all writes. */
export const runTopicExpansionSurface = Effect.fn('topicExpansion.surface')(function* (
  config: RuntimeConfig,
  input: TopicExpansionSurfaceInput,
) {
  const initial = yield* inspectTopicDependencyExpansion(config, {
    uri: input.uri,
    callerCwd: input.callerCwd,
    project: input.project,
  });
  if (initial.targetUri !== input.uri || initial.project !== input.project) return yield* fail();
  if (input.action === 'inspect') {
    return {
      status: 'ready' as const,
      sourceKind: 'code' as const,
      targetUri: initial.targetUri,
      project: initial.project,
      configDigest: initial.configDigest,
      body: initial.body,
      warning: initial.warning,
      currentScope: initial.currentScope.map(item => ({
        ...item,
        ...(initial.seeds.find(seed => seed.citationId === item.citationId)
          ? {path: initial.seeds.find(seed => seed.citationId === item.citationId)!.path}
          : {}),
      })),
      seeds: initial.seeds,
    } satisfies ManagerTopicExpansionInspection;
  }
  if (
    !input.selection ||
    typeof input.selection !== 'object' ||
    Array.isArray(input.selection) ||
    Object.hasOwn(input.selection, 'root') ||
    Object.hasOwn(input.selection, 'project')
  )
    return yield* fail();
  const selectedFields = input.selection;
  const selected = yield* Effect.try({
    try: () => validateTopicDependencyExpansionInput({...selectedFields, root: initial.root, project: input.project}),
    catch: fail,
  });
  if (input.action === 'discover') {
    const inspected = yield* inspectTopicDependencyExpansion(config, {
      uri: input.uri,
      callerCwd: input.callerCwd,
      project: input.project,
      input: selected,
    });
    return {
      status: 'ready' as const,
      sourceKind: 'code' as const,
      targetUri: inspected.targetUri,
      project: inspected.project,
      configDigest: inspected.configDigest,
      body: inspected.body,
      warning: inspected.warning,
      currentScope: inspected.currentScope,
      seeds: inspected.seeds,
      choices: inspected.choices,
      coverage: inspected.coverage?.map(read => ({
        seedId: read.seedId,
        status: read.status,
        visitedNodes: read.visitedNodes,
        inspectedEdges: read.inspectedEdges,
      })),
    } satisfies ManagerTopicExpansionInspection;
  }
  if (
    (input.action === 'apply' || input.action === 'restart') &&
    (input.approved !== true || !HASH.test(input.revision ?? '') || !HASH.test(input.approvalDigest ?? ''))
  )
    return yield* fail();
  let preview: TopicDependencyExpansionPreview | undefined;
  if (input.action === 'apply' || input.action === 'restart') {
    const saved = yield* loadTopicDependencyExpansionPreview(config, {
      revision: input.revision!,
      approvalDigest: input.approvalDigest!,
    });
    if (saved) {
      if (
        saved.targetUri !== input.uri ||
        saved.callerCwd !== input.callerCwd ||
        saved.input.project !== input.project ||
        saved.revision !== input.revision ||
        saved.approvalDigest !== input.approvalDigest ||
        topicExpansionDigest(saved.input) !== topicExpansionDigest(selected)
      )
        return yield* fail();
      preview = saved;
    }
  }
  if (input.action === 'restart') {
    if (!preview) return yield* fail();
    preview = (yield* restartTopicDependencyExpansion(config, {
      preview,
      revision: input.revision!,
      approvalDigest: input.approvalDigest!,
      approved: true,
    })).preview;
  } else
    preview ??= (yield* previewTopicDependencyExpansion(config, {
      uri: input.uri,
      callerCwd: input.callerCwd,
      input: selected,
    })).preview;
  if (input.action === 'apply') {
    if (preview.revision !== input.revision || preview.approvalDigest !== input.approvalDigest) return yield* fail();
    const applied = yield* applyTopicDependencyExpansion(config, {
      preview,
      revision: input.revision,
      approvalDigest: input.approvalDigest,
      approved: true,
    }).pipe(Effect.result);
    if (Result.isFailure(applied)) {
      const recovery = yield* inspectTopicDependencyExpansionRecovery(config, {
        revision: preview.revision,
        approvalDigest: preview.approvalDigest,
      }).pipe(Effect.result);
      if (Result.isSuccess(recovery) && recovery.success.canRestart)
        return yield* ManagerTopicExpansionError.make({
          message:
            'The previous dependency approval expired. Start a fresh review, then approve its full preview separately.',
          recovery: {
            action: 'restart',
            targetUri: input.uri,
            project: input.project,
            revision: preview.revision,
            approvalDigest: preview.approvalDigest,
          },
        });
      return yield* Effect.fail(applied.failure);
    }
    return applied.success;
  }
  return {
    status: 'preview' as const,
    ...(preview.operation ? {operation: preview.operation} : {}),
    targetUri: preview.targetUri,
    project: input.project,
    selection: publicSelection(preview.input),
    revision: preview.revision,
    approvalDigest: preview.approvalDigest,
    content: preview.content,
    body: initial.body,
    additions: preview.additions.map(item => ({
      kind: item.kind,
      ref: item.ref,
      path: item.citation.path,
      citationId: item.citation.id,
    })),
    omissions: preview.omissions,
    metadataDiff: preview.metadataDiff,
    coverage: coverage(preview),
  } satisfies ManagerTopicExpansionPreview;
});

/** Router authentication precedes this project-bound adapter; checkout paths never enter its protocol. */
export const handleManagerTopicExpansion = Effect.fn('managerTopicExpansion.handle')(function* (request: {
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
}) {
  if (
    request.url.pathname !== '/api/attention/topic-expansion' ||
    (request.method !== 'GET' && request.method !== 'POST')
  )
    return undefined;
  const body = request.method === 'POST' ? yield* request.body : undefined;
  const uri = body?.uri ?? request.url.searchParams.get('uri');
  const project = body?.project ?? request.url.searchParams.get('project');
  const action = body?.action ?? 'inspect';
  const invalid = () => ({
    status: 400,
    body: {error: 'Select an exact private code topic, project and bounded dependency selection.'},
  });
  if (
    !privateUri(uri) ||
    typeof project !== 'string' ||
    !PROJECT.test(project) ||
    !['inspect', 'discover', 'preview', 'apply', 'restart'].includes(action as string)
  )
    return invalid();
  if (request.method === 'GET' && [...request.url.searchParams.keys()].some(key => key !== 'uri' && key !== 'project'))
    return invalid();
  if (
    body &&
    (!exactKeys(body, [
      'action',
      'uri',
      'project',
      ...(action === 'inspect' ? [] : ['selection']),
      ...(action === 'apply' || action === 'restart' ? ['revision', 'approvalDigest', 'approved'] : []),
    ]) ||
      new TextEncoder().encode(JSON.stringify(body)).byteLength > 32 * 1024)
  )
    return invalid();
  if (
    (action === 'apply' || action === 'restart') &&
    (body?.approved !== true || !HASH.test(body?.revision as string) || !HASH.test(body?.approvalDigest as string))
  )
    return invalid();
  const root = yield* managerAttentionProjectRoot(request.config, project);
  if (root.state !== 'available')
    return {
      status: 409,
      body: {
        error:
          'The selected project checkout is unavailable. Open its graph settings and prepare the project before continuing.',
      },
    };
  const result = yield* runTopicExpansionSurface(request.config, {
    action: action as TopicExpansionSurfaceInput['action'],
    uri,
    project,
    callerCwd: root.cwd,
    selection: body?.selection,
    revision: body?.revision as string | undefined,
    approvalDigest: body?.approvalDigest as string | undefined,
    approved: body?.approved === true,
  }).pipe(Effect.result);
  return Result.isSuccess(result)
    ? {status: 200, body: result.success}
    : {status: 409, body: topicExpansionSurfaceFailure(result.failure)};
});

/** Safe shared error projection; domain/source errors never enter transport responses. */
export function topicExpansionSurfaceFailure(error: unknown) {
  return Schema.is(ManagerTopicExpansionError)(error) && error.recovery
    ? {error: error.message, recovery: error.recovery}
    : {error: fail().message};
}
