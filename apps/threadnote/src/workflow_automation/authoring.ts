import {Effect, FileSystem, Path, Schema} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {WorkflowAutomationError, type WorkflowArtifact} from '@threadnote/workflow-automations/contracts';
import {
  NativeAuthoringDocumentSchema,
  canonicalAuthoringJson,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  validateNativeAuthoring,
  type NativeAuthoringDocument,
} from '@threadnote/workflow-automations/authoring';
import {
  decodeNativeDocument,
  outlineNativeDocument,
  readNativeDocumentSection,
  renderNativeDocument,
  type NativeDocumentEnvelope,
} from '@threadnote/workflow-automations/documents';
import {createNativeDocument, nativeDocumentTemplateDefinitions} from '@threadnote/workflow-automations/templates';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  admitNativeAuthoringSave,
  nativeAuthoringPrefixDigest,
  nativeAuthoringSaveByteBudget,
  type NativeWorkflowState,
} from '@threadnote/workflow-automations/native';
import {inspectWorkflowJournal, withWorkflowLock, workflowJournalLogicalBytes} from '../workflow_memory/journal.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {withWorkflowReadCache} from '../workflow_memory/read_cache.js';
import {withWorkflowRecallRefreshBatch} from '../workflow_memory/recall_refresh.js';
import {readWorkflowSharedRoots} from '../workflow_memory/scopes.js';
import {assertWorkflowEvidenceSnapshot, verifyWorkflowEvidence} from '../workflow_memory/evidence.js';
import {workflowArtifactUri} from '../workflow_memory/naming.js';
import {nativeWorkflowError} from './memory.js';
import {assertNativeJobLiveSource, CurrentNativeJobReadyPromotion, CurrentNativeJobSourceView} from './native_jobs.js';
import {nativeAuthoringRequestSchema} from './authoring_request_schema.js';
export {nativeAuthoringRequestSchema} from './authoring_request_schema.js';
import {
  CurrentNativeAuthoringSave,
  CurrentNativeOperationLimit,
  readNativeWorkflowState,
  writeNativeWorkflowState,
  withNativeWorkflowLock,
  withNativeAuthoringLock,
} from './store.js';
import {
  AuthoringReferenceSchema,
  AuthoringRootSchema,
  artifactReference,
  decodeAuthoringArtifact,
  encodeAuthoringArtifact,
  encodeAuthoringDocument,
  makeAuthoringArtifacts,
  splitAuthoringText,
  authoringRelations,
  type AuthoringReference,
  type AuthoringRoot,
  type NativeAuthoringCall,
} from './authoring_artifacts.js';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const authoringDataPage = Schema.Struct({
  format: Schema.Literal('threadnote-native-authoring-data'),
  version: Schema.Literal(1),
  contentHash: digest,
  content: Schema.String.check(Schema.isMaxLength(32_000)),
});
const authoringIndexPage = Schema.Struct({
  format: Schema.Literal('threadnote-native-authoring-index'),
  version: Schema.Literal(1),
  depth: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 3})),
  children: Schema.Array(AuthoringReferenceSchema).check(Schema.isBetweenLength(1, 8)),
});
type Request = typeof nativeAuthoringRequestSchema.Type;
const utf8 = new TextEncoder();
const hasControl = (value: string) =>
  [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const compact = (text: string, maximum = 400) => {
  const characters = [...text];
  return characters.length <= maximum
    ? text
    : characters.slice(0, maximum).join('') + '… (complete content in linked structured data)';
};
const bullets = (items: readonly string[]) => items.map(item => '- ' + item).join('\n');

const inspectSource = Effect.fn('workflowAutomation.authoring.inspectSource')(function* (
  repo: string,
  paths: readonly string[],
  live = false,
) {
  const admitted = live ? undefined : yield* CurrentNativeJobSourceView;
  if (admitted) {
    if (admitted.repo !== repo || paths.length < 1 || paths.length > 128 || new Set(paths).size !== paths.length)
      return yield* fail('invalid-scope', 'Admitted source view differs from the original bound source scope.');
    const files = [] as {path: string; sha256: string}[];
    for (const relative of paths) {
      const file = admitted.files.find(item => item.path === relative);
      if (!file) return yield* fail('invalid-scope', 'Admitted source view lacks a required file.');
      files.push({path: relative, sha256: file.object.sha256});
    }
    return {head: admitted.head, files};
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (paths.length < 1 || paths.length > 128 || new Set(paths).size !== paths.length)
    return yield* fail('invalid-scope', 'Inspect between1and128unique existing relative source files.');
  const root = yield* fs.realPath(repo);
  const files: {path: string; sha256: string}[] = [];
  for (const relative of paths) {
    if (
      relative.length > 4096 ||
      relative.includes('\\') ||
      relative.includes(':') ||
      hasControl(relative) ||
      path.isAbsolute(relative) ||
      relative.split('/').some(segment => !segment || segment === '.' || segment === '..')
    )
      return yield* fail('invalid-scope', 'Source paths must be canonical repository-relative files.');
    const actual = yield* fs.realPath(path.join(root, relative));
    if (!actual.startsWith(root + path.sep))
      return yield* fail('invalid-scope', 'Source files cannot escape the bound checkout.');
    const stat = yield* fs.stat(actual);
    if (stat.type !== 'File' || Number(stat.size) > 1_000_000)
      return yield* fail('invalid-scope', 'Inspect bounded regular source files only.');
    const bytes = yield* fs.readFile(actual);
    if (bytes.byteLength > 1_000_000)
      return yield* fail('invalid-scope', 'Source file changed beyond its admitted byte bound.');
    files.push({path: relative, sha256: sha256HexSync(bytes)});
  }
  const head = (yield* runCommandEffect('git', ['-C', root, 'rev-parse', 'HEAD'], {timeoutMs: 10_000})).stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head))
    return yield* fail('invalid-scope', 'Source inspection requires an existing Git commit.');
  return {head, files};
});

const verifySource = Effect.fn('workflowAutomation.authoring.verifySource')(function* (
  repo: string,
  document: NativeAuthoringDocument,
  live = false,
) {
  if (!document.source) return;
  const source = yield* inspectSource(
    repo,
    document.source.files.map(file => file.path),
    live,
  );
  if (stableJson(source) !== stableJson(document.source))
    return yield* fail(
      'source-drift',
      'Source changed since inspection. Reconcile the draft and obtain a fresh review where required.',
    );
});

/** Small semantic views link to the complete separately indexed structured data. */
function createViewDocument(input: Parameters<typeof createNativeDocument>[0]): NativeDocumentEnvelope {
  const sections = Object.fromEntries(
    Object.entries(input.sections).map(([id, body]) => {
      const bytes = utf8.encode(body);
      const limit = id === 'diagram' ? 10000 : 2000;
      if (bytes.byteLength <= limit) return [id, body];
      let end = limit - 100;
      while ((bytes[end] & 0xc0) === 0x80) end--;
      return [
        id,
        new TextDecoder('utf-8', {fatal: true}).decode(bytes.slice(0, end)) +
          '\n\nComplete content is retained in the linked structured data.',
      ];
    }),
  );
  return createNativeDocument({...input, sections});
}

