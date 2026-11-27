import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import {NativeBranchBindingsSchema} from '@threadnote/workflow-automations/task';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {WorkflowAutomationError, type WorkflowArtifact} from '@threadnote/workflow-automations/contracts';
import {renderNativeDocument, type NativeDocumentEnvelope} from '@threadnote/workflow-automations/documents';
import {
  type NativeAuthoringDocument,
  type NativeAuthoringPlanDocumentSchema,
} from '@threadnote/workflow-automations/authoring';
import type {NativeCyclePlan} from '@threadnote/workflow-automations/cycle';
import {stableJson} from '../workflow_memory/protocol.js';
import {nativeWorkflowError} from './memory.js';
import {authoringMarker, authoringTrailerStart} from './authoring_trailer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const utf8 = new TextEncoder();
const failure = (message: string) => WorkflowAutomationError.make({code: 'invalid-authoring-artifact', message});
function isWorkflowArtifact(value: unknown): value is WorkflowArtifact {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    typeof value.uri === 'string' &&
    'memoryId' in value &&
    typeof value.memoryId === 'string' &&
    'revision' in value &&
    typeof value.revision === 'string' &&
    'body' in value &&
    typeof value.body === 'string' &&
    'storageKind' in value &&
    (value.storageKind === 'durable' || value.storageKind === 'handoff') &&
    'state' in value &&
    (value.state === 'active' || value.state === 'archived')
  );
}
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const uri = Schema.String.check(Schema.isPattern(/^threadnote:\/\/[^\s]+$/u), Schema.isMaxLength(4096));
export const AuthoringReferenceSchema = Schema.Struct({
  uri,
  memoryId: Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u)),
  revision: digest,
});
export type AuthoringReference = typeof AuthoringReferenceSchema.Type;
const dataPage = Schema.Struct({
  format: Schema.Literal('threadnote-native-authoring-data'),
  version: Schema.Literal(1),
  contentHash: digest,
  content: Schema.String.check(Schema.isMaxLength(32_000)),
});
const indexPage = Schema.Struct({
  format: Schema.Literal('threadnote-native-authoring-index'),
  version: Schema.Literal(1),
  depth: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 3})),
  children: Schema.Array(AuthoringReferenceSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export const AuthoringRootSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-authoring-root'),
  version: Schema.Literal(1),
  kind: Schema.Literals(['spec', 'plan']),
  featureId: Schema.String,
  binding: Schema.Struct({
    bindingId: digest,
    runId: Schema.String,
    generation: Schema.String,
    profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
    team: Schema.optionalKey(Schema.String),
  }),
  documentHash: digest,
  intentHash: digest,
  planIntentPolicyVersion: Schema.optionalKey(Schema.Literals([2, 3])),
  baseRevision: Schema.NullOr(digest),
  readiness: Schema.Literals(['draft', 'ready']),
  data: AuthoringReferenceSchema,
  dataHash: digest,
  documents: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      reference: AuthoringReferenceSchema,
    }),
  ).check(Schema.isMaxLength(8)),
  previous: Schema.optionalKey(AuthoringReferenceSchema),
  confirmation: Schema.optionalKey(
    Schema.Struct({
      intentHash: digest,
      decision: Schema.Literal('approved'),
      response: Schema.String,
      delivery: Schema.optionalKey(Schema.Literals(['commit', 'pr'])),
      bindings: Schema.optionalKey(NativeBranchBindingsSchema),
    }),
  ),
  review: Schema.optionalKey(
    Schema.Struct({
      documentHash: digest,
      outcome: Schema.Literals(['accepted', 'changes-requested']),
      blockingIssueCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type AuthoringRoot = typeof AuthoringRootSchema.Type;
export type NativeAuthoringCall<R> = (request: unknown) => Effect.Effect<unknown, WorkflowAutomationError, R>;

const appendAuthoringPayload = (markdown: string, value: unknown): string => {
  const body = markdown + '\n' + authoringMarker + stableJson(value) + ' -->\n';
  if (utf8.encode(body).byteLength > 60_000)
    throw WorkflowAutomationError.make({
      code: 'authoring-size',
      message: 'Split this authoring artifact before writing; a document exceeds60000UTF8bytes.',
    });
  return body;
};
export function encodeAuthoringDocument(document: NativeDocumentEnvelope): string {
  return appendAuthoringPayload(renderNativeDocument(document), document);
}
export function encodeAuthoringArtifact(title: string, summary: string, value: unknown): string {
  return appendAuthoringPayload('# ' + title + '\n\n## Summary\n\n' + summary + '\n', value);
}
export function decodeAuthoringArtifact<A>(body: string, schema: Schema.ConstraintDecoder<A>): A {
  const start = authoringTrailerStart(body);
  if (start === undefined) throw failure('The native authoring marker is missing.');
  try {
    const json = Effect2.pipe(body, EffectString.slice(start + 1 + authoringMarker.length, -' -->\n'.length));
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(JSON.parse(json));
  } catch {
    throw failure('The native authoring artifact is malformed. No legacy record was imported.');
  }
}
/** The root of this kind the run last wrote, read from its own verified write receipt. */
export function verifiedAuthoringRoot(
  operations: readonly {
    readonly status: string;
    readonly intent: {readonly artifactKey: string};
    readonly artifact?: {readonly body: string};
  }[],
  kind: string,
) {
  const body = Effect2.Option.getOrUndefined(
    EffectArray.findLast(
      operations,
      operation => operation.status === 'verified' && operation.intent.artifactKey === 'author-root-' + kind,
    ),
  )?.artifact?.body;
  return body === undefined ? undefined : decodeAuthoringArtifact(body, AuthoringRootSchema);
}
type NativePlanPhase = (typeof NativeAuthoringPlanDocumentSchema.Type)['phases'][number];
/** The definition hash a native cycle plan records for an approved plan phase. */
export const nativePlanPhaseDefinitionHash = (phase: NativePlanPhase): string =>
  sha256HexSync('threadnote.native-cycle.phase-definition.v1\n' + stableJson(phase));
/**
 * Phases of `old`, exported before the standard profile, that `plan` changes only in their paths: the phase in
 * `document` (the one `plan` was exported from) reproduces the recorded definition hash with the recorded paths.
 */
export function nativeLegacyPathOnlyPhases(
  document: NativeAuthoringDocument,
  old: NativeCyclePlan,
  plan: NativeCyclePlan,
): readonly string[] {
  if (document.kind !== 'plan') return [];
  const phase = (from: NativeCyclePlan, id: string) =>
    Effect2.Option.getOrUndefined(EffectArray.findFirst(from.phases, item => item.id === id));
  const pathOnly = EffectArray.filter(document.phases, current => {
    const before = phase(old, current.id);
    if (!before || before.intentDefinitionHash !== undefined) return false;
    if (phase(plan, current.id)?.definitionHash !== nativePlanPhaseDefinitionHash(current)) return false;
    // The plan records affectedPaths then newPaths as one list, so each split point is a candidate.
    const paths = before.allowedPaths;
    return EffectArray.some(
      EffectArray.makeBy(paths.length + 1, split => split),
      split =>
        nativePlanPhaseDefinitionHash({
          ...current,
          affectedPaths: paths.slice(0, split),
          newPaths: paths.slice(split),
        }) === before.definitionHash,
    );
  });
  return EffectArray.map(pathOnly, current => current.id);
}
export const artifactReference = (artifact: WorkflowArtifact): AuthoringReference => ({
  uri: artifact.uri,
  memoryId: artifact.memoryId,
  revision: artifact.revision,
});
export function splitAuthoringText(text: string): readonly string[] {
  const bytes = utf8.encode(text);
  if (bytes.byteLength > 1_000_000) throw failure('Authoring data exceeds1000000UTF8bytes.');
  const pages: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + 20_000, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    pages.push(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return pages.length ? pages : [''];
}
const base64 = (content: string): string => {
  const bytes = utf8.encode(content);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (content: string): string => {
  const binary = atob(content);
  if (btoa(binary) !== content) throw failure('The authoring data encoding is not canonical.');
  return new TextDecoder('utf-8', {fatal: true}).decode(
    Uint8Array.from(binary, char =>
      Effect2.pipe(
        char,
        EffectString.charCodeAt(0),
        Effect2.Option.getOrElse(() => NaN),
      ),
    ),
  );
};

export const authoringRelations = (context: readonly AuthoringReference[], children: readonly AuthoringReference[]) =>
  EffectArray.map(
    [...new Map(EffectArray.map([...context, ...children], reference => [reference.uri, reference])).values()],
    reference => ({
      type: 'references' as const,
      uri: reference.uri,
    }),
  );

export function makeAuthoringArtifacts<R>(options: {
  readonly call: NativeAuthoringCall<R>;
  readonly runId: string;
  readonly generation: string;
  readonly storageKind: 'durable' | 'handoff';
  readonly codeRefs: readonly string[];
  readonly evidenceRefs: readonly AuthoringReference[];
  readonly contextRelations?: readonly AuthoringReference[];
  readonly ownedUris?: readonly string[];
}) {
  const ownedUris = new Set(options.ownedUris);
  const request = (action: string) => ({
    protocolVersion: 1,
    executorVersion: 1,
    action,
    runId: options.runId,
    generation: options.generation,
  });
  const read = (reference: AuthoringReference) =>
    Effect.gen(function* () {
      const result = yield* options.call({
        ...request('read'),
        uri: reference.uri,
        evidenceRefs: ownedUris.has(reference.uri) ? [] : [reference],
      });
      if (typeof result !== 'object' || result === null || !('artifact' in result))
        return yield* failure('Native authoring readback did not return an artifact.');
      const artifact = result.artifact;
      if (!isWorkflowArtifact(artifact))
        return yield* failure('Native authoring readback returned a malformed artifact.');
      if (
        artifact.uri !== reference.uri ||
        artifact.memoryId !== reference.memoryId ||
        artifact.revision !== reference.revision ||
        artifact.state !== 'active'
      )
        return yield* failure('The referenced authoring artifact changed. Refresh its root before continuing.');
      return artifact;
    });
  const write = (input: {
    readonly body: string;
    readonly nameHint: string;
    readonly role?: string;
    readonly artifactKey?: string;
    readonly expectedRevision?: string | null;
    readonly uri?: string;
    readonly relations?: readonly AuthoringReference[];
  }) =>
    Effect.gen(function* () {
      const identity = sha256HexSync(
        stableJson({...input, codeRefs: options.codeRefs, evidenceRefs: options.evidenceRefs}),
      );
      const links = authoringRelations(options.contextRelations ?? options.evidenceRefs, input.relations ?? []);
      if (links.length > 16)
        return yield* failure('Use a context navigation index before linking more than 16 native relations.');
      const result = yield* options.call({
        ...request('write'),
        operationId: 'author-' + identity,
        artifactKey: input.artifactKey ?? 'author-' + identity,
        role: input.role ?? 'authoring-child',
        nameHint: input.nameHint,
        body: input.body,
        expectedRevision: input.expectedRevision ?? null,
        ...(input.uri ? {uri: input.uri} : {}),
        storageKind: options.storageKind,
        codeRefs: options.codeRefs,
        evidenceRefs: options.evidenceRefs,
        relations: links,
      });
      if (typeof result !== 'object' || result === null || !('artifact' in result))
        return yield* failure('Native authoring write did not return verified artifact readback.');
      const artifact = result.artifact;
      if (!isWorkflowArtifact(artifact)) return yield* failure('Native authoring write returned a malformed artifact.');
      if (artifact.state === 'active') ownedUris.add(artifact.uri);
      return artifact;
    });
  const writeData = (text: string) =>
    Effect.gen(function* () {
      let references: AuthoringReference[] = [];
      const parts = splitAuthoringText(text);
      for (let index = 0; index < parts.length; index++) {
        const content = parts[index];
        const body = encodeAuthoringArtifact(
          'Authoring data ' + (index + 1),
          'Complete structured data; use the linked root or bounded detail commands.',
          {
            format: 'threadnote-native-authoring-data',
            version: 1,
            contentHash: sha256HexSync(content),
            content: base64(content),
          },
        );
        references.push(artifactReference(yield* write({body, nameHint: 'source'})));
      }
      let depth = 1;
      do {
        const next: AuthoringReference[] = [];
        for (let index = 0; index < references.length; index += 8) {
          const children = references.slice(index, index + 8);
          const body = encodeAuthoringArtifact(
            'Authoring data index',
            'Ordered links retain the complete structured payload.',
            {
              format: 'threadnote-native-authoring-index',
              version: 1,
              depth,
              children,
            },
          );
          next.push(artifactReference(yield* write({body, nameHint: 'index', relations: children})));
        }
        references = next;
        depth++;
      } while (references.length > 1);
      return references[0];
    });
  const readData = (reference: AuthoringReference) =>
    Effect.gen(function* () {
      const active = new Set<string>();
      let visited = 0;
      const texts: string[] = [];
      let bytes = 0;
      const visit = (
        current: AuthoringReference,
        expectedDepth?: number,
      ): Effect.Effect<void, WorkflowAutomationError, R> =>
        Effect.gen(function* () {
          if (active.has(current.uri) || visited >= 64)
            return yield* failure('Authoring navigation is cyclic or exceeds its bounded inventory.');
          active.add(current.uri);
          visited++;
          const artifact = yield* read(current);
          if (expectedDepth === 0) {
            const page = yield* Effect.try({
              try: () => decodeAuthoringArtifact(artifact.body, dataPage),
              catch: nativeWorkflowError,
            });
            const text = yield* Effect.try({try: () => fromBase64(page.content), catch: nativeWorkflowError});
            if (sha256HexSync(text) !== page.contentHash) return yield* failure('An authoring data page changed.');
            bytes += utf8.encode(text).byteLength;
            if (bytes > 1_000_000) return yield* failure('Authoring data exceeds its bounded read size.');
            texts.push(text);
          } else {
            const page = yield* Effect.try({
              try: () => decodeAuthoringArtifact(artifact.body, indexPage),
              catch: nativeWorkflowError,
            });
            if (expectedDepth !== undefined && page.depth !== expectedDepth)
              return yield* failure('Authoring index depth differs from its parent.');
            for (const child of page.children) yield* visit(child, page.depth - 1);
          }
        }).pipe(Effect.ensuring(Effect.sync(() => active.delete(current.uri))));
      yield* visit(reference);
      return EffectArray.join(texts, '');
    });
  return {read, write, writeData, readData};
}
