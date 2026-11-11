import {Array as EffectArray, Option as EffectOption, Schema, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {applyScrubber} from '@threadnote/platform/scrubber';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {Effect} from 'effect';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {decodeNativeDocument} from '@threadnote/workflow-automations/documents';
import {decodeAuthoringArtifact} from './authoring_artifacts.js';
import type {ShareRuntime} from '../types.js';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  NATIVE_RESOURCE_BACKEND,
  assertShareTeamWritable,
  ensureSharedDirectoryChain,
  readMemoryContent,
  resolveTeam,
  resourceExists,
  writeMemoryFile,
} from '../share/core.js';
import {assertSharedWorktreeFileReady, publishShareGitChange, writeSharedWorktreeFile} from '../share/git.js';
import {
  decodeNativeAuthoringDocument,
  canonicalAuthoringJson,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  type NativeAuthoringDocument,
} from '@threadnote/workflow-automations/authoring';

/** A shared plan is data. Its donor identifiers are never an execution capability. */
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const scopeId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/u));
const reference = Schema.Struct({
  uri: Schema.String.check(Schema.isPattern(/^threadnote:\/\/[^\s]+$/u), Schema.isMaxLength(4096)),
  memoryId: Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u)),
  revision: hash,
});
export const PortablePlanPayloadSchema = Schema.Struct({
  format: Schema.Literal('threadnote-portable-plan'),
  version: Schema.Literal(1),
  project: scopeId,
  plan: Schema.Struct({document: Schema.String.check(Schema.isMaxLength(1_000_000)), documentHash: hash}),
  spec: Schema.optionalKey(
    Schema.Struct({document: Schema.String.check(Schema.isMaxLength(1_000_000)), documentHash: hash}),
  ),
  evidence: Schema.Array(
    Schema.Struct({
      reference,
      body: Schema.String.check(Schema.isMaxLength(60_000)),
      bodyHash: hash,
      review: Schema.Literal('approved-durable'),
    }),
  ).check(Schema.isMaxLength(16)),
  provenance: Schema.Struct({
    root: reference,
    documentHash: hash,
    intentHash: hash,
    review: Schema.Struct({
      outcome: Schema.Literal('accepted'),
      blockingIssueCount: Schema.Literal(0),
    }),
    approval: Schema.Literal('approved'),
  }),
});
export type PortablePlanPayload = typeof PortablePlanPayloadSchema.Type;
export const PortablePlanRootSchema = Schema.Struct({
  format: Schema.Literal('threadnote-portable-plan-root'),
  version: Schema.Literal(1),
  project: scopeId,
  team: scopeId,
  payloadHash: hash,
  pages: Schema.Array(Schema.Struct({reference, contentHash: hash})).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});
export type PortablePlanRoot = typeof PortablePlanRootSchema.Type;
const PortablePlanRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  team: scopeId,
  project: scopeId,
  payloadHash: hash,
});
export type PortablePlanRef = typeof PortablePlanRefSchema.Type;

/** Semantic handoff/preferences remain private even when a producer used a durable path. */
export function portableEvidenceBody(
  reference: PortablePlanPayload['evidence'][number]['reference'],
  content: string,
  project: string,
): string {
  const record = parseMemoryDocument(reference.uri, content);
  if (
    sha256HexSync(content) !== reference.revision ||
    record?.metadata.memoryId !== reference.memoryId ||
    record.metadata.project !== project ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active'
  )
    throw fail('portable-plan-conflict', 'Required plan evidence changed identity or revision.');
  let nativeKind: string | undefined;
  if (pipe(record.body, EffectString.includes('<!-- threadnote-authoring:v1 '))) {
    try {
      nativeKind = decodeNativeDocument(decodeAuthoringArtifact(record.body + '\n', Schema.Unknown)).kind;
    } catch {
      throw fail('portable-plan-private', 'Malformed native authoring evidence cannot enter a shared plan.');
    }
  }
  if (
    nativeKind === 'handoff' ||
    (record.metadata.visibility !== 'shared' &&
      !(
        record.metadata.trust === 'approved' &&
        (record.metadata.authority === 'user_approved' || record.metadata.reviewedSupport)
      ))
  )
    throw fail(
      'portable-plan-private',
      'A handoff, preference or unreviewed private memory cannot enter a shared plan.',
    );
  const scrub = applyScrubber(record.body, {redact: false});
  if (scrub.blocker || scrub.redactions.length)
    throw fail('portable-plan-private', 'Required evidence contains material that cannot be shared.');
  return record.body;
}

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const MAX_PAYLOAD_BYTES = 1_250_000;
const MAX_PAGE_BYTES = 24_000;
const encoder = new TextEncoder();