function documentViews(document: NativeAuthoringDocument): readonly {id: string; document: NativeDocumentEnvelope}[] {
  if (document.kind === 'spec')
    return [
      {
        id: 'spec',
        document: createViewDocument({
          kind: 'spec',
          title: document.title,
          sections: {
            summary: document.objective,
            problem: bullets(document.inScope.map(item => compact(item))),
            requirements: compact(
              bullets(document.requirements.map(item => item.id + ': ' + compact(item.behavior, 120))),
              3500,
            ),
            acceptance: compact(
              bullets(document.scenarios.map(item => item.id + ': ' + compact(item.then, 120))),
              3500,
            ),
            domain: compact(bullets(document.artifacts.map(item => item.title + ': ' + compact(item.summary))), 1600),
            contracts: compact(bullets(document.constraints), 1600),
            questions: compact(bullets(document.questions.map(item => item.id + ': ' + item.question)), 1600),
          },
        }),
      },
    ];
  const architecture = (kind: 'architecture-current' | 'architecture-target', value: typeof document.current) =>
    createViewDocument({
      kind,
      title:
        compact(document.title, 180) +
        ' — ' +
        (kind.endsWith('current') ? 'Current architecture' : 'Target architecture'),
      sections: {
        summary: value.summary,
        components: compact(bullets(value.components), 3000),
        contracts: compact(bullets(value.contracts), 3000),
        diagram: '```mermaid\n' + value.diagram + '\n```',
      },
    });
  return [
    {
      id: 'plan',
      document: createViewDocument({
        kind: 'plan',
        title: document.title,
        sections: {
          summary: document.objective,
          phases: compact(bullets(document.phases.map(item => item.id + ': ' + compact(item.outcome, 120))), 3500),
          validation: compact(
            bullets(
              document.phases.flatMap(item =>
                item.acceptance.map(
                  acceptance => item.id + '/' + acceptance.id + ': ' + compact(acceptance.verification, 120),
                ),
              ),
            ),
            3500,
          ),
          decisions: document.decisions.length
            ? compact(bullets(document.decisions.map(item => item.id + ': ' + compact(item.selected, 120))), 2000)
            : 'Design decision remains unresolved; this is a durable draft.',
        },
      }),
    },
    {id: 'current', document: architecture('architecture-current', document.current)},
    {id: 'target', document: architecture('architecture-target', document.target)},
    {
      id: 'decisions',
      document: createViewDocument({
        kind: 'decisions',
        title: compact(document.title, 180) + ' — Design decisions',
        sections: {
          decision: document.decisions.length
            ? compact(bullets(document.decisions.map(item => item.id + ': ' + item.selected)), 3000)
            : 'Pending orchestrator decision.',
          alternatives: document.decisions.length
            ? compact(
                bullets(
                  document.decisions.flatMap(item =>
                    item.alternatives.length
                      ? item.alternatives.map(
                          alternative =>
                            item.id + '/' + alternative.id + ': ' + alternative.design + '; ' + alternative.tradeoffs,
                        )
                      : [item.id + ': No better alternative identified.'],
                  ),
                ),
                5000,
              )
            : 'Alternatives have not yet been judged.',
          rationale: document.decisions.length
            ? compact(bullets(document.decisions.map(item => item.id + ': ' + item.rationale)), 5000)
            : 'A ready plan requires the orchestrator’s justification.',
          consequences: compact(
            bullets(document.decisions.map(item => item.id + ': affects ' + item.affectedPhases.join(', '))),
            2000,
          ),
        },
      }),
    },
  ];
}

const asArtifact = (value: unknown): WorkflowArtifact => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('artifact' in value) ||
    typeof value.artifact !== 'object' ||
    !value.artifact
  )
    throw fail('invalid-readback', 'Native authoring expected a verified memory artifact.');
  return value.artifact as WorkflowArtifact;
};
const rootSummary = (root: AuthoringRoot, artifact: WorkflowArtifact) => ({
  root: artifactReference(artifact),
  kind: root.kind,
  featureId: root.featureId,
  documentHash: root.documentHash,
  intentHash: root.intentHash,
  readiness: root.readiness,
  data: root.data,
  documents: root.documents,
  previous: root.previous,
});

const ownedAuthoringUris = (state: NativeWorkflowState) =>
  state.operations.flatMap(operation =>
    operation.status === 'verified' && operation.artifact?.state === 'active' ? [operation.artifact.uri] : [],
  );

