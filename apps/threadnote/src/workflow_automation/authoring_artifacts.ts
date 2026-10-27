import {Effect, Schema} from 'effect';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {WorkflowAutomationError, type WorkflowArtifact} from '@threadnote/workflow-automations/contracts';
import {renderNativeDocument, type NativeDocumentEnvelope} from '@threadnote/workflow-automations/documents';
import {stableJson} from '../workflow_memory/protocol.js';
import {nativeWorkflowError} from './memory.js';
import type {NativeWorkflowState} from '@threadnote/workflow-automations/native';

const utf8 = new TextEncoder();
const failure = (message: string) => WorkflowAutomationError.make({code: 'invalid-authoring-artifact', message});
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const uri = Schema.String.check(Schema.isPattern(/^threadnote:\/\/[^\s]+$/u), Schema.isMaxLength(4096));
export const AuthoringReferenceSchema = Schema.Struct({
  uri,
  memoryId: Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u)),
  revision: digest,
});
export type AuthoringReference = typeof AuthoringReferenceSchema.Type;
export const AuthoringDataPageSchema = Schema.Union([
  Schema.Struct({
    format: Schema.Literal('threadnote-native-authoring-data'),
    version: Schema.Literal(1),
    contentHash: digest,
    content: Schema.String.check(Schema.isMaxLength(32_000)),
  }),
  Schema.Struct({
    format: Schema.Literal('threadnote-native-authoring-data'),
    version: Schema.Literal(2),
    encoding: Schema.Literal('utf8'),
    contentHash: digest,
    content: Schema.String,
  }),
]);
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
    Schema.Struct({intentHash: digest, decision: Schema.Literal('approved'), response: Schema.String}),
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

const marker = '<!-- threadnote-authoring:v1 ';
const authoringPayload = (markdown: string, value: unknown, escapeHtml = false): string => {
  const json = stableJson(value);
  return (
    markdown +
    '\n' +
    marker +
    (escapeHtml ? json.replace(/[<>]/gu, character => (character === '<' ? '\\u003c' : '\\u003e')) : json) +
    ' -->\n'
  );
};
const appendAuthoringPayload = (markdown: string, value: unknown): string => {
  const body = authoringPayload(markdown, value);
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
  const start = body.lastIndexOf('\n' + marker);
  if (start < 0 || !body.endsWith(' -->\n')) throw failure('The native authoring marker is missing.');
  try {
    const json = body.slice(start + 1 + marker.length, -' -->\n'.length);
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(JSON.parse(json));
  } catch {
    throw failure('The native authoring artifact is malformed. No legacy record was imported.');
  }
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
  return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
};

export function decodeAuthoringDataContent(page: typeof AuthoringDataPageSchema.Type): string {
  if (page.version === 1) return fromBase64(page.content);
  // Scalar validation preserves U+FEFF, unlike a default TextDecoder roundtrip.
  if (/[\uD800-\uDFFF]/u.test(page.content) || utf8.encode(page.content).byteLength > 20_000)
    throw failure('The authoring data encoding is invalid.');
  return page.content;
}

export function encodeAuthoringDataPage(index: number, content: string, version: 1 | 2 = 2): string {
  const markdown =
    '# Authoring data ' +
    (index + 1) +
    '\n\n## Summary\n\nComplete structured data; use the linked root or bounded detail commands.\n';
  const contentHash = sha256HexSync(content);
  const legacy = appendAuthoringPayload(markdown, {
    format: 'threadnote-native-authoring-data',
    version: 1,
    contentHash,
    content: base64(content),
  });
  if (version === 1) return legacy;
  const candidate = authoringPayload(
    markdown,
    {
      format: 'threadnote-native-authoring-data',
      version: 2,
      encoding: 'utf8',
      contentHash,
      content,
    },
    true,
  );
  return utf8.encode(candidate).byteLength <= Math.min(60_000, utf8.encode(legacy).byteLength) ? candidate : legacy;
}

export function authoringDataPageVersion(
  state: Pick<NativeWorkflowState, 'operations' | 'authoringSave'>,
  text: string,
): 1 | 2 {
  if (!state.authoringSave) return 2;
  const pages = state.operations
    .slice(state.authoringSave.operationStart)
    .filter(operation => operation.intent.role === 'authoring-child' && operation.intent.nameHint === 'source')
    .map(operation => {
      const page = decodeAuthoringArtifact(operation.intent.body, AuthoringDataPageSchema);
      const content = decodeAuthoringDataContent(page);
      if (sha256HexSync(content) !== page.contentHash) throw failure('An admitted authoring data page changed.');
      return {body: operation.intent.body, page};
    });
  const version = pages.length > 0 && pages.every(({page}) => page.version === 1) ? 1 : 2;
  // Unchanged content-addressed pages may replay without appending a suffix intent.
  const expected = new Set(
    splitAuthoringText(text).map((content, index) => encodeAuthoringDataPage(index, content, version)),
  );
  for (const {body} of pages)
    if (!expected.has(body)) throw failure('An admitted authoring data page differs from its deterministic encoding.');
  return version;
}

export const authoringRelations = (context: readonly AuthoringReference[], children: readonly AuthoringReference[]) =>
  [...new Map([...context, ...children].map(reference => [reference.uri, reference])).values()].map(reference => ({
    type: 'references' as const,
    uri: reference.uri,
  }));

export function makeAuthoringArtifacts<R>(options: {
  readonly call: NativeAuthoringCall<R>;
  readonly runId: string;
  readonly generation: string;
  readonly storageKind: 'durable' | 'handoff';
  readonly codeRefs: readonly string[];
  readonly evidenceRefs: readonly AuthoringReference[];
  readonly contextRelations?: readonly AuthoringReference[];
  readonly ownedUris?: readonly string[];
  readonly dataPageVersion?: 1 | 2;
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
      const artifact = result.artifact as WorkflowArtifact;
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
      const artifact = result.artifact as WorkflowArtifact;
      if (artifact.state === 'active') ownedUris.add(artifact.uri);
      return artifact;
    });
  const writeData = (text: string) =>
    Effect.gen(function* () {
      let references: AuthoringReference[] = [];
      const parts = splitAuthoringText(text);
      for (let index = 0; index < parts.length; index++) {
        const content = parts[index];
        const body = encodeAuthoringDataPage(index, content, options.dataPageVersion);
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
              try: () => decodeAuthoringArtifact(artifact.body, AuthoringDataPageSchema),
              catch: nativeWorkflowError,
            });
            const text = yield* Effect.try({try: () => decodeAuthoringDataContent(page), catch: nativeWorkflowError});
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
      return texts.join('');
    });
  return {read, write, writeData, readData};
}