export function encodePortablePlanRef(value: PortablePlanRef): string {
  return (
    'portableplan-v1.' +
    pipe(
      btoa(stableJson(value)),
      EffectString.replaceAll('+', '-'),
      EffectString.replaceAll('/', '_'),
      EffectString.replace(/=+$/u, ''),
    )
  );
}

export function decodePortablePlanRef(value: string): PortablePlanRef {
  if (!pipe(value, EffectString.startsWith('portableplan-v1.')) || value.length > 512)
    throw fail('portable-plan-malformed', 'Provide a current portable plan reference.');
  try {
    const encoded = pipe(
      value,
      EffectString.slice('portableplan-v1.'.length),
      EffectString.replaceAll('-', '+'),
      EffectString.replaceAll('_', '/'),
    );
    const parsed: unknown = JSON.parse(atob(encoded));
    const decoded = Schema.decodeUnknownSync(PortablePlanRefSchema, {onExcessProperty: 'error'})(parsed);
    if (encodePortablePlanRef(decoded) !== value) throw new Error('Noncanonical reference');
    return decoded;
  } catch {
    throw fail('portable-plan-malformed', 'Provide a current portable plan reference.');
  }
}

export function encodePortablePlanPages(payload: PortablePlanPayload): readonly string[] {
  const validated = decodePortablePlanPayload(payload).payload;
  const bytes = encoder.encode(stableJson(validated));
  if (bytes.byteLength > MAX_PAYLOAD_BYTES)
    throw fail('portable-plan-oversized', 'The shared plan payload exceeds its bounded size.');
  const pages: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + 20_000, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    pages.push(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset, end)));
    offset = end;
  }
  if (pages.length > 64) throw fail('portable-plan-oversized', 'The shared plan needs too many bounded pages.');
  return pages;
}

function decodeDocument(text: string, expected: 'plan' | 'spec'): NativeAuthoringDocument {
  let document: NativeAuthoringDocument;
  try {
    document = decodeNativeAuthoringDocument(JSON.parse(text));
  } catch {
    throw fail('portable-plan-malformed', 'The shared authoring document is malformed.');
  }
  if (document.kind !== expected || canonicalAuthoringJson(document) !== text) {
    // The canonical serialization is part of the portable contract: it closes
    // JSON aliases and excess fields before any recipient authoring mutation.
    throw fail('portable-plan-malformed', 'The shared authoring document is not canonical.');
  }
  return document;
}