export const runNativeAuthoring = <R>(config: RuntimeConfig, input: unknown, call: NativeAuthoringCall<R>) =>
  Effect.gen(function* () {
    let request = yield* Schema.decodeUnknownEffect(nativeAuthoringRequestSchema, {onExcessProperty: 'error'})(
      input,
    ).pipe(
      Effect.mapError(() =>
        fail('invalid-request', 'The native authoring request is malformed or contains unsupported fields.'),
      ),
    );
    if (request.command === 'recover' && request.document !== undefined) request = {...request, command: 'save'};
    const base = (action: string) => ({
      protocolVersion: 1,
      executorVersion: 1,
      action,
      runId: request.runId,
      generation: request.generation,
    });
    if (request.command === 'schema')
      return {
        schema: Schema.toJsonSchemaDocument(NativeAuthoringDocumentSchema),
        templates: nativeDocumentTemplateDefinitions,
      };
    yield* call(base('inspect'));
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored) return yield* fail('run-not-found', 'Start a fresh native run before authoring.');
    const state = stored.state;
    if (request.command === 'scope-inspect') {
      if (!request.paths) return yield* fail('invalid-request', 'Provide the exact existing source paths to inspect.');
      if (!request.literalOnly) yield* call(base('graph-ready'));
      // currentBinding validation above admits this exact checkout.
      const journal = yield* withWorkflowLock(config, state.bindingId, inspectWorkflowJournal(config, state.bindingId));
      return {
        source: yield* inspectSource(journal.state.binding.repo, request.paths),
        discovery: request.literalOnly ? 'exact-literals' : 'ready-graph',
      };
    }
    if (request.command === 'pin') {
      if (!request.uri) return yield* fail('invalid-request', 'Provide the recalled memory URI to pin.');
      const result = yield* call({...base('read'), uri: request.uri, evidenceRefs: request.evidenceRefs ?? []});
      const artifact = yield* Effect.try({try: () => asArtifact(result), catch: nativeWorkflowError});
      return {reference: artifactReference(artifact), body: artifact.body};
    }
    const evidenceRefs = request.evidenceRefs ?? [];
    const reader = makeAuthoringArtifacts({
      call,
      runId: request.runId,
      generation: request.generation,
      storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
      codeRefs: [],
      evidenceRefs,
      ownedUris: ownedAuthoringUris(state),
    });
    const load = (uri: string) =>
      Effect.gen(function* () {
        const artifact = yield* call({...base('read'), uri, evidenceRefs}).pipe(
          Effect.flatMap(value => Effect.try({try: () => asArtifact(value), catch: nativeWorkflowError})),
        );
        const root = yield* Effect.try({
          try: () => decodeAuthoringArtifact(artifact.body, AuthoringRootSchema),
          catch: nativeWorkflowError,
        });
        if (root.featureId !== state.featureId)
          return yield* fail('binding-drift', 'This root belongs to another feature.');
        if (
          root.binding.bindingId !== state.bindingId ||
          root.binding.runId !== state.runId ||
          root.binding.generation !== state.generation ||
          root.binding.profile !== state.profile ||
          root.binding.team !== state.team
        )
          return yield* fail('binding-drift', 'This root belongs to another native workflow binding.');
        return {root, artifact};
      });
    const loadDocument = (root: AuthoringRoot) =>
      Effect.gen(function* () {
        const body = yield* reader.readData(root.data);
        if (sha256HexSync(body) !== root.dataHash)
          return yield* fail('invalid-readback', 'Structured authoring data differs from its root digest.');
        const document = yield* Effect.try({
          try: () => decodeNativeAuthoringDocument(JSON.parse(body)),
          catch: nativeWorkflowError,
        });
        if (
          nativeAuthoringDigest(document) !== root.documentHash ||
          document.id !== root.featureId ||
          document.kind !== root.kind ||
          document.project !== state.project
        )
          return yield* fail('invalid-readback', 'The loaded native document differs from its verified root.');
        return document;
      });
    const admitLinkedSpec = (plan: NativeAuthoringDocument) =>
      Effect.gen(function* () {
        if (plan.kind !== 'plan' || !plan.spec) return undefined;
        const pin = plan.spec;
        const ownUris = new Set(ownedAuthoringUris(state));
        const readExact = (reference: AuthoringReference) =>
          Effect.gen(function* () {
            const artifact = yield* call({
              ...base('read'),
              uri: reference.uri,
              evidenceRefs: ownUris.has(reference.uri) ? [] : [reference],
            }).pipe(Effect.flatMap(value => Effect.try({try: () => asArtifact(value), catch: nativeWorkflowError})));
            if (stableJson(artifactReference(artifact)) !== stableJson(reference) || artifact.state !== 'active')
              return yield* fail('revision-conflict', 'The linked native specification artifact changed.');
            return artifact;
          });
        const artifact = yield* readExact(pin.root);
        const root = yield* Effect.try({
          try: () => decodeAuthoringArtifact(artifact.body, AuthoringRootSchema),
          catch: nativeWorkflowError,
        });
        if (
          root.kind !== 'spec' ||
          root.readiness !== 'ready' ||
          root.featureId !== plan.id ||
          root.binding.runId !== pin.binding.runId ||
          root.binding.bindingId !== pin.binding.bindingId ||
          root.binding.generation !== pin.binding.generation ||
          root.binding.profile !== pin.binding.profile ||
          root.binding.team !== pin.binding.team ||
          root.documentHash !== pin.documentHash ||
          root.intentHash !== pin.intentHash
        )
          return yield* fail('invalid-readback', 'The linked native specification is not the pinned ready root.');

        const active = new Set<string>();
        const chunks: string[] = [];
        let visited = 0;
        let size = 0;
        const visit = (
          reference: AuthoringReference,
          expectedDepth?: number,
        ): Effect.Effect<void, WorkflowAutomationError, R> =>
          Effect.gen(function* () {
            if (active.has(reference.uri) || visited >= 64)
              return yield* fail(
                'invalid-readback',
                'The linked specification data tree is cyclic or over its bounded inventory.',
              );
            active.add(reference.uri);
            visited++;
            const child = yield* readExact(reference);
            const payload = yield* Effect.try({
              try: () => decodeAuthoringArtifact(child.body, Schema.Unknown) as Record<string, unknown>,
              catch: nativeWorkflowError,
            });
            if (payload.format === 'threadnote-native-authoring-index') {
              const page = yield* Effect.try({
                try: () => decodeAuthoringArtifact(child.body, authoringIndexPage),
                catch: nativeWorkflowError,
              });
              if (expectedDepth !== undefined && page.depth !== expectedDepth)
                return yield* fail('invalid-readback', 'The linked specification index depth changed.');
              for (const descendant of page.children) yield* visit(descendant, page.depth - 1);
            } else {
              const page = yield* Effect.try({
                try: () => decodeAuthoringArtifact(child.body, authoringDataPage),
                catch: nativeWorkflowError,
              });
              if (expectedDepth !== undefined && expectedDepth !== 0)
                return yield* fail('invalid-readback', 'The linked specification data page is at the wrong depth.');
              const text = yield* Effect.try({
                try: () => {
                  const binary = atob(page.content);
                  if (btoa(binary) !== page.content) throw new Error('Noncanonical base64');
                  return new TextDecoder('utf-8', {fatal: true}).decode(
                    Uint8Array.from(binary, character => character.charCodeAt(0)),
                  );
                },
                catch: () => fail('invalid-readback', 'The linked specification data page encoding is invalid.'),
              });
              if (sha256HexSync(text) !== page.contentHash)
                return yield* fail('invalid-readback', 'The linked specification data page hash changed.');
              size += utf8.encode(text).byteLength;
              if (size > 1_000_000)
                return yield* fail('invalid-readback', 'Linked specification data exceeds its read bound.');
              chunks.push(text);
            }
          }).pipe(Effect.ensuring(Effect.sync(() => active.delete(reference.uri))));
        yield* visit(root.data);
        const text = chunks.join('');
        if (sha256HexSync(text) !== root.dataHash)
          return yield* fail('invalid-readback', 'The linked specification data differs from its root digest.');
        const linked = yield* Effect.try({
          try: () => decodeNativeAuthoringDocument(JSON.parse(text)),
          catch: nativeWorkflowError,
        });
        const linkedValidation = validateNativeAuthoring(linked, {
          ready: true,
          confirmation: root.confirmation,
          review: root.review,
        });
        if (
          linked.kind !== 'spec' ||
          linked.id !== root.featureId ||
          linked.project !== state.project ||
          nativeAuthoringDigest(linked) !== root.documentHash ||
          nativeSpecIntentDigest(linked) !== root.intentHash ||
          !linkedValidation.ready ||
          stableJson(linked.requirements) !== stableJson(plan.requirements) ||
          stableJson(linked.requirements) !== stableJson(pin.requirements) ||
          stableJson(linked.scenarios) !== stableJson(pin.scenarios)
        )
          return yield* fail(
            'invalid-readback',
            'The plan’s linked requirements and scenarios differ from its approved native specification.',
          );
        return {root, artifact, document: linked};
      });
    if (['load', 'read', 'recover', 'export-plan', 'export-dev-cycle', 'closeout-input'].includes(request.command)) {
      if (!request.uri) return yield* fail('invalid-request', 'Provide the saved native authoring root URI.');
      const loaded = yield* load(request.uri);
      if (request.command === 'load' && request.detail !== 'document') return rootSummary(loaded.root, loaded.artifact);
      if (request.command === 'read') {
        if (request.artifactId === 'decisions' && request.decisionId) {
          const full = yield* loadDocument(loaded.root);
          if (full.kind !== 'plan')
            return yield* fail('artifact-not-found', 'Only a plan has orchestrator design decisions.');
          const decision = full.decisions.find(item => item.id === request.decisionId);
          if (!decision) return yield* fail('artifact-not-found', 'The requested stable decision ID does not exist.');
          const envelope = yield* Effect.try({
            try: () =>
              createNativeDocument({
                kind: 'decisions',
                title: 'Design decision ' + decision.id,
                sections: {
                  decision: decision.question + '\n\n' + decision.selected,
                  alternatives: decision.alternatives.length
                    ? decision.alternatives
                        .map(item => item.id + ': ' + item.design + '\n\nTradeoffs: ' + item.tradeoffs)
                        .join('\n\n')
                    : 'No better alternative identified.',
                  rationale: decision.rationale,
                },
              }),
            catch: nativeWorkflowError,
          });
          if (request.detail !== 'section')
            return {
              decisionId: decision.id,
              documentHash: loaded.root.documentHash,
              outline: outlineNativeDocument(envelope),
            };
          if (!request.sectionId)
            return yield* fail('invalid-request', 'Select a stable decision section ID from the outline.');
          return yield* Effect.try({
            try: () => readNativeDocumentSection(envelope, request.sectionId!, request),
            catch: nativeWorkflowError,
          });
        }
        const selected = loaded.root.documents.find(item => item.id === (request.artifactId ?? loaded.root.kind));
        if (!selected) return yield* fail('artifact-not-found', 'Select one of the root’s existing document IDs.');
        const artifact = yield* reader.read(selected.reference);
        const document = yield* Effect.try({
          try: () => decodeAuthoringArtifact(artifact.body, Schema.Unknown),
          catch: nativeWorkflowError,
        });
        const envelope = yield* Effect.try({try: () => decodeNativeDocument(document), catch: nativeWorkflowError});
        if (request.detail !== 'section')
          return {reference: selected.reference, outline: outlineNativeDocument(envelope)};
        if (!request.sectionId) return yield* fail('invalid-request', 'Provide a stable section ID from the outline.');
        return yield* Effect.try({
          try: () => readNativeDocumentSection(envelope, request.sectionId!, request),
          catch: nativeWorkflowError,
        });
      }
      const document = yield* loadDocument(loaded.root);
      if (request.command === 'load') return {...rootSummary(loaded.root, loaded.artifact), document};
      if (request.command === 'recover') {
        // Replaying save uses the original exact intent; loading never recovers implicitly.
        return {
          ...rootSummary(loaded.root, loaded.artifact),
          recovery: 'complete-root-verified',
          documentHash: nativeAuthoringDigest(document),
        };
      }
      if (loaded.root.readiness !== 'ready')
        return yield* fail('not-ready', 'Exports and closeout require a verified ready native root.');
      yield* admitLinkedSpec(document);
      if (request.command === 'export-dev-cycle') {
        const journal = yield* withWorkflowLock(
          config,
          state.bindingId,
          inspectWorkflowJournal(config, state.bindingId),
        );
        yield* verifySource(journal.state.binding.repo, document);
      }
      return yield* exportAuthoring(request, document, loaded.root, loaded.artifact, state);
    }
    if (request.command === 'from-spec') {
      const packet = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          format: Schema.Literal('threadnote-native-spec-export'),
          version: Schema.Literal(1),
          featureId: id,
          project: id,
          spec: Schema.Unknown,
          document: NativeAuthoringDocumentSchema,
          closeout: Schema.Unknown,
        }),
        {onExcessProperty: 'error'},
      )(request.packet).pipe(
        Effect.mapError(() => fail('invalid-request', 'Provide the complete verified native spec export packet.')),
      );
      if (
        packet.document.kind !== 'spec' ||
        typeof request.document !== 'object' ||
        request.document === null ||
        Array.isArray(request.document)
      )
        return yield* fail('invalid-request', 'Provide a native plan draft and a verified spec export packet.');
      const draft = request.document;
      const plan = yield* Effect.try({
        try: () =>
          decodeNativeAuthoringDocument({...draft, requirements: packet.document.requirements, spec: packet.spec}),
        catch: nativeWorkflowError,
      });
      if (
        plan.kind !== 'plan' ||
        !plan.spec ||
        plan.id !== packet.featureId ||
        plan.project !== packet.project ||
        plan.id !== state.featureId ||
        plan.project !== state.project
      )
        return yield* fail(
          'binding-drift',
          'Spec, plan and current native binding must retain the same feature/project.',
        );
      const admitted = yield* admitLinkedSpec(plan);
      if (
        !admitted ||
        nativeAuthoringDigest(packet.document) !== nativeAuthoringDigest(admitted.document) ||
        stableJson(packet.spec) !== stableJson(plan.spec)
      )
        return yield* fail('invalid-readback', 'The planning packet changed approved requirements/scenarios.');
      const result = validateNativeAuthoring(plan);
      return {
        document: plan,
        validation: result,
        spec: plan.spec,
        closeout: {
          specRoot: plan.spec.root,
          required: 'Verify approved behavior/domain and implemented architecture before retiring owned drafts.',
        },
      };
    }
    if (request.command === 'diff') {
      const before = yield* Effect.try({
        try: () => decodeNativeAuthoringDocument(request.before),
        catch: nativeWorkflowError,
      });
      const after = yield* Effect.try({
        try: () => decodeNativeAuthoringDocument(request.after),
        catch: nativeWorkflowError,
      });
      return {
        beforeHash: nativeAuthoringDigest(before),
        afterHash: nativeAuthoringDigest(after),
        intentChanged: nativeSpecIntentDigest(before) !== nativeSpecIntentDigest(after),
        changedFields: Object.keys(after).filter(
          key => stableJson(before[key as keyof typeof before]) !== stableJson(after[key as keyof typeof after]),
        ),
      };
    }
    const document = yield* Effect.try({
      try: () => decodeNativeAuthoringDocument(request.document),
      catch: nativeWorkflowError,
    });
    if (document.id !== state.featureId || document.project !== state.project)
      return yield* fail('binding-drift', 'Authoring document identity must match its existing native binding.');
    yield* admitLinkedSpec(document);
    const validation = yield* Effect.try({
      try: () => validateNativeAuthoring(document, request),
      catch: nativeWorkflowError,
    });
    if (request.command === 'acceptance-packet')
      return {
        documentHash: validation.documentHash,
        intentHash: validation.intentHash,
        summary: {
          title: document.title,
          objective: document.objective,
          requirements: document.requirements.map(item => ({id: item.id, behavior: compact(item.behavior, 100)})),
        },
        views: documentViews(document).map(item => ({id: item.id, outline: outlineNativeDocument(item.document)})),
        approvalInstruction:
          'Present all material behavior/scenario/domain/contract details before asking for approval; fetch explicit detail where needed.',
        ...(request.detail === 'document' ? {document} : {}),
      };
    if (request.command === 'confirm') {
      if (document.kind !== 'spec' || !request.userResponse?.trim() || !request.userDecision)
        return yield* fail(
          'confirmation-required',
          'Record the actual human response to the displayed spec acceptance packet.',
        );
      if (request.userDecision !== 'approve')
        return {confirmation: null, decision: request.userDecision, intentHash: validation.intentHash};
      return {
        confirmation: {
          intentHash: validation.intentHash,
          decision: 'approved' as const,
          response: request.userResponse,
        },
      };
    }
    if (request.command === 'challenge-packet') {
      if (document.kind !== 'plan')
        return yield* fail('invalid-request', 'Design challenge applies to a plan, separate from final review.');
      const skip = request.designRisk === 'routine';
      return {
        documentHash: validation.documentHash,
        action: skip ? 'skip' : 'challenge',
        reason: skip
          ? 'Orchestrator classified this as a routine settled implementation.'
          : 'Assess at most two materially better designs under the same requirements and scope.',
        ...(skip
          ? {}
          : {
              packet: {
                objective: compact(document.objective, 1000),
                requirements: document.requirements
                  .slice(0, 6)
                  .map(item => ({id: item.id, behavior: compact(item.behavior, 150)})),
                initialDesign: compact(document.target.summary, 1800),
                contracts: document.target.contracts.slice(0, 6).map(item => compact(item, 200)),
                codeRefs: document.context.codeRefs,
                decisionRule:
                  'Return up to two high-level alternatives and tradeoffs, without a separate plan. The orchestrator records its decision and rationale.',
              },
            }),
      };
    }
    if (request.command === 'review-packet')
      return {
        documentHash: validation.documentHash,
        summary: {title: document.title, objective: document.objective, kind: document.kind},
        views: documentViews(document).map(item => ({id: item.id, outline: outlineNativeDocument(item.document)})),
        ...(request.detail === 'document' ? {document} : {}),
        validation,
        scope: 'native-authoring-review',
      };
    if (request.command === 'render')
      return {
        documentHash: validation.documentHash,
        documents: documentViews(document).map(item => ({
          id: item.id,
          outline: outlineNativeDocument(item.document),
          ...(request.detail === 'document' ? {markdown: renderNativeDocument(item.document)} : {}),
        })),
      };
    const journal = yield* withWorkflowLock(config, state.bindingId, inspectWorkflowJournal(config, state.bindingId));
    yield* verifySource(journal.state.binding.repo, document);
    const preview = {
      ...base('preflight'),
      operationId: 'author-check-' + validation.documentHash,
      artifactKey: 'author-check-' + validation.documentHash,
      role: 'authoring-validation',
      nameHint: 'validation',
      expectedRevision: null,
      body: '# ' + document.title + '\n\n' + document.objective + '\n',
      storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
      codeRefs: document.context.codeRefs,
      evidenceRefs: document.context.evidenceRefs,
    };
    yield* call(preview);
    if (request.command === 'validate') return validation;
    if (request.command !== 'save')
      return yield* fail('invalid-request', 'This native authoring operation is unsupported.');
    const savingRequest = request.ready && !validation.ready ? {...request, ready: false} : request;
    const saved = yield* saveAuthoring(
      config,
      savingRequest,
      document,
      validation,
      call,
      journal.state.binding.repo,
      admitLinkedSpec,
    );
    return {
      ...saved,
      requestedReadiness: request.ready ? 'ready' : 'draft',
      readinessBlockers: request.ready && !validation.ready ? validation.issues : [],
    };
  }).pipe(
    program => withWorkflowReadCache(program, {compactJournal: true}),
    program => withWorkflowRecallRefreshBatch(config, program),
    Effect.map(payload => ({
      protocolVersion: 1 as const,
      executorVersion: 1 as const,
      status: 'ok' as const,
      authoring: payload,
    })),
    Effect.mapError(nativeWorkflowError),
  );

