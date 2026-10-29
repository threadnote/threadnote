import {Effect, Schema} from 'effect';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {decodeNativeCycleState, nextNativeCycle} from '@threadnote/workflow-automations/cycle';
import {
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  validateNativeAuthoring,
} from '@threadnote/workflow-automations/authoring';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {runWorkflowMemory} from '../workflow_memory/index.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {readNativeWorkflowState} from './store.js';
import {captureNativeCycleSource} from './cycle_git.js';
import {
  AuthoringReferenceSchema,
  AuthoringRootSchema,
  decodeAuthoringArtifact,
  type NativeAuthoringCall,
} from './authoring_artifacts.js';
import {nativeWorkflowError} from './memory.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface NativeCloseoutOwnedArtifact {
  readonly runId: string;
  readonly generation: string;
  readonly bindingId: string;
  readonly artifactKey: string;
  readonly role: string;
  readonly sourceRunId: string;
  readonly uri: string;
  readonly memoryId: string;
  readonly revision: string;
}
const fail = (message: string) => WorkflowAutomationError.make({code: 'invalid-closeout-input', message});
const readSchema = Schema.Struct({
  status: Schema.Literal('ok'),
  canonicalUri: Schema.String,
  memoryId: Schema.String,
  revision: Schema.String,
  state: Schema.Literal('active'),
  verifiedReadback: Schema.Literal(true),
  body: Schema.String,
  artifactKey: Schema.String,
  role: Schema.String,
  sourceRunId: Schema.String,
});
const loadedSchema = Schema.Struct({
  status: Schema.Literal('ok'),
  authoring: Schema.Struct({
    root: AuthoringReferenceSchema,
    kind: Schema.Literals(['plan', 'spec']),
    featureId: Schema.String,
    documentHash: Schema.String,
    intentHash: Schema.String,
    readiness: Schema.Literal('ready'),
    document: Schema.Unknown,
  }),
});
const parse = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => fail('Authoritative authoring readback is missing, inactive or malformed.')),
  );
const base = (runId: string, generation: string, action: string) => ({
  protocolVersion: 1,
  executorVersion: 1,
  action,
  runId,
  generation,
});