/** Decode the entire verified snapshot before creating a recipient run or draft. */
export function decodePortablePlanPayload(input: unknown): {
  readonly payload: PortablePlanPayload;
  readonly plan: NativeAuthoringDocument;
  readonly spec?: NativeAuthoringDocument;
} {
  let payload: PortablePlanPayload;
  try {
    payload = Schema.decodeUnknownSync(PortablePlanPayloadSchema, {onExcessProperty: 'error'})(input);
  } catch {
    throw fail('portable-plan-malformed', 'The shared plan payload is malformed or exceeds its bounds.');
  }
  if (encoder.encode(stableJson(payload)).byteLength > MAX_PAYLOAD_BYTES)
    throw fail('portable-plan-oversized', 'The shared plan payload exceeds its bounded size.');
  const privacy = applyScrubber(stableJson(payload), {redact: false});
  if (privacy.blocker || privacy.redactions.length)
    throw fail('portable-plan-private', 'The shared plan contains material that cannot be used.');
  const plan = decodeDocument(payload.plan.document, 'plan');
  if (plan.kind !== 'plan') throw fail('portable-plan-malformed', 'The shared plan has the wrong kind.');
  if (plan.project !== payload.project || nativeAuthoringDigest(plan) !== payload.plan.documentHash)
    throw fail('portable-plan-conflict', 'The shared plan project or document digest changed.');
  if (
    payload.provenance.documentHash !== payload.plan.documentHash ||
    nativeSpecIntentDigest(plan, 2) !== payload.provenance.intentHash
  )
    throw fail('portable-plan-conflict', 'The shared plan provenance differs from its document.');
  const spec = payload.spec ? decodeDocument(payload.spec.document, 'spec') : undefined;
  if (spec && spec.kind !== 'spec')
    throw fail('portable-plan-malformed', 'The linked specification has the wrong kind.');
  if (Boolean(plan.spec) !== Boolean(spec))
    throw fail('portable-plan-missing', 'The linked specification is missing from the shared closure.');
  if (
    spec &&
    (spec.project !== payload.project ||
      spec.id !== plan.id ||
      nativeAuthoringDigest(spec) !== payload.spec?.documentHash ||
      plan.spec?.documentHash !== payload.spec.documentHash ||
      nativeSpecIntentDigest(spec) !== plan.spec?.intentHash ||
      stableJson(spec.requirements) !== stableJson(plan.spec?.requirements) ||
      stableJson(spec.scenarios) !== stableJson(plan.spec?.scenarios))
  )
    throw fail('portable-plan-conflict', 'The linked specification differs from the pinned plan.');
  const evidenceUris = new Set<string>();
  for (const item of payload.evidence) {
    if (sha256HexSync(item.body) !== item.bodyHash)
      throw fail('portable-plan-conflict', 'A shared evidence revision changed.');
    if (evidenceUris.has(item.reference.uri))
      throw fail('portable-plan-malformed', 'The shared evidence inventory contains duplicates.');
    evidenceUris.add(item.reference.uri);
    if (applyScrubber(item.body, {redact: false}).blocker)
      throw fail('portable-plan-private', 'Shared evidence contains material that cannot be published.');
  }
  const required = new Set([
    ...EffectArray.map(plan.context.evidenceRefs, ref => ref.uri),
    ...(spec ? EffectArray.map(spec.context.evidenceRefs, ref => ref.uri) : []),
  ]);
  if (required.size !== payload.evidence.length || EffectArray.some([...required], uri => !evidenceUris.has(uri)))
    throw fail('portable-plan-missing', 'The required plan evidence closure is incomplete.');
  return {payload, plan, ...(spec ? {spec} : {})};
}

/** Join hash-pinned pages before parsing any content; no partial payload is admitted. */
export function decodePortablePlanPages(
  rootInput: unknown,
  pages: readonly {readonly reference: PortablePlanRoot['pages'][number]['reference']; readonly content: string}[],
  expected: {readonly team: string; readonly project: string},
) {
  let root: PortablePlanRoot;
  try {
    root = Schema.decodeUnknownSync(PortablePlanRootSchema, {onExcessProperty: 'error'})(rootInput);
  } catch {
    throw fail('portable-plan-malformed', 'The shared plan root is malformed.');
  }
  if (root.team !== expected.team || root.project !== expected.project)
    throw fail('portable-plan-scope', 'The shared plan belongs to another team or project.');
  if (pages.length !== root.pages.length) throw fail('portable-plan-missing', 'A shared plan page is missing.');
  let body = '';
  for (const [index, page] of pages.entries()) {
    const pinned = root.pages[index];
    if (
      stableJson(page.reference) !== stableJson(pinned.reference) ||
      encoder.encode(page.content).byteLength > MAX_PAGE_BYTES ||
      sha256HexSync(page.content) !== pinned.contentHash
    )
      throw fail('portable-plan-conflict', 'A shared plan page differs from its pinned revision or size.');
    body += page.content;
    if (encoder.encode(body).byteLength > MAX_PAYLOAD_BYTES)
      throw fail('portable-plan-oversized', 'The shared plan payload exceeds its bounded size.');
  }
  if (sha256HexSync(body) !== root.payloadHash)
    throw fail('portable-plan-conflict', 'The shared plan payload digest changed.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail('portable-plan-malformed', 'The shared plan payload is malformed.');
  }
  return decodePortablePlanPayload(parsed);
}

const sharedRelative = (project: string, payloadHash: string, leaf: string) =>
  `durable/projects/${project}/portable-plans/${payloadHash}/${leaf}.md`;