const boundedView = (document: NativeDocumentEnvelope): NativeDocumentEnvelope => ({
  ...document,
  sections: document.sections.map(section => {
    const bytes = utf8.encode(section.body);
    const limit = section.id === 'diagram' ? 10_000 : 2_000;
    if (bytes.byteLength <= limit) return section;
    let end = limit - 100;
    while ((bytes[end] & 0xc0) === 0x80) end--;
    return {
      ...section,
      body:
        new TextDecoder('utf-8', {fatal: true}).decode(bytes.slice(0, end)) +
        '\n\nComplete content is retained in the linked structured data.',
    };
  }),
});

const authoringContextBody = (references: readonly AuthoringReference[]) =>
  encodeAuthoringArtifact(
    'Planning context',
    'Read and pinned prior evidence, retained without widening its admission scope.',
    {format: 'threadnote-native-authoring-context', version: 1, references},
  );

const clearAuthoringSave = (config: RuntimeConfig, runId: string, intentDigest: string, onlyEmpty = false) =>
  withNativeWorkflowLock(
    config,
    runId,
    false,
    Effect.gen(function* () {
      const current = yield* readNativeWorkflowState(config, runId);
      const reservation = current?.state.authoringSave;
      if (
        !current ||
        !reservation ||
        reservation.intentDigest !== intentDigest ||
        (onlyEmpty && current.state.operations.length !== reservation.operationStart)
      )
        return;
      const journal = yield* withWorkflowLock(
        config,
        current.state.bindingId,
        inspectWorkflowJournal(config, current.state.bindingId),
      );
      const receiptIds = new Set(current.state.operations.map(operation => operation.intent.operationId));
      if (Object.keys(journal.state.operations).some(id => !receiptIds.has(id)))
        return yield* fail(
          'invalid-state',
          'The authoring save cannot finalize while native intent receipts are missing.',
        );
      const {authoringSave: _reservation, ...next} = current.state;
      yield* writeNativeWorkflowState(config, next, current.revision);
    }),
  );

