import {Array as EffectArray, Effect, FileSystem, Path, Schema, Struct, pipe} from 'effect';
import * as EffectRecord from 'effect/Record';
import {SystemInfo} from '@threadnote/platform/system';
import {runBinaryCommandEffect, runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {uriSegment} from '@threadnote/workspace/manifest';
import {workflowTitleSlug} from '@threadnote/workflow-automations/naming';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {decodeNativeAuthoringDocument, type NativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {gitValue} from '../utils.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {inspectNativeSourcePaths, nativeAuthoringSourceOrigins} from './authoring.js';
import {runNativeTaskAuthoring, encodeNativeAuthoringTaskRef} from './task_authoring.js';
import {readNativeTaskView} from './task.js';
import {readPortablePlanPayload} from './portable_plan.js';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskInstalledTarget} from './task_admission.js';
import {AuthoringRootSchema, decodeAuthoringArtifact} from './authoring_artifacts.js';
import * as EffectString from 'effect/String';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const resultSchema = Schema.Struct({authoringRef: Schema.String, status: Schema.String});
const admittedSchema = Schema.Struct({status: Schema.String, runId: Schema.String});
export interface SharedPlanStartInput {
  readonly callerCwd: string;
  readonly sharedPlanRef: string;
  readonly installationTarget: string;
  readonly graphProject?: string;
  readonly delivery: 'local' | 'commit' | 'pr';
  readonly bindings: Readonly<Record<string, {readonly branch: string; readonly baseBranch: string}>>;
  readonly userResponse: string;
  readonly review: {readonly outcome: 'accepted'; readonly blockingIssueCount: 0};
}

const business = (document: NativeAuthoringDocument) =>
  document.kind === 'spec'
    ? Struct.omit(document, ['format', 'schemaVersion', 'id', 'project', 'source', 'sourceFreeReason', 'kind'])
    : Struct.omit(document, [
        'format',
        'schemaVersion',
        'id',
        'project',
        'source',
        'sourceFreeReason',
        'kind',
        'spec',
        'compactOrigin',
      ]);

/** The source fence precedes all local evidence, authoring and cycle writes. */
export const runNativeSharedPlanStart = Effect.fn('workflowAutomation.runNativeSharedPlanStart')(function* (
  config: RuntimeConfig,
  request: SharedPlanStartInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(request.callerCwd))
    return yield* fail('wrong-checkout', 'Use an absolute recipient checkout path.');
  const cwd = yield* fs
    .realPath(request.callerCwd)
    .pipe(Effect.mapError(() => fail('wrong-checkout', 'The recipient checkout is unavailable.')));
  const reported = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!reported) return yield* fail('wrong-checkout', 'The recipient path must be inside a Git checkout.');
  const checkout = yield* fs.realPath(reported);
  const project = yield* Effect.try({
    try: () => workflowTitleSlug(path.basename(checkout)),
    catch: () => fail('wrong-project', 'The recipient checkout has no stable project name.'),
  });
  const shared = yield* readPortablePlanPayload(config, request.sharedPlanRef, project);
  const {plan, spec, payload} = shared;
  if (plan.kind !== 'plan') return yield* fail('portable-plan-malformed', 'The shared root is not a plan.');
  const system = yield* SystemInfo;
  const inCheckout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
  const checkSource = (document: NativeAuthoringDocument) =>
    Effect.gen(function* () {
      if (!document.source)
        return yield* fail(
          'source-drift',
          'The shared document has no pinned source; review a current local revision.',
        );
      const observed = yield* inCheckout(
        inspectNativeSourcePaths(
          checkout,
          EffectArray.map(document.source.files, file => file.path),
          nativeAuthoringSourceOrigins(document),
        ),
      ).pipe(
        Effect.mapError(() =>
          fail(
            'source-drift',
            'The recipient source cannot be verified against the shared snapshot. Commit and review a matching local revision.',
          ),
        ),
      );
      if (stableJson(observed) === stableJson(document.source)) return;
      const drift = () =>
        fail(
          'source-drift',
          'The recipient source differs from the shared snapshot. Update and review the plan locally.',
        );
      if (observed.head !== document.source.head || observed.files.length !== document.source.files.length)
        return yield* drift();
      for (const [index, pinned] of document.source.files.entries()) {
        const current = observed.files[index];
        if (current?.path !== pinned.path) return yield* drift();
        if (current.sha256 === pinned.sha256) continue;
        // A Git checkout may turn LF source bytes into CRLF. Admit that one
        // representation change only when the exact commit and clean worktree
        // independently prove the pinned source.
        const actual = yield* fs.realPath(path.join(checkout, pinned.path)).pipe(Effect.mapError(drift));
        if (!pipe(actual, EffectString.startsWith(checkout + path.sep))) return yield* drift();
        const stat = yield* fs.stat(actual).pipe(Effect.mapError(drift));
        if (stat.type !== 'File' || Number(stat.size) > 1_000_000) return yield* drift();
        const bytes = yield* fs.readFile(actual).pipe(Effect.mapError(drift));
        if (
          bytes.byteLength > 1_000_000 ||
          sha256HexSync(bytes) !== current.sha256 ||
          sha256HexSync(bytes.filter((byte, offset) => byte !== 13 || bytes[offset + 1] !== 10)) !== pinned.sha256
        )
          return yield* drift();
        const blob = yield* runBinaryCommandEffect(
          'git',
          [
            '--no-optional-locks',
            '--no-replace-objects',
            '-C',
            checkout,
            'show',
            `${observed.head}:${pinned.path}`,
            '--',
          ],
          {allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 1_000_001, sensitiveOutput: true},
        ).pipe(Effect.mapError(drift));
        if (blob.exitCode !== 0 || sha256HexSync(blob.stdout) !== pinned.sha256) return yield* drift();
        const clean = yield* runCommandEffect(
          'git',
          [
            '--no-optional-locks',
            '-C',
            checkout,
            'diff',
            '--no-ext-diff',
            '--quiet',
            observed.head,
            '--',
            `:(literal)${pinned.path}`,
          ],
          {allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 4096, sensitiveOutput: true},
        ).pipe(Effect.mapError(drift));
        if (clean.exitCode !== 0) return yield* drift();
      }
    });
  yield* checkSource(plan);
  if (spec) yield* checkSource(spec);
  yield* readNativeTaskInstalledTarget(config, request.installationTarget, checkout);
  const mark = `Shared plan reference: ${request.sharedPlanRef}`;
  const runId = 'task-' + pipe(sha256HexSync(`${project}\n${plan.id}`), EffectString.slice(0, 48));
  const existingRun = yield* readNativeWorkflowState(config, runId);
  if (existingRun) {
    const currentRoot = EffectArray.findFirst(
      [...existingRun.state.operations].reverse(),
      operation =>
        operation.status === 'verified' &&
        operation.artifact !== undefined &&
        (operation.intent.artifactKey === 'author-root-plan' || operation.intent.artifactKey === 'author-root-spec'),
    );
    if (currentRoot._tag === 'None' || !currentRoot.value.artifact)
      return yield* fail('portable-plan-conflict', 'An existing recipient run cannot prove its pinned shared plan.');
    const operation = currentRoot.value;
    const artifact = operation.artifact;
    if (!artifact) return yield* fail('portable-plan-conflict', 'The recipient root is unavailable.');
    const root = decodeAuthoringArtifact(artifact.body, AuthoringRootSchema);
    const read = yield* runNativeTaskAuthoring(config, {
      callerCwd: checkout,
      command: 'read',
      detail: 'document',
      authoringRef: encodeNativeAuthoringTaskRef({
        version: 1,
        kind: root.kind,
        runId,
        generationHash: sha256HexSync(existingRun.state.generation),
        operationId: operation.intent.operationId,
        documentHash: root.documentHash,
        stateRevision: existingRun.revision,
      }),
    }).pipe(
      Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}),
      Effect.mapError(() =>
        fail('portable-plan-conflict', 'The current recipient plan cannot prove its shared origin.'),
      ),
    );
    const readDocument = yield* Schema.decodeUnknownEffect(Schema.Struct({document: Schema.Unknown}))(read).pipe(
      Effect.mapError(() => fail('portable-plan-conflict', 'The current recipient plan has no readable origin.')),
    );
    const currentDocument = yield* Effect.try({
      try: () => decodeNativeAuthoringDocument(readDocument.document),
      catch: () => fail('portable-plan-conflict', 'The current recipient plan has no readable origin.'),
    });
    if (!pipe(currentDocument.context.note, EffectString.endsWith(mark)))
      return yield* fail('portable-plan-conflict', 'The existing recipient run pins a different shared plan.');
  }
  const bindings = request.bindings;
  if (
    EffectRecord.keys(bindings).length !== plan.phases.length ||
    EffectArray.some(plan.phases, phase => !bindings[phase.id])
  )
    return yield* fail('invalid-bindings', 'Provide one local branch and base branch for each shared plan phase.');
  const localEvidence = new Map<string, {uri: string; memoryId: string; revision: string}>();
  const store = yield* ResourceStore;
  const location = {account: config.account, home: config.agentContextHome, user: config.user};
  const evidenceDirectory = `threadnote://user/${uriSegment(config.user)}/memories/durable/projects/${project}`;
  const preparedEvidence = EffectArray.map(payload.evidence, (item, index) => {
    const memoryId = `tn_${pipe(sha256HexSync(`${payload.provenance.root.revision}\n${index}`), EffectString.slice(0, 32))}`;
    const shortRevision = pipe(payload.provenance.root.revision, EffectString.slice(0, 16));
    const uri = `${evidenceDirectory}/portable-evidence-${shortRevision}-${index}.md`;
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project,
        topic: `portable-evidence-${shortRevision}-${index}`,
        memoryId,
        sourceAgentClient: 'threadnote-portable-plan',
        timestamp: '1970-01-01T00:00:00.000Z',
        visibility: 'external',
        authority: 'external',
        trust: 'untrusted',
      },
      item.body,
    );
    return {sourceUri: item.reference.uri, uri, memoryId, revision: sha256HexSync(content), content};
  });
  // All security and checkout admissions above are pure reads. Durable copies
  // below are deterministic, content-addressed and safe to replay.
  for (const directory of [
    `threadnote://user/${uriSegment(config.user)}/memories/durable`,
    `threadnote://user/${uriSegment(config.user)}/memories/durable/projects`,
    evidenceDirectory,
  ])
    yield* store.makeDirectory(location, directory);
  for (const item of preparedEvidence) {
    const existing = yield* store.read(location, item.uri).pipe(Effect.option);
    if (existing._tag === 'Some' && existing.value !== item.content)
      return yield* fail('portable-plan-conflict', 'A recipient evidence copy differs from the pinned shared plan.');
    if (existing._tag === 'None') yield* store.write(location, item.uri, item.content, {mode: 'create'});
    localEvidence.set(item.sourceUri, {uri: item.uri, memoryId: item.memoryId, revision: item.revision});
  }
  const recipientContext = (document: NativeAuthoringDocument) => {
    const evidenceRefs = EffectArray.map(document.context.evidenceRefs, reference => {
      const local = localEvidence.get(reference.uri);
      if (!local) throw fail('portable-plan-missing', 'The recipient evidence mapping is incomplete.');
      return local;
    });
    return {...document.context, evidenceRefs, note: `${document.context.note}\n${mark}`};
  };
  const recipientSpec = spec ? {...spec, context: recipientContext(spec)} : undefined;
  const recipientPlan = {...plan, context: recipientContext(plan)};
  return yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({directory: config.agentContextHome, prefix: 'portable-start-'}),
    stage =>
      Effect.gen(function* () {
        const writeBusiness = (name: string, document: NativeAuthoringDocument) =>
          Effect.gen(function* () {
            const file = path.join(stage, name);
            yield* fs.writeFileString(file, stableJson(business(document)));
            return file;
          });
        const common = {
          callerCwd: checkout,
          featureName: plan.id,
          installationTarget: request.installationTarget,
          ...(request.graphProject === undefined ? {} : {graphProject: request.graphProject}),
        };
        let specRef: string | undefined;
        if (recipientSpec) {
          const file = yield* writeBusiness('spec.json', recipientSpec);
          const draftRaw = yield* runNativeTaskAuthoring(config, {
            ...common,
            command: 'start',
            kind: 'spec',
            contentFile: file,
          });
          const draft = yield* Schema.decodeUnknownEffect(resultSchema)(draftRaw);
          const readyRaw = yield* runNativeTaskAuthoring(config, {
            callerCwd: checkout,
            command: 'decide',
            authoringRef: draft.authoringRef,
            userDecision: 'approve',
            userResponse: request.userResponse,
            review: request.review,
          });
          const ready = yield* Schema.decodeUnknownEffect(resultSchema)(readyRaw);
          if (ready.status !== 'ready')
            return yield* fail('approval-required', 'The recipient specification did not become ready.');
          specRef = ready.authoringRef;
        }
        const planFile = yield* writeBusiness('plan.json', recipientPlan);
        const draftRaw = yield* runNativeTaskAuthoring(config, {
          ...common,
          command: 'start',
          kind: 'plan',
          contentFile: planFile,
          ...(specRef === undefined ? {} : {specRef}),
        });
        const draft = yield* Schema.decodeUnknownEffect(resultSchema)(draftRaw);
        const readyRaw = yield* runNativeTaskAuthoring(config, {
          callerCwd: checkout,
          command: 'decide',
          authoringRef: draft.authoringRef,
          userDecision: 'approve',
          userResponse: request.userResponse,
          review: request.review,
        });
        const ready = yield* Schema.decodeUnknownEffect(resultSchema)(readyRaw);
        if (ready.status !== 'ready')
          return yield* fail('approval-required', 'The recipient plan did not become ready.');
        const admitted = yield* Schema.decodeUnknownEffect(admittedSchema)(
          yield* runNativeTaskAuthoring(config, {
            callerCwd: checkout,
            command: 'admit',
            authoringRef: ready.authoringRef,
            delivery: request.delivery,
            bindings,
          }),
        );
        if (admitted.status !== 'admitted')
          return yield* fail('portable-plan-conflict', 'The recipient plan was not admitted.');
        const view = yield* readNativeTaskView(config, {runId: admitted.runId, callerCwd: checkout, detail: 'packet'});
        return {status: 'admitted' as const, taskRef: admitted.runId, sharedPlanRef: request.sharedPlanRef, view};
      }),
    stage => fs.remove(stage, {recursive: true, force: true}),
  );
});