const sharedUri = (config: ShareRuntime, team: string, relative: string) =>
  `threadnote://user/${uriSegment(config.user)}/memories/shared/${team}/${relative}`;
const memoryBody = (project: string, topic: string, body: string, memoryId: string) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      project,
      topic,
      memoryId,
      sourceAgentClient: 'threadnote',
      timestamp: '1970-01-01T00:00:00.000Z',
      visibility: 'shared',
    },
    body,
  );
const pageToBody = (content: string) => btoa(String.fromCharCode(...encoder.encode(content)));
const bodyToPage = (content: string) => {
  try {
    const binary = atob(content);
    if (btoa(binary) !== content) throw new Error('Noncanonical base64');
    return new TextDecoder('utf-8', {fatal: true}).decode(
      Uint8Array.from(binary, char => pipe(char, EffectString.charCodeAt(0), EffectOption.getOrThrow)),
    );
  } catch {
    throw fail('portable-plan-malformed', 'A shared plan page has malformed encoding.');
  }
};

/** Publish dependency pages first, verify their exact bytes, then expose the root. */
export const publishPortablePlanPayload = Effect.fn('workflowAutomation.publishPortablePlanPayload')(function* (
  config: ShareRuntime,
  input: PortablePlanPayload,
  teamName: string,
) {
  const {payload} = decodePortablePlanPayload(input);
  const team = yield* resolveTeam(config, teamName);
  assertShareTeamWritable(team, 'publish portable plans');
  const pages = encodePortablePlanPages(payload);
  const payloadHash = sha256HexSync(stableJson(payload));
  const privacy = applyScrubber(stableJson(payload), {redact: false});
  if (privacy.blocker || privacy.redactions.length)
    return yield* fail('portable-plan-private', 'The plan contains material that cannot be shared.');
  const prepared = EffectArray.map(pages, (content, index) => {
    const relative = sharedRelative(payload.project, payloadHash, `page-${index}`);
    const memoryId = `tn_${pipe(sha256HexSync(relative), EffectString.slice(0, 32))}`;
    const bytes = memoryBody(
      payload.project,
      `portable-plan-${payloadHash}-page-${index}`,
      pageToBody(content),
      memoryId,
    );
    return {
      relative,
      uri: sharedUri(config, team.name, relative),
      bytes,
      contentHash: sha256HexSync(content),
      reference: {uri: sharedUri(config, team.name, relative), memoryId, revision: sha256HexSync(bytes)},
    };
  });
  const root: PortablePlanRoot = {
    format: 'threadnote-portable-plan-root',
    version: 1,
    project: payload.project,
    team: team.name,
    payloadHash,
    pages: EffectArray.map(prepared, page => ({reference: page.reference, contentHash: page.contentHash})),
  };
  const rootRelative = sharedRelative(payload.project, payloadHash, 'root');
  const rootUri = sharedUri(config, team.name, rootRelative);
  const rootBytes = memoryBody(
    payload.project,
    `portable-plan-${payloadHash}-root`,
    stableJson(root),
    `tn_${pipe(sha256HexSync(rootRelative), EffectString.slice(0, 32))}`,
  );
  const writeExact = (relative: string, uri: string, content: string) =>
    Effect.gen(function* () {
      const exists = yield* resourceExists(NATIVE_RESOURCE_BACKEND, config, uri);
      if (exists && (yield* readMemoryContent(config, NATIVE_RESOURCE_BACKEND, uri, false)) !== content)
        return yield* fail('portable-plan-conflict', 'A published plan dependency changed.');
      yield* assertSharedWorktreeFileReady(
        team.config.worktree,
        relative,
        exists ? content : undefined,
        false,
        (left, right) => left === right,
        {exactRetryContent: content},
      );
      if (!exists) {
        yield* ensureSharedDirectoryChain(config, NATIVE_RESOURCE_BACKEND, uri, false);
        yield* writeMemoryFile(config, NATIVE_RESOURCE_BACKEND, uri, content, 'create', false, {quiet: true});
      }
      if ((yield* readMemoryContent(config, NATIVE_RESOURCE_BACKEND, uri, false)) !== content)
        return yield* fail('portable-plan-conflict', 'A published plan dependency failed readback.');
      yield* writeSharedWorktreeFile(team.config.worktree, relative, content);
      yield* publishShareGitChange(
        team.config.worktree,
        relative,
        `share: portable plan ${pipe(payloadHash, EffectString.slice(0, 12))}`,
      );
    });
  for (const page of prepared) yield* writeExact(page.relative, page.uri, page.bytes);
  // Recheck the entire closure just before the root becomes observable.
  for (const page of prepared) {
    const current = yield* readMemoryContent(config, NATIVE_RESOURCE_BACKEND, page.uri, false);
    if (sha256HexSync(current) !== page.reference.revision)
      return yield* fail('portable-plan-conflict', 'A published plan dependency changed before root publication.');
  }
  yield* writeExact(rootRelative, rootUri, rootBytes);
  return {sharedPlanRef: encodePortablePlanRef({version: 1, team: team.name, project: payload.project, payloadHash})};
});