const saveAuthoring = <R>(
  config: RuntimeConfig,
  request: Request,
  document: NativeAuthoringDocument,
  validation: ReturnType<typeof validateNativeAuthoring>,
  call: NativeAuthoringCall<R>,
  repo: string,
  admitLinkedSpec: (document: NativeAuthoringDocument) => Effect.Effect<unknown, WorkflowAutomationError, R>,
) =>
  withNativeAuthoringLock(
    config,
    request.runId,
    Effect.gen(function* () {
      const stored = yield* readNativeWorkflowState(config, request.runId);
      if (!stored) return yield* fail('run-not-found', 'The original native run is missing.');
      const state = stored.state;
      if (state.closeoutSave) return yield* fail('pending-operation', 'Finish the admitted closeout before authoring.');
      const priorRootUri = state.authoringSave
        ? state.authoringSave.rootUri
        : ([...state.operations]
            .reverse()
            .find(
              operation =>
                operation.status === 'verified' && operation.intent.artifactKey === 'author-root-' + document.kind,
            )?.artifact?.uri ?? null);
      const rootUri = request.uri ?? priorRootUri;
      const readiness = request.ready ? 'ready' : 'draft';
      const metadata = {
        ...(request.confirmation ? {confirmation: request.confirmation} : {}),
        ...(request.review ? {review: request.review} : {}),
      };
      const saveDigest = sha256HexSync(
        stableJson({
          documentHash: validation.documentHash,
          readiness,
          metadata,
          expectedRevision: request.expectedRevision ?? null,
          uri: rootUri,
        }),
      );
      if (state.authoringSave && state.authoringSave.intentDigest !== saveDigest)
        return yield* fail('pending-operation', 'Resume the exact authoring save admitted by this run.');
      const authoringCall: NativeAuthoringCall<R> = input =>
        call(input).pipe(Effect.provideService(CurrentNativeAuthoringSave, saveDigest));

      let artifacts = makeAuthoringArtifacts({
        call: authoringCall,
        runId: request.runId,
        generation: request.generation,
        storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
        codeRefs: document.context.codeRefs,
        evidenceRefs: document.context.evidenceRefs,
        ownedUris: ownedAuthoringUris(state),
      });
      const pending = state.operations.find(operation => operation.status === 'prepared');
      const key = 'author-root-' + document.kind;
      if (pending?.intent.artifactKey === key && pending.intent.role === 'authoring-root') {
        const intent = pending.intent;
        if (
          intent.artifactKey !== key ||
          intent.role !== 'authoring-root' ||
          intent.bindingId !== state.bindingId ||
          intent.sourceRunId !== state.runId ||
          intent.storageKind !== (state.profile === 'desktop' ? 'durable' : 'handoff') ||
          intent.nameHint !== document.kind ||
          intent.expectedRevision !== (request.expectedRevision ?? null) ||
          (intent.uri ?? null) !== rootUri ||
          stableJson(intent.codeRefs ?? []) !== stableJson(document.context.codeRefs) ||
          stableJson(intent.evidenceRefs ?? []) !== stableJson(document.context.evidenceRefs)
        )
          return yield* fail(
            'pending-operation',
            'A different native authoring operation is pending. Resume only its exact original save intent.',
          );
        yield* admitLinkedSpec(document);
        const root = yield* Effect.try({
          try: () => decodeAuthoringArtifact(intent.body, AuthoringRootSchema),
          catch: nativeWorkflowError,
        });
        const expectedBinding = {
          bindingId: state.bindingId,
          runId: state.runId,
          generation: state.generation,
          profile: state.profile,
          ...(state.team ? {team: state.team} : {}),
        };
        const text = canonicalAuthoringJson(document);
        if (
          root.kind !== document.kind ||
          root.featureId !== state.featureId ||
          stableJson(root.binding) !== stableJson(expectedBinding) ||
          root.documentHash !== validation.documentHash ||
          root.intentHash !== validation.intentHash ||
          root.dataHash !== sha256HexSync(text) ||
          root.readiness !== readiness ||
          root.baseRevision !== (request.expectedRevision ?? null) ||
          stableJson({confirmation: root.confirmation, review: root.review}) !== stableJson(metadata) ||
          Boolean(root.previous) !== (request.expectedRevision != null)
        )
          return yield* fail('pending-operation', 'The prepared root does not match the exact current save intent.');
        const expectedViews = documentViews(document).map(item => ({...item, document: boundedView(item.document)}));
        if (
          root.documents.length !== expectedViews.length ||
          stableJson(root.documents.map(item => item.id)) !== stableJson(expectedViews.map(item => item.id))
        )
          return yield* fail('pending-operation', 'The prepared root has a different child document set.');
        const links = [
          root.data,
          ...root.documents.map(item => item.reference),
          ...(root.previous ? [root.previous] : []),
        ];
        const contextRelations =
          document.context.evidenceRefs.length > 8
            ? [
                artifactReference(
                  yield* artifacts.write({
                    body: yield* Effect.try({
                      try: () => authoringContextBody(document.context.evidenceRefs),
                      catch: nativeWorkflowError,
                    }),
                    nameHint: 'context',
                    role: 'authoring-context',
                  }),
                ),
              ]
            : document.context.evidenceRefs;
        if (stableJson(intent.relations ?? []) !== stableJson(authoringRelations(contextRelations, links)))
          return yield* fail('pending-operation', 'The prepared root’s native child relations differ from its body.');
        const summary =
          document.objective +
          '\n\nReadiness: ' +
          readiness +
          '. Complete structured data and decision history are linked below.\n\n' +
          links.map(reference => '- [Artifact](' + reference.uri + ')').join('\n');
        const expectedBody = yield* Effect.try({
          try: () => encodeAuthoringArtifact(document.title, summary, root),
          catch: nativeWorkflowError,
        });
        if (intent.body !== expectedBody)
          return yield* fail('pending-operation', 'The prepared root body differs from the current save request.');
        const recoveredData = yield* artifacts.readData(root.data);
        if (recoveredData !== text)
          return yield* fail(
            'pending-operation',
            'The prepared root’s complete structured data differs from this request.',
          );
        for (let index = 0; index < root.documents.length; index++) {
          const saved = yield* artifacts.read(root.documents[index].reference);
          const envelope = yield* Effect.try({
            try: () => decodeNativeDocument(decodeAuthoringArtifact(saved.body, Schema.Unknown)),
            catch: nativeWorkflowError,
          });
          if (stableJson(envelope) !== stableJson(expectedViews[index].document))
            return yield* fail('pending-operation', 'A prepared root child view differs from the current document.');
        }
        const recovered = yield* authoringCall({
          protocolVersion: 1,
          executorVersion: 1,
          action: 'recover',
          runId: request.runId,
          generation: request.generation,
          operationId: intent.operationId,
        }).pipe(Effect.flatMap(value => Effect.try({try: () => asArtifact(value), catch: nativeWorkflowError})));
        const recoveredState = yield* readNativeWorkflowState(config, request.runId);
        if (!recoveredState)
          return yield* fail('run-not-found', 'The original native run disappeared during recovery.');
        const receipt = recoveredState.state.operations.find(item => item.intent.operationId === intent.operationId);
        if (
          receipt?.status !== 'verified' ||
          !receipt.artifact ||
          stableJson(artifactReference(receipt.artifact)) !== stableJson(artifactReference(recovered))
        )
          return yield* fail('invalid-readback', 'The recovered root lacks an exact verified native receipt.');
        artifacts = makeAuthoringArtifacts({
          call: authoringCall,
          runId: request.runId,
          generation: request.generation,
          storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
          codeRefs: document.context.codeRefs,
          evidenceRefs: document.context.evidenceRefs,
          ownedUris: ownedAuthoringUris(recoveredState.state),
        });
        const verified = yield* artifacts.read(artifactReference(recovered));
        if (verified.body !== intent.body)
          return yield* fail('invalid-readback', 'The recovered native root body differs from its prepared intent.');
        const verifiedRoot = yield* Effect.try({
          try: () => decodeAuthoringArtifact(verified.body, AuthoringRootSchema),
          catch: nativeWorkflowError,
        });
        if (stableJson(verifiedRoot) !== stableJson(root) || (yield* artifacts.readData(verifiedRoot.data)) !== text)
          return yield* fail(
            'invalid-readback',
            'The recovered root or its complete data differs from the prepared intent.',
          );
        yield* clearAuthoringSave(config, request.runId, saveDigest);
        return {...rootSummary(verifiedRoot, verified), changed: false, recovered: true};
      }
      yield* admitLinkedSpec(document);
      const priorOperation = [...state.operations]
        .reverse()
        .find(
          operation =>
            operation.status === 'verified' && operation.intent.artifactKey === 'author-root-' + document.kind,
        );
      const prior = priorOperation?.artifact
        ? yield* artifacts.read(artifactReference(priorOperation.artifact))
        : undefined;
      const priorRoot = prior
        ? yield* Effect.try({
            try: () => decodeAuthoringArtifact(prior.body, AuthoringRootSchema),
            catch: nativeWorkflowError,
          })
        : undefined;
      if (
        prior &&
        priorRoot &&
        priorRoot.documentHash === validation.documentHash &&
        priorRoot.readiness === readiness &&
        stableJson({confirmation: priorRoot.confirmation, review: priorRoot.review}) === stableJson(metadata) &&
        (request.expectedRevision === priorRoot.baseRevision || request.expectedRevision === prior.revision)
      ) {
        yield* clearAuthoringSave(config, request.runId, saveDigest);
        return {...rootSummary(priorRoot, prior), changed: false};
      }
      if (
        (prior?.revision ?? null) !== (request.expectedRevision ?? null) ||
        (request.uri !== undefined && request.uri !== prior?.uri)
      )
        return yield* fail(
          'revision-conflict',
          'Load the current native root and save against its exact revision; the previous root is unchanged.',
        );
      const structural = validateNativeAuthoring(document);
      if (structural.issues.length)
        return yield* fail(
          'invalid-document',
          'Resolve the document’s structural/coverage/source issues before saving; readiness-only questions remain draftable.',
        );
      const text = canonicalAuthoringJson(document);
      const views = documentViews(document).map(item => ({...item, document: boundedView(item.document)}));
      const encodedViews = yield* Effect.try({
        try: () =>
          views.map(item => ({
            ...item,
            body: encodeAuthoringDocument(item.document),
          })),
        catch: nativeWorkflowError,
      });
      const pages = splitAuthoringText(text).length;
      const plannedCount =
        pages +
        Math.ceil(pages / 8) +
        Math.ceil(pages / 64) +
        encodedViews.length +
        (prior ? 1 : 0) +
        1 +
        (document.context.evidenceRefs.length > 8 ? 1 : 0);
      const journal = yield* withWorkflowLock(config, state.bindingId, inspectWorkflowJournal(config, state.bindingId));
      const originalOperations = state.operations.slice(
        0,
        state.authoringSave?.operationStart ?? state.operations.length,
      );
      const originalUris = new Set(
        originalOperations.flatMap(operation =>
          operation.status === 'verified' && operation.artifact?.state === 'active' ? [operation.artifact.uri] : [],
        ),
      );
      const sharedRoots = yield* readWorkflowSharedRoots(config, journal.state.binding);
      yield* verifyWorkflowEvidence(config, journal.state.binding, document.context.evidenceRefs);
      let evidenceBytes = 0;
      const store = yield* ResourceStore;
      for (const reference of document.context.evidenceRefs) {
        if (originalUris.has(reference.uri)) continue;
        const content = yield* store.read(
          {account: config.account, home: config.agentContextHome, user: config.user},
          reference.uri,
        );
        yield* Effect.try({
          try: () => assertWorkflowEvidenceSnapshot(journal.state.binding, reference, reference.uri, content),
          catch: nativeWorkflowError,
        });
        evidenceBytes += utf8.encode(JSON.stringify(content)).byteLength;
      }
      const candidate = workflowArtifactUri(journal.state.binding, {
        artifactKey: 'author-' + '0'.repeat(64),
        storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
        ...(state.naming ? {naming: {role: 'source', version: 1}} : {}),
      });
      // Naming limits each generated filename to200 ASCII bytes. Retain its
      // actual canonical user/project prefix instead of assuming a short URI.
      const generatedScopeBytes =
        utf8.encode(JSON.stringify(candidate.slice(0, candidate.lastIndexOf('/') + 1) + 'x'.repeat(200))).byteLength +
        1;
      const scopes = [...sharedRoots, ...originalUris];
      const proposedBytes = nativeAuthoringSaveByteBudget({
        contentBytes:
          utf8.encode(text).byteLength +
          encodedViews.reduce((total, item) => total + utf8.encode(item.body).byteLength, 0),
        evidenceBytes,
        plannedOperations: plannedCount,
        scopeBytes: utf8.encode(JSON.stringify(scopes)).byteLength,
        maximumScopeEntryBytes: Math.max(
          generatedScopeBytes,
          ...document.context.evidenceRefs.map(ref => utf8.encode(JSON.stringify(ref.uri)).byteLength + 1),
        ),
        requestMetadataBytes: utf8.encode(
          stableJson({
            binding: journal.state.binding,
            generation: request.generation,
            codeRefs: document.context.codeRefs,
            evidenceRefs: document.context.evidenceRefs,
          }),
        ).byteLength,
      });
      const operationLimit = yield* CurrentNativeOperationLimit;
      const reservation = yield* Effect.try({
        try: () =>
          admitNativeAuthoringSave(
            {
              intentDigest: saveDigest,
              rootUri,
              operationCount: state.operations.length,
              plannedOperations: plannedCount,
              journalBytes: workflowJournalLogicalBytes(journal.state, true),
              stateBytes: utf8.encode(stableJson(state)).byteLength,
              plannedBytes: proposedBytes,
              prefixDigest: nativeAuthoringPrefixDigest(
                state.operations.slice(0, state.authoringSave?.operationStart ?? state.operations.length),
              ),
              operationLimit: operationLimit,
            },
            state.authoringSave,
          ),
        catch: nativeWorkflowError,
      });
      if (!state.authoringSave)
        yield* withNativeWorkflowLock(
          config,
          request.runId,
          false,
          Effect.gen(function* () {
            const current = yield* readNativeWorkflowState(config, request.runId);
            if (!current || current.revision !== stored.revision || current.state.closeoutSave)
              return yield* fail(
                'state-conflict',
                'This native run changed before authoring admission. Retry from its current receipt.',
              );
            yield* writeNativeWorkflowState(config, {...current.state, authoringSave: reservation}, current.revision);
          }),
        );
      yield* verifySource(repo, document);
      if (document.context.evidenceRefs.length > 8) {
        const body = yield* Effect.try({
          try: () => authoringContextBody(document.context.evidenceRefs),
          catch: nativeWorkflowError,
        });
        const contextArtifact = yield* artifacts.write({body, nameHint: 'context', role: 'authoring-context'});
        artifacts = makeAuthoringArtifacts({
          call: authoringCall,
          runId: request.runId,
          generation: request.generation,
          storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
          codeRefs: document.context.codeRefs,
          evidenceRefs: document.context.evidenceRefs,
          contextRelations: [artifactReference(contextArtifact)],
          ownedUris: ownedAuthoringUris(state),
        });
      }
      const data = yield* artifacts.writeData(text);
      const documents: {id: string; reference: AuthoringReference}[] = [];
      for (const view of encodedViews) {
        const artifact = yield* artifacts.write({
          body: view.body,
          nameHint:
            view.id === 'current'
              ? 'arch-current'
              : view.id === 'target'
                ? 'arch-target'
                : view.id === document.kind
                  ? document.kind + '-overview'
                  : view.id,
        });
        documents.push({id: view.id, reference: artifactReference(artifact)});
      }
      const previous = prior
        ? artifactReference(
            yield* artifacts.write({
              body: prior.body,
              nameHint: 'history',
              role: 'authoring-history',
              relations: priorRoot
                ? [
                    priorRoot.data,
                    ...priorRoot.documents.map(item => item.reference),
                    ...(priorRoot.previous ? [priorRoot.previous] : []),
                  ]
                : [],
            }),
          )
        : undefined;
      const root: AuthoringRoot = {
        format: 'threadnote-native-authoring-root',
        version: 1,
        kind: document.kind,
        featureId: document.id,
        binding: {
          bindingId: state.bindingId,
          runId: state.runId,
          generation: state.generation,
          profile: state.profile,
          ...(state.team ? {team: state.team} : {}),
        },
        documentHash: validation.documentHash,
        intentHash: validation.intentHash,
        baseRevision: prior?.revision ?? null,
        readiness,
        data,
        dataHash: sha256HexSync(text),
        documents,
        ...(previous ? {previous} : {}),
        ...metadata,
      };
      const links = [data, ...documents.map(item => item.reference), ...(previous ? [previous] : [])];
      const summary =
        document.objective +
        '\n\nReadiness: ' +
        readiness +
        '. Complete structured data and decision history are linked below.\n\n' +
        links.map(reference => '- [Artifact](' + reference.uri + ')').join('\n');
      const body = yield* Effect.try({
        try: () => encodeAuthoringArtifact(document.title, summary, root),
        catch: nativeWorkflowError,
      });
      // A changed source cannot publish a root referring to stale child acceptance.
      yield* verifySource(repo, document, readiness === 'ready');
      const rootWrite = artifacts.write({
        body,
        nameHint: document.kind,
        role: 'authoring-root',
        artifactKey: 'author-root-' + document.kind,
        expectedRevision: prior?.revision ?? null,
        ...(prior ? {uri: prior.uri} : {}),
        relations: links,
      });
      const artifact = yield* rootWrite.pipe(
        Effect.provideService(CurrentNativeJobReadyPromotion, readiness === 'ready'),
      );
      const admitted = yield* CurrentNativeJobSourceView;
      if (admitted && readiness === 'ready') yield* assertNativeJobLiveSource(admitted);
      yield* clearAuthoringSave(config, request.runId, saveDigest);
      return {...rootSummary(root, artifact), changed: true};
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          const current = yield* readNativeWorkflowState(config, request.runId);
          const reservation = current?.state.authoringSave;
          if (!reservation || current?.state.operations.length !== reservation.operationStart) return;
          const digest = sha256HexSync(
            stableJson({
              documentHash: validation.documentHash,
              readiness: request.ready ? 'ready' : 'draft',
              metadata: {
                ...(request.confirmation ? {confirmation: request.confirmation} : {}),
                ...(request.review ? {review: request.review} : {}),
              },
              expectedRevision: request.expectedRevision ?? null,
              uri: request.uri ?? reservation.rootUri,
            }),
          );
          if (digest === reservation.intentDigest) yield* clearAuthoringSave(config, request.runId, digest, true);
        }).pipe(Effect.ignore),
      ),
    ),
  );

