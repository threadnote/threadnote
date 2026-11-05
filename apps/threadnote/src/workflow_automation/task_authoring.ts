import {
  Array as A,
  Effect,
  FileSystem,
  Option as O,
  Path,
  Predicate,
  Schema,
  Struct,
  String as S,
  Record,
} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  NativeAuthoringSpecDocumentSchema,
  NativeAuthoringPlanDocumentSchema,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  validateNativeAuthoring,
  type NativeAuthoringDocument,
} from '@threadnote/workflow-automations/authoring';
import {readNativeWorkflowState} from './store.js';
import {runWorkflowAutomation} from './index.js';
import {inspectNativeSourcePaths} from './authoring.js';
import {readNativeTaskInstalledTarget} from './task_actions.js';
import {AuthoringRootSchema, decodeAuthoringArtifact} from './authoring_artifacts.js';
import {resolveWorkflowBinding} from '../workflow_memory/profile.js';
import {makeWorkflowGraphAdapter} from './graph.js';
import {workflowTitleSlug} from '@threadnote/workflow-automations/naming';
import {gitValue} from '../utils.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {nativeWorkflowError} from './memory.js';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const kind = Schema.Literals(['spec', 'plan']);
const metadata = ['format', 'schemaVersion', 'id', 'project', 'source', 'sourceFreeReason'] as const;
const specContent = Schema.Struct(Struct.omit(NativeAuthoringSpecDocumentSchema.fields, [...metadata, 'kind']));
const planFields = Struct.omit(NativeAuthoringPlanDocumentSchema.fields, [
  ...metadata,
  'kind',
  'spec',
  'compactOrigin',
]);
const architecture = (fields: typeof planFields.current.fields) =>
  Schema.Struct({...fields, diagram: Schema.optionalKey(fields.diagram)});
const planContent = Schema.Struct({
  ...planFields,
  requirements: Schema.optionalKey(planFields.requirements),
  current: architecture(planFields.current.fields),
  target: architecture(planFields.target.fields),
});
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const refSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind,
  runId: id,
  generationHash: digest,
  operationId: id,
  documentHash: digest,
  stateRevision: digest,
});
const jobRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind,
  runId: id,
  generationHash: digest,
  jobId: id,
  documentHash: digest,
});
type Ref = typeof refSchema.Type;
export const encodeNativeAuthoringTaskRef = (ref: Ref) =>
  'authorref-v1.' + S.replaceAll('/', '_')(S.replaceAll('+', '-')(S.replace(/=+$/u, '')(btoa(stableJson(ref)))));
export const decodeNativeAuthoringTaskRef = (ref: string) =>
  Effect.try({
    try: () => {
      if (!S.startsWith('authorref-v1.')(ref))
        throw fail('stale-authoring-ref', 'Read the current authoring continuation.');
      return JSON.parse(atob(S.replaceAll('_', '/')(S.replaceAll('-', '+')(S.slice(13)(ref))))) as unknown;
    },
    catch: () => fail('stale-authoring-ref', 'Read the current authoring continuation.'),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(refSchema, {onExcessProperty: 'error'})),
    Effect.mapError(() => fail('stale-authoring-ref', 'Read the current authoring continuation.')),
  );
const encodeNativeAuthoringJobRef = (ref: typeof jobRefSchema.Type) =>
  'authorjob-v1.' + S.replaceAll('/', '_')(S.replaceAll('+', '-')(S.replace(/=+$/u, '')(btoa(stableJson(ref)))));
const decodeNativeAuthoringJobRef = (ref: string) =>
  Effect.try({
    try: () => {
      if (!S.startsWith('authorjob-v1.')(ref))
        throw fail('job-not-found', 'Read the current authoring job continuation.');
      return JSON.parse(atob(S.replaceAll('_', '/')(S.replaceAll('-', '+')(S.slice(13)(ref))))) as unknown;
    },
    catch: () => fail('job-not-found', 'Read the current authoring job continuation.'),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(jobRefSchema, {onExcessProperty: 'error'})),
    Effect.mapError(() => fail('job-not-found', 'Read the current authoring job continuation.')),
  );