/** Resolve a user-independent ref through this user's synchronized team namespace. */
export const readPortablePlanPayload = Effect.fn('workflowAutomation.readPortablePlanPayload')(function* (
  config: ShareRuntime,
  reference: string,
  project: string,
) {
  const decoded = decodePortablePlanRef(reference);
  if (decoded.project !== project)
    return yield* fail('portable-plan-scope', 'The shared plan belongs to another project.');
  yield* resolveTeam(config, decoded.team).pipe(
    Effect.mapError(() => fail('portable-plan-scope', 'Configure and sync the selected shared team first.')),
  );
  const rootUri = sharedUri(config, decoded.team, sharedRelative(project, decoded.payloadHash, 'root'));
  const rootBytes = yield* readMemoryContent(config, NATIVE_RESOURCE_BACKEND, rootUri, false).pipe(
    Effect.mapError(() => fail('portable-plan-missing', 'Sync the selected team before starting this plan.')),
  );
  const record = parseMemoryDocument(rootUri, rootBytes);
  if (
    !record ||
    record.metadata.visibility !== 'shared' ||
    record.metadata.project !== project ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active'
  )
    return yield* fail('portable-plan-private', 'The shared plan root is not an eligible shared memory.');
  const root = yield* Effect.try({
    try: () => JSON.parse(record.body) as unknown,
    catch: () => fail('portable-plan-malformed', 'The shared plan root is malformed.'),
  });
  const checked = yield* Schema.decodeUnknownEffect(PortablePlanRootSchema, {onExcessProperty: 'error'})(root).pipe(
    Effect.mapError(() => fail('portable-plan-malformed', 'The shared plan root is malformed.')),
  );
  if (checked.payloadHash !== decoded.payloadHash || checked.team !== decoded.team || checked.project !== project)
    return yield* fail('portable-plan-conflict', 'The shared plan root differs from its reference.');
  const pages = [];
  for (const pinned of checked.pages) {
    const localUri = sharedUri(
      config,
      decoded.team,
      sharedRelative(project, decoded.payloadHash, `page-${pages.length}`),
    );
    if (
      pipe(pinned.reference.uri, EffectString.replace(/^threadnote:\/\/user\/[^/]+\//u, '')) !==
      pipe(localUri, EffectString.replace(/^threadnote:\/\/user\/[^/]+\//u, ''))
    )
      return yield* fail('portable-plan-scope', 'A shared plan page belongs to another closure.');
    const bytes = yield* readMemoryContent(config, NATIVE_RESOURCE_BACKEND, localUri, false).pipe(
      Effect.mapError(() => fail('portable-plan-missing', 'A shared plan page is missing. Sync the selected team.')),
    );
    if (sha256HexSync(bytes) !== pinned.reference.revision)
      return yield* fail('portable-plan-conflict', 'A shared plan page revision changed.');
    const page = parseMemoryDocument(localUri, bytes);
    if (
      !page ||
      page.metadata.visibility !== 'shared' ||
      page.metadata.project !== project ||
      page.metadata.kind !== 'durable' ||
      page.metadata.status !== 'active' ||
      page.metadata.memoryId !== pinned.reference.memoryId
    )
      return yield* fail('portable-plan-private', 'A shared plan page has invalid identity or visibility.');
    pages.push({reference: pinned.reference, content: bodyToPage(page.body)});
  }
  return decodePortablePlanPages(checked, pages, {team: decoded.team, project});
});