/** Loads live owned inputs only. It does not publish, retire artifacts, or change workflow state. */
export const loadNativeCloseoutInputs = Effect.fn('workflowAutomation.closeout.loadInputs')(function* <R>(
  config: RuntimeConfig,
  runId: string,
  generation: string,
  call: NativeAuthoringCall<R>,
) {
  yield* call(base(runId, generation, 'inspect'));
  const stored = yield* readNativeWorkflowState(config, runId);
  if (!stored || stored.state.generation !== generation || stored.state.runId !== runId)
    return yield* fail('The current controller run or generation is unavailable.');
  const state = stored.state;
  const runtime = state.cycle;
  if (!runtime) return yield* fail('Closeout requires this controller’s persisted cycle runtime.');
  const cycle = yield* Effect.try({try: () => decodeNativeCycleState(runtime.state), catch: nativeWorkflowError});
  if (nextNativeCycle(cycle).action !== 'complete')
    return yield* fail('The persisted cycle has not completed its delivery gates.');
  const journal = yield* withWorkflowLock(config, state.bindingId, inspectWorkflowJournal(config, state.bindingId));
  const binding = journal.state.binding;
  if (
    binding.bindingId !== state.bindingId ||
    binding.profile !== state.profile ||
    binding.team !== state.team ||
    binding.workflowRunId !== 'native-v1-' + runId ||
    binding.generation !== generation ||
    binding.featureId !== state.featureId ||
    binding.project !== state.project ||
    cycle.plan.featureId !== state.featureId ||
    cycle.plan.project !== state.project
  )
    return yield* fail('Controller cycle and native binding identities differ.');
  const read = (bindingId: string, uri: string) =>
    runWorkflowMemory(config, {protocolVersion: 1, action: 'read', bindingId, uri}).pipe(
      Effect.flatMap(value => parse(readSchema, value)),
      Effect.mapError(nativeWorkflowError),
    );
  const load = Effect.fn('workflowAutomation.closeout.loadAuthoring')(function* (
    pin: typeof cycle.plan.source,
    kind: 'plan' | 'spec',
  ) {
    const response = yield* call({
      ...base(pin.binding.runId, pin.binding.generation, 'authoring'),
      command: 'load',
      uri: pin.root.uri,
      detail: 'document',
    }).pipe(Effect.flatMap(value => parse(loadedSchema, value)));
    const loaded = response.authoring;
    const document = yield* Effect.try({
      try: () => decodeNativeAuthoringDocument(loaded.document),
      catch: nativeWorkflowError,
    });
    if (
      stableJson(loaded.root) !== stableJson(pin.root) ||
      loaded.kind !== kind ||
      document.kind !== kind ||
      loaded.featureId !== cycle.plan.featureId ||
      document.id !== cycle.plan.featureId ||
      document.project !== cycle.plan.project ||
      loaded.documentHash !== pin.documentHash ||
      nativeAuthoringDigest(document) !== pin.documentHash
    )
      return yield* fail('The authoring document or ready root differs from its exact cycle pin.');
    const original = yield* readNativeWorkflowState(config, pin.binding.runId);
    if (
      !original ||
      original.state.bindingId !== pin.binding.bindingId ||
      original.state.generation !== pin.binding.generation ||
      original.state.profile !== pin.binding.profile ||
      original.state.team !== pin.binding.team ||
      original.state.featureId !== cycle.plan.featureId ||
      original.state.project !== cycle.plan.project
    )
      return yield* fail('The original authoring run differs from its pinned native binding.');
    const originalJournal = yield* withWorkflowLock(
      config,
      pin.binding.bindingId,
      inspectWorkflowJournal(config, pin.binding.bindingId),
    );
    const originalBinding = originalJournal.state.binding;
    if (
      originalBinding.bindingId !== pin.binding.bindingId ||
      originalBinding.profile !== pin.binding.profile ||
      originalBinding.team !== pin.binding.team ||
      originalBinding.workflowRunId !== 'native-v1-' + pin.binding.runId ||
      originalBinding.generation !== pin.binding.generation ||
      originalBinding.featureId !== cycle.plan.featureId ||
      originalBinding.project !== cycle.plan.project ||
      originalBinding.repo !== binding.repo
    )
      return yield* fail('Original authoring journal authority differs from this controller.');
    const rootArtifact = yield* read(pin.binding.bindingId, pin.root.uri);
    if (
      rootArtifact.memoryId !== pin.root.memoryId ||
      rootArtifact.revision !== pin.root.revision ||
      rootArtifact.canonicalUri !== pin.root.uri
    )
      return yield* fail('The pinned authoring root changed during closeout admission.');
    const root = yield* Effect.try({
      try: () => decodeAuthoringArtifact(rootArtifact.body, AuthoringRootSchema),
      catch: nativeWorkflowError,
    });
    if (
      root.kind !== kind ||
      root.readiness !== 'ready' ||
      root.featureId !== cycle.plan.featureId ||
      stableJson(root.binding) !== stableJson(pin.binding) ||
      root.documentHash !== pin.documentHash ||
      root.intentHash !== loaded.intentHash
    )
      return yield* fail('Stored authoring root readiness or binding differs from the loaded document.');
    const validation = yield* Effect.try({
      try: () => validateNativeAuthoring(document, {ready: true, confirmation: root.confirmation, review: root.review}),
      catch: nativeWorkflowError,
    });
    if (!validation.ready) return yield* fail('Stored authoring approval or readiness evidence is incomplete.');
    return {document, root, journal: originalJournal.state, pin};
  });
  const loadedPlan = yield* load(cycle.plan.source, 'plan');
  const plan = loadedPlan.document;
  if (plan.kind !== 'plan') return yield* fail('The pinned authoring document is not a plan.');
  const loadedSpec = plan.spec ? yield* load(plan.spec, 'spec') : undefined;
  if (loadedSpec && plan.spec) {
    const spec = loadedSpec.document;
    if (
      spec.kind !== 'spec' ||
      nativeSpecIntentDigest(spec) !== plan.spec.intentHash ||
      loadedSpec.root.intentHash !== plan.spec.intentHash ||
      stableJson(spec.requirements) !== stableJson(plan.requirements) ||
      stableJson(spec.requirements) !== stableJson(plan.spec.requirements) ||
      stableJson(spec.scenarios) !== stableJson(plan.spec.scenarios)
    )
      return yield* fail('The linked specification differs from the approved requirements or scenarios.');
  }
  const owned: NativeCloseoutOwnedArtifact[] = [];
  const seen = new Set<string>();
  for (const original of [loadedPlan, ...(loadedSpec ? [loadedSpec] : [])]) {
    for (const artifact of EffectRecord.values(original.journal.artifacts)) {
      if (
        artifact.state !== 'active' ||
        artifact.sourceRunId !== original.pin.binding.runId ||
        !Effect2.pipe(artifact.role, EffectString.startsWith('authoring-'))
      )
        continue;
      const key = original.pin.binding.bindingId + '\n' + artifact.canonicalUri;
      if (seen.has(key)) continue;
      if (owned.length >= 4096) return yield* fail('Closeout owned authoring inventory exceeds its bounded limit.');
      const current = yield* read(original.pin.binding.bindingId, artifact.canonicalUri);
      if (
        current.canonicalUri !== artifact.canonicalUri ||
        current.memoryId !== artifact.memoryId ||
        current.revision !== artifact.revision ||
        current.role !== artifact.role ||
        current.artifactKey !== artifact.artifactKey ||
        current.sourceRunId !== artifact.sourceRunId
      )
        return yield* fail('An owned authoring artifact changed before closeout admission.');
      owned.push({
        runId: original.pin.binding.runId,
        generation: original.pin.binding.generation,
        bindingId: original.pin.binding.bindingId,
        artifactKey: artifact.artifactKey,
        role: artifact.role,
        sourceRunId: artifact.sourceRunId,
        uri: artifact.canonicalUri,
        memoryId: artifact.memoryId,
        revision: artifact.revision,
      });
      seen.add(key);
    }
  }
  const captured = yield* captureNativeCycleSource(binding.repo, 'HEAD');
  if (captured.tree !== captured.baseTree) return yield* fail('Closeout requires a clean current source tree.');
  return {
    state,
    binding,
    cycle,
    source: {repo: captured.repo, head: captured.head, tree: captured.tree},
    plan,
    planRoot: loadedPlan.pin.root,
    ...(loadedSpec ? {spec: loadedSpec.document} : {}),
    owned,
  };
});
export type NativeCloseoutInputs = Effect.Success<ReturnType<typeof loadNativeCloseoutInputs>>;