const exportAuthoring = Effect.fn('workflowAutomation.authoring.export')(function* (
  request: Request,
  document: NativeAuthoringDocument,
  root: AuthoringRoot,
  artifact: WorkflowArtifact,
  state: NativeWorkflowState,
) {
  const validation = validateNativeAuthoring(document, {
    ready: true,
    confirmation: root.confirmation,
    review: root.review,
  });
  if (!validation.ready)
    return yield* fail('not-ready', 'Stored readiness evidence is incomplete or stale for the exact document.');
  const binding = {
    bindingId: state.bindingId,
    runId: state.runId,
    generation: state.generation,
    profile: state.profile,
    ...(state.team ? {team: state.team} : {}),
  };
  if (request.command === 'export-plan') {
    if (document.kind !== 'spec')
      return yield* fail('invalid-request', 'Only a verified native spec exports planning intent.');
    return {
      format: 'threadnote-native-spec-export',
      version: 1,
      featureId: document.id,
      project: document.project,
      spec: {
        root: artifactReference(artifact),
        binding,
        documentHash: root.documentHash,
        intentHash: root.intentHash,
        requirements: document.requirements,
        scenarios: document.scenarios,
      },
      document,
      closeout: {
        specRoot: artifactReference(artifact),
        required: 'Verify behavior/domain and bind implemented architecture before retiring owned drafts.',
      },
    };
  }
  if (document.kind !== 'plan') return yield* fail('invalid-request', 'This export requires a verified native plan.');
  if (request.command === 'closeout-input')
    return {
      format: 'threadnote-native-closeout-input',
      version: 1,
      featureId: document.id,
      project: document.project,
      root: artifactReference(artifact),
      binding,
      documentHash: root.documentHash,
      spec: document.spec,
      requirements: document.requirements,
      phases: document.phases,
      decisions: root.documents.find(item => item.id === 'decisions')?.reference,
      current: root.documents.find(item => item.id === 'current')?.reference,
      target: root.documents.find(item => item.id === 'target')?.reference,
      history: root.previous,
      required:
        'Bind verified current code refs and phase acceptance to implemented architecture before retiring owned drafts.',
    };
  if (!request.delivery || !request.bindings)
    return yield* fail(
      'invalid-request',
      'Provide the already-authorized delivery mode and an exact branch/base binding for every phase.',
    );
  if (
    Object.keys(request.bindings).sort().join('\n') !==
    document.phases
      .map(phase => phase.id)
      .sort()
      .join('\n')
  )
    return yield* fail('invalid-request', 'Branch bindings must cover exactly the approved phase IDs.');
  const phases = [];
  for (const phase of document.phases) {
    const branch = request.bindings[phase.id];
    if (
      !branch.branch.trim() ||
      !branch.baseBranch.trim() ||
      branch.branch.length > 256 ||
      branch.baseBranch.length > 256 ||
      hasControl(branch.branch + branch.baseBranch)
    )
      return yield* fail('invalid-request', 'Phase branches must be explicit bounded Git references.');
    phases.push({
      id: phase.id,
      definitionHash: sha256HexSync('threadnote.native-cycle.phase-definition.v1\n' + stableJson(phase)),
      title: phase.title,
      dependsOn: phase.dependsOn,
      allowedPaths: [...phase.affectedPaths, ...phase.newPaths],
      acceptanceCriteria: phase.acceptance.map(item => item.criterion),
      safeToMergeReason: phase.safeBoundary,
      branch: branch.branch,
      baseBranch: branch.baseBranch,
      status: 'pending',
      acceptanceRefs: phase.acceptance.map(item => ({
        id: item.id,
        criterion: item.criterion,
        requirements: item.requirementIds,
        specScenarios: item.scenarioIds ?? [],
      })),
    });
  }
  return {
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: document.id,
    project: document.project,
    objective: document.objective,
    delivery: request.delivery,
    source: {root: artifactReference(artifact), binding, documentHash: root.documentHash},
    spec: document.spec,
    phases,
    decisions: root.documents.find(item => item.id === 'decisions')?.reference,
    completion: {
      root: artifactReference(artifact),
      specRoot: document.spec?.root,
      required:
        'Bind verified current code refs and acceptance to implemented architecture before retiring owned drafts.',
    },
  };
});