const scope = {callerCwd: text};
const inputSchema = Schema.Union([
  Schema.Struct({
    ...scope,
    command: Schema.Literal('start'),
    featureName: text,
    kind,
    contentFile: text,
    saveMode: Schema.optionalKey(Schema.Literal('background')),
    installationTarget: Schema.optionalKey(text),
    specRef: Schema.optionalKey(text),
  }),
  Schema.Struct({
    ...scope,
    command: Schema.Literal('read'),
    authoringRef: text,
    detail: Schema.optionalKey(Schema.Literals(['summary', 'document'])),
  }),
  Schema.Struct({
    ...scope,
    command: Schema.Literal('save'),
    authoringRef: text,
    contentFile: text,
    saveMode: Schema.optionalKey(Schema.Literal('background')),
  }),
  Schema.Struct({
    ...scope,
    command: Schema.Literal('job'),
    jobRef: text,
    operation: Schema.Literals(['status', 'result', 'cancel', 'resume']),
  }),
  Schema.Struct({
    ...scope,
    command: Schema.Literal('decide'),
    authoringRef: text,
    userDecision: Schema.Literals(['approve', 'reject', 'defer']),
    userResponse: text,
    review: Schema.optionalKey(
      Schema.Struct({
        outcome: Schema.Literals(['accepted', 'changes-requested']),
        blockingIssueCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  }),
  Schema.Struct({
    ...scope,
    command: Schema.Literal('admit'),
    authoringRef: text,
    delivery: Schema.optionalKey(Schema.Literals(['local', 'commit', 'pr'])),
    bindings: Schema.Record(id, Schema.Struct({branch: text, baseBranch: text})),
  }),
]);
export type NativeTaskAuthoringInput = typeof inputSchema.Type;
const object = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(value)) throw fail('invalid-readback', 'The native authoring response is malformed.');
  return value;
};
const unwrap = (value: unknown) => object(object(value).authoring);
const contentOf = (document: NativeAuthoringDocument) =>
  document.kind === 'spec'
    ? Struct.omit(document, [...metadata, 'kind'])
    : Struct.omit(document, [...metadata, 'kind', 'spec', 'compactOrigin']);

/** Business authoring over native receipts. Continuations are projections, not permissions or stored tickets. */
export const runNativeTaskAuthoring = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(inputSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(() =>
        fail(
          'invalid-request',
          'Provide a typed task-authoring action and business content file; omit protocol, source and binding metadata.',
        ),
      ),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(request.callerCwd))
      return yield* fail('wrong-checkout', 'callerCwd must be an absolute checkout.');
    const cwd = yield* fs.realPath(request.callerCwd);
    const reported = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
    if (!reported) return yield* fail('wrong-checkout', 'Use the original Git checkout.');
    const checkout = yield* fs.realPath(reported);
    const system = yield* SystemInfo;
    const inCheckout = <B, E, R>(program: Effect.Effect<B, E, R>) =>
      program.pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
    const supplied =
      request.command === 'start' && request.specRef
        ? yield* decodeNativeAuthoringTaskRef(request.specRef)
        : 'authoringRef' in request
          ? yield* decodeNativeAuthoringTaskRef(request.authoringRef)
          : undefined;
    const suppliedJob = request.command === 'job' ? yield* decodeNativeAuthoringJobRef(request.jobRef) : undefined;
    const project = yield* Effect.try({
      try: () => workflowTitleSlug(path.basename(checkout)),
      catch: nativeWorkflowError,
    });
    const featureId =
      request.command === 'start'
        ? yield* Effect.try({try: () => workflowTitleSlug(request.featureName), catch: nativeWorkflowError})
        : undefined;
    const runId =
      suppliedJob?.runId ?? supplied?.runId ?? 'task-' + S.slice(0, 48)(sha256HexSync(project + '\n' + featureId));
    let stored = yield* readNativeWorkflowState(config, runId);
    if (stored && (stored.state.project !== project || (featureId && stored.state.featureId !== featureId)))
      return yield* fail('binding-drift', 'The authoring task belongs to another feature or checkout namespace.');
    if (!stored && request.command !== 'start')
      return yield* fail('run-not-found', 'The original authoring task is unavailable.');
    if (supplied && (!stored || supplied.generationHash !== sha256HexSync(stored.state.generation)))
      return yield* fail('binding-drift', 'The authoring continuation belongs to another run generation.');
    if (suppliedJob && (!stored || suppliedJob.generationHash !== sha256HexSync(stored.state.generation)))
      return yield* fail('binding-drift', 'The authoring job belongs to another run generation.');
    const call = (command: string, fields: object = {}) => {
      if (!stored) return Effect.fail(fail('run-not-found', 'The original native run is missing.'));
      return inCheckout(
        runWorkflowAutomation(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'authoring',
          runId,
          generation: stored.state.generation,
          command,
          ...fields,
        }),
      ).pipe(Effect.map(unwrap));
    };
    const callJob = (command: 'submit' | 'status' | 'result' | 'cancel' | 'resume', fields: object = {}) => {
      if (!stored) return Effect.fail(fail('run-not-found', 'The original native run is missing.'));
      return inCheckout(
        runWorkflowAutomation(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'job',
          command,
          runId,
          generation: stored.state.generation,
          ...(suppliedJob ? {jobId: suppliedJob.jobId} : {}),
          ...fields,
        }),
      );
    };
    const documentKind = request.command === 'start' ? request.kind : (supplied?.kind ?? suppliedJob?.kind);
    if (!documentKind) return yield* fail('invalid-request', 'Select an authoring document kind.');
    const current = () =>
      Effect.gen(function* () {
        const before = yield* readNativeWorkflowState(config, runId);
        const response = yield* call('current-authoring', {documentKind, detail: 'document'});
        const value = response.currentAuthoring;
        if (!Predicate.isObject(value)) return undefined;
        const document = decodeNativeAuthoringDocument(value.document);
        const after = yield* readNativeWorkflowState(config, runId);
        if (!before || before.revision !== after?.revision)
          return yield* fail('state-conflict', 'Read the authoring document again; the run changed.');
        const operation = O.getOrUndefined(
          A.findFirst(
            [...before.state.operations].reverse(),
            item => item.status === 'verified' && item.intent.artifactKey === 'author-root-' + documentKind,
          ),
        );
        if (!operation?.artifact)
          return yield* fail('invalid-readback', 'The current document lacks its original receipt.');
        const rootBody = operation.artifact.body;
        const root = yield* Effect.try({
          try: () => decodeAuthoringArtifact(rootBody, AuthoringRootSchema),
          catch: nativeWorkflowError,
        });
        return {document, root, operation, stored: before, response: value};
      });
    const referenced =
      supplied && stored
        ? O.getOrUndefined(
            A.findFirst(
              stored.state.operations,
              operation =>
                operation.intent.operationId === supplied.operationId &&
                operation.status === 'verified' &&
                operation.intent.artifactKey === 'author-root-' + supplied.kind,
            ),
          )
        : undefined;
    if (supplied && (!referenced?.artifact || referenced.intent.body !== referenced.artifact.body))
      return yield* fail('stale-authoring-ref', 'The continuation has no exact canonical document receipt.');
    const referencedRoot = referenced?.artifact
      ? decodeAuthoringArtifact(referenced.artifact.body, AuthoringRootSchema)
      : undefined;
    if (supplied && referencedRoot?.documentHash !== supplied.documentHash)
      return yield* fail('stale-authoring-ref', 'The continuation document identity changed.');
    const pendingOriginal = () =>
      Effect.gen(function* () {
        const reservation = stored?.state.authoringSave;
        if (!stored || !reservation || !supplied || !referenced?.artifact || !referencedRoot)
          return yield* fail(
            'pending-operation',
            'Resume the original save using its authoring continuation and unchanged business input.',
          );
        const predecessor = O.getOrUndefined(
          A.findFirst(
            [...stored.state.operations.slice(0, reservation.operationStart)].reverse(),
            operation =>
              operation.status === 'verified' && operation.intent.artifactKey === 'author-root-' + documentKind,
          ),
        );
        if (
          predecessor?.intent.operationId !== referenced.intent.operationId ||
          reservation.rootUri !== referenced.artifact.uri
        )
          return yield* fail('pending-operation', 'This continuation is not the admitted save predecessor.');
        const rootWrite = O.getOrUndefined(
          A.findFirst(
            stored.state.operations.slice(reservation.operationStart),
            operation =>
              operation.intent.role === 'authoring-root' &&
              operation.intent.artifactKey === 'author-root-' + documentKind,
          ),
        );
        let uri = referenced.artifact.uri;
        if (rootWrite) {
          const pendingRoot = yield* Effect.try({
            try: () => decodeAuthoringArtifact(rootWrite.intent.body, AuthoringRootSchema),
            catch: nativeWorkflowError,
          });
          const previous = pendingRoot.previous;
          const history = O.getOrUndefined(
            A.findFirst(
              stored.state.operations.slice(reservation.operationStart),
              operation =>
                operation.status === 'verified' &&
                operation.intent.role === 'authoring-history' &&
                operation.artifact?.uri === previous?.uri &&
                operation.artifact?.memoryId === previous?.memoryId &&
                operation.artifact?.revision === previous?.revision &&
                operation.intent.body === referenced.intent.body &&
                operation.artifact?.body === referenced.intent.body,
            ),
          );
          if (
            !previous ||
            !history?.artifact ||
            pendingRoot.baseRevision !== referenced.artifact.revision ||
            rootWrite.intent.uri !== referenced.artifact.uri
          )
            return yield* fail('pending-operation', 'The admitted root lacks its exact original history and CAS.');
          uri = history.artifact.uri;
        }
        // Only an admitted mutation consumes its original predecessor here. Public reads
        // still use the current-root loader and never present this historical copy as current.
        const loaded = yield* call('load', {uri, detail: 'document'});
        const document = decodeNativeAuthoringDocument(loaded.document);
        if (nativeAuthoringDigest(document) !== supplied.documentHash)
          return yield* fail(
            'invalid-readback',
            'The original save predecessor differs from its canonical continuation.',
          );
        return {document, root: referencedRoot, operation: referenced, stored, response: loaded};
      });
    let existing =
      stored?.state.authoringSave && supplied && (request.command === 'save' || request.command === 'decide')
        ? yield* pendingOriginal()
        : stored
          ? yield* current()
          : undefined;
    const result = (value: NonNullable<typeof existing>, replayed = false, full = false) => ({
      status:
        value.root.readiness === 'ready' && value.root.confirmation?.intentHash === value.root.intentHash
          ? 'ready'
          : 'draft',
      replayed,
      runId,
      kind: documentKind,
      authoringRef: encodeNativeAuthoringTaskRef({
        version: 1,
        kind: documentKind,
        runId,
        generationHash: sha256HexSync(value.stored.state.generation),
        operationId: value.operation.intent.operationId,
        documentHash: nativeAuthoringDigest(value.document),
        stateRevision: value.stored.revision,
      }),
      documentHash: value.root.documentHash,
      intentHash: value.root.intentHash,
      root: value.response.root,
      summary: {title: value.document.title, objective: value.document.objective},
      ...(full ? {document: value.document} : {}),
      actorIdentity: 'caller-asserted; not independently authenticated',
    });
    if (request.command === 'job') {
      if (!suppliedJob) return yield* fail('job-not-found', 'Read the current authoring job continuation.');
      const response = object(yield* callJob(request.operation));
      if (request.operation !== 'result' || response.status !== 'completed')
        return {status: response.status, jobRef: request.jobRef, job: response};
      const completed = yield* current();
      if (!completed || nativeAuthoringDigest(completed.document) !== suppliedJob.documentHash)
        return yield* fail(
          'invalid-readback',
          'The completed authoring job lacks independent exact canonical readback.',
        );
      return {status: 'completed', jobRef: request.jobRef, job: response, authoring: result(completed, false, true)};
    }
    if (request.command === 'read') {
      if (!existing) return yield* fail('authoring-root-missing', 'Save a standard authoring draft first.');
      return result(existing, false, request.detail === 'document');
    }
    const exactCurrent = () =>
      existing &&
      supplied &&
      existing.operation.intent.operationId === supplied.operationId &&
      stored?.revision === supplied.stateRevision;
    if (request.command === 'admit') {
      if (!existing || !supplied || existing.operation.intent.operationId !== supplied.operationId)
        return yield* fail('stale-authoring-ref', 'Read the current approved plan before admission.');
      if (
        existing.document.kind !== 'plan' ||
        existing.root.readiness !== 'ready' ||
        existing.root.confirmation?.intentHash !== existing.root.intentHash ||
        existing.root.confirmation?.decision !== 'approved'
      )
        return yield* fail(
          'approval-required',
          'Collect the actual user response and required independent review for this exact plan.',
        );
      if (stored?.state.cycle) {
        const plan = stored.state.cycle.state.plan;
        const priorBindings = Record.fromEntries(
          A.map(plan.phases, phase => [phase.id, {branch: phase.branch, baseBranch: phase.baseBranch}]),
        );
        if (
          plan.source.root.revision === existing.operation.artifact?.revision &&
          plan.source.documentHash === existing.root.documentHash &&
          plan.delivery === (request.delivery ?? 'local') &&
          stableJson(priorBindings) === stableJson(request.bindings)
        )
          return {status: 'admitted', runId, replayed: true};
        return yield* fail(
          'cycle-conflict',
          'This task already has a different admitted plan; follow its current reconciliation action.',
        );
      }
      if (!exactCurrent())
        return yield* fail('stale-authoring-ref', 'Read the current approved plan before admission.');
      const exported = yield* call('export-dev-cycle', {
        uri: existing.operation.artifact?.uri,
        delivery: request.delivery ?? 'local',
        bindings: request.bindings,
      });
      const latest = yield* readNativeWorkflowState(config, runId);
      if (!latest) return yield* fail('run-not-found', 'The native authoring task disappeared.');
      const cycle = yield* inCheckout(
        runWorkflowAutomation(config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'cycle',
          command: 'init',
          runId,
          generation: latest.state.generation,
          expectedRevision: latest.revision,
          plan: exported,
        }),
      );
      return {status: 'admitted', runId, cycle};
    }
    if (request.command === 'decide') {
      if (!existing || !supplied || !referencedRoot)
        return yield* fail('authoring-root-missing', 'Read the complete current document before deciding.');
      if (existing.root.documentHash !== supplied.documentHash)
        return yield* fail(
          'stale-authoring-ref',
          'The displayed document changed; read its current content before responding.',
        );
      if (request.userDecision !== 'approve') {
        if (!exactCurrent()) return yield* fail('stale-authoring-ref', 'Read the current document before responding.');
        return {status: request.userDecision, response: request.userResponse};
      }
      if (
        existing.document.review.required &&
        (!request.review || request.review.outcome !== 'accepted' || request.review.blockingIssueCount !== 0)
      )
        return {
          status: 'needs-review',
          missingInputs: ['An actual accepted independent review of this exact document with no blockers'],
        };
      const metadata = {
        confirmation: {intentHash: existing.root.intentHash, decision: 'approved', response: request.userResponse},
        ...(request.review ? {review: {documentHash: existing.root.documentHash, ...request.review}} : {}),
      };
      if (
        existing.root.readiness === 'ready' &&
        existing.root.documentHash === supplied.documentHash &&
        existing.root.baseRevision === referenced?.artifact?.revision &&
        stableJson({confirmation: existing.root.confirmation, review: existing.root.review}) === stableJson(metadata) &&
        !stored?.state.authoringSave
      )
        return result(existing, true);
      if (!exactCurrent() && !stored?.state.authoringSave)
        return yield* fail('stale-authoring-ref', 'Read the current document before supplying a new decision.');
      const confirmation = yield* call('confirm', {
        document: existing.document,
        presentedIntentHash: existing.root.intentHash,
        userDecision: request.userDecision,
        userResponse: request.userResponse,
      });
      yield* call('save', {
        document: existing.document,
        ready: true,
        uri: referenced?.artifact?.uri,
        expectedRevision: referenced?.artifact?.revision,
        confirmation: confirmation.confirmation,
        ...(request.review ? {review: {documentHash: existing.root.documentHash, ...request.review}} : {}),
      });
    } else {
      const contentPath = path.isAbsolute(request.contentFile)
        ? request.contentFile
        : path.join(checkout, request.contentFile);
      const bytes = yield* fs.stat(contentPath);
      if (bytes.size > 1_000_000n)
        return yield* fail('content-too-large', 'Business content files are limited to 1000000 bytes.');
      const raw = yield* fs.readFileString(contentPath).pipe(
        Effect.flatMap(value =>
          Effect.try({
            try: () => JSON.parse(value),
            catch: () => fail('invalid-content', 'Provide a UTF-8 business JSON artifact.'),
          }),
        ),
      );
      const content = yield* Schema.decodeUnknownEffect(documentKind === 'spec' ? specContent : planContent, {
        onExcessProperty: 'error',
      })(raw).pipe(
        Effect.mapError(() =>
          fail(
            'invalid-content',
            'Business content must match spec/plan fields; omit format, id, project, source, spec export and compact-origin metadata.',
          ),
        ),
      );
      let spec: unknown;
      let requirements: unknown = content.requirements;
      if (request.command === 'start' && request.specRef) {
        if (documentKind !== 'plan' || supplied?.kind !== 'spec' || !stored || !referenced?.artifact)
          return yield* fail('invalid-spec-ref', 'Use the opaque ready spec reference for this same feature.');
        const specCurrent = yield* call('current-authoring', {documentKind: 'spec', detail: 'document'});
        const specValue = object(specCurrent.currentAuthoring);
        const specRoot = object(specValue.root);
        if (specRoot.revision !== referenced.artifact.revision || referencedRoot?.readiness !== 'ready')
          return yield* fail(
            'stale-spec-ref',
            'The specification changed; review and approve its exact current content first.',
          );
        const packet = yield* call('export-plan', {uri: referenced.artifact.uri});
        const approvedSpec = decodeNativeAuthoringDocument(packet.document);
        if (!approvedSpec.source)
          return yield* fail(
            'needs-planning',
            'The approved specification needs actual source evidence before transfer.',
          );
        const actualSpecSource = yield* inCheckout(
          inspectNativeSourcePaths(
            checkout,
            A.map(approvedSpec.source.files, file => file.path),
          ),
        );
        if (stableJson(actualSpecSource) !== stableJson(approvedSpec.source))
          return yield* fail(
            'source-drift',
            'The approved spec source changed; explicitly update and approve its exact current content before transfer.',
          );
        spec = packet.spec;
        requirements = object(packet.document).requirements;
      } else if (request.command === 'save' && existing?.document.kind === 'plan') {
        spec = existing.document.spec;
        if (spec && requirements === undefined) requirements = existing.document.requirements;
      }
      const normalized =
        documentKind === 'plan'
          ? {
              ...content,
              current: {...object(object(content).current), diagram: object(object(content).current).diagram ?? ''},
              target: {...object(object(content).target), diagram: object(object(content).target).diagram ?? ''},
              requirements,
            }
          : content;
      if (
        existing &&
        stableJson(contentOf(existing.document)) === stableJson(normalized) &&
        stableJson(existing.document.kind === 'plan' ? (existing.document.spec ?? null) : null) ===
          stableJson(spec ?? null) &&
        !stored?.state.authoringSave
      ) {
        if (
          request.command === 'start' ||
          existing.root.baseRevision === referenced?.artifact?.revision ||
          exactCurrent()
        )
          return result(existing, true);
      }
      if (request.command === 'start' && existing && !stored?.state.authoringSave)
        return yield* fail(
          'task-intent-conflict',
          'Read this task and save an explicit revision; start cannot replace existing content.',
        );
      if (request.command === 'save' && !exactCurrent() && !stored?.state.authoringSave)
        return yield* fail('stale-authoring-ref', 'Read the current draft before changing business content.');
      const paths =
        'phases' in content
          ? [...new Set([...content.context.codeRefs, ...A.flatMap(content.phases, phase => phase.affectedPaths)])]
          : content.context.codeRefs;
      const source = yield* inCheckout(inspectNativeSourcePaths(checkout, paths));
      const document = decodeNativeAuthoringDocument({
        ...normalized,
        format: 'threadnote-native-authoring',
        schemaVersion: 1,
        kind: documentKind,
        id: stored?.state.featureId ?? featureId,
        project,
        source,
        ...(spec ? {spec} : {}),
      });
      const structural = validateNativeAuthoring(document);
      if (structural.issues.length) return {status: 'needs-planning', issues: structural.issues};
      if (!stored) {
        if (request.command !== 'start' || !featureId)
          return yield* fail('run-not-found', 'Start the authoring task first.');
        const target = yield* readNativeTaskInstalledTarget(config, request.installationTarget, checkout, [
          'desktop',
          'codex-cloud-personal',
          'cursor-cloud-personal',
        ]);
        const binding = yield* inCheckout(
          resolveWorkflowBinding(config, {
            protocolVersion: 1,
            action: 'bind',
            workflowRunId: 'native-v1-' + runId,
            project,
            featureId,
            generation: target.installedDigest,
            profile: target.target.profile,
          }),
        );
        const graph = yield* makeWorkflowGraphAdapter(config, binding, {prepare: false});
        yield* graph.ready(checkout);
        yield* inCheckout(
          runWorkflowAutomation(config, {
            protocolVersion: 1,
            executorVersion: 1,
            action: 'init',
            runId,
            project,
            featureId,
            generation: target.installedDigest,
            profile: target.target.profile,
            title: document.title,
          }),
        );
        stored = yield* readNativeWorkflowState(config, runId);
      }
      if (request.command === 'start' && spec && document.kind === 'plan')
        yield* call('from-spec', {document, packet: yield* call('export-plan', {uri: referenced?.artifact?.uri})});
      if ('saveMode' in request && request.saveMode === 'background') {
        const accepted = object(
          yield* callJob('submit', {
            work: {
              protocolVersion: 1,
              executorVersion: 1,
              action: 'authoring',
              command: 'save',
              runId,
              generation: stored!.state.generation,
              document,
              ready: false,
              expectedRevision: request.command === 'save' ? referenced?.artifact?.revision : null,
              ...(request.command === 'save' ? {uri: referenced?.artifact?.uri} : {}),
            },
          }),
        );
        if (typeof accepted.jobId !== 'string' || typeof accepted.status !== 'string')
          return yield* fail('job-readback', 'The admitted authoring job has no canonical identity.');
        return {
          status: accepted.status,
          runId,
          kind: document.kind,
          jobRef: encodeNativeAuthoringJobRef({
            version: 1,
            kind: document.kind,
            runId,
            generationHash: sha256HexSync(stored!.state.generation),
            jobId: accepted.jobId,
            documentHash: nativeAuthoringDigest(document),
          }),
          job: accepted,
        };
      }
      yield* call('save', {
        document,
        ready: false,
        expectedRevision: request.command === 'save' ? referenced?.artifact?.revision : null,
        ...(request.command === 'save' ? {uri: referenced?.artifact?.uri} : {}),
      });
    }
    existing = yield* current();
    if (!existing) return yield* fail('invalid-readback', 'The saved document could not be independently read back.');
    return result(existing);
  }).pipe(
    Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
    Effect.mapError(nativeWorkflowError),
  );
