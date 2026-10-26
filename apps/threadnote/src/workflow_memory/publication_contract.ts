import {Schema} from 'effect';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {MemoryRelation} from '@threadnote/memory/document';
import type {PreparedSharedMemoryWrite, WriteDurableMemoryParams} from '../mcp/server/memory.js';
import type {ShareGitCommitReceipt, ShareGitPublicationReceipt} from '../share/git.js';
import {portableKey, stableJson, workflowError, type WorkflowBinding} from './protocol.js';

/** Closed diagnostic vocabulary only; never include writer message text. */
export const PublicationWriterReasonSchema = Schema.Literals([
  'commit-content-changed',
  'commit-readback-failed',
  'git-verification-failed',
  'git-commit-failed',
]);

const envelope = {protocolVersion: Schema.Literal(1), bindingId: Schema.String};
export const WorkflowPublicationNodeSchema = Schema.Struct({
  key: Schema.String,
  role: Schema.Literals(['architecture', 'spec']),
  topic: Schema.String,
  body: Schema.String,
  codeRefs: Schema.Array(Schema.String),
  relations: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      nodeKey: Schema.optionalKey(Schema.String),
      uri: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const WorkflowPublicationRequestSchema = Schema.Union([
  Schema.Struct({
    ...envelope,
    action: Schema.Literal('publication-preview'),
    sourceCommit: Schema.String,
    graph: Schema.Struct({nodes: Schema.Array(WorkflowPublicationNodeSchema)}),
  }),
  Schema.Struct({
    ...envelope,
    action: Schema.Literal('publication-approve'),
    approvalDigest: Schema.String,
    decision: Schema.Literals(['approve', 'defer', 'reject']),
    approvalEvidence: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    action: Schema.Literal('publication-publish'),
    approvalDigest: Schema.String,
  }),
]);
export type WorkflowPublicationRequest = typeof WorkflowPublicationRequestSchema.Type;
export type WorkflowPublicationNode = typeof WorkflowPublicationNodeSchema.Type;
export interface PublicationNode {
  readonly input: WorkflowPublicationNode;
  readonly prepared: PreparedSharedMemoryWrite;
  readonly citations: readonly MemoryCodeCitationV1[];
  readonly externalTargets: NonNullable<WriteDurableMemoryParams['expectedSourceContent']>;
}
export interface PublicationStage {
  readonly key: string;
  readonly nodeKey: string;
  readonly prepared: PreparedSharedMemoryWrite;
  readonly operation: 'create' | 'replace';
  readonly sources: NonNullable<WriteDurableMemoryParams['expectedSourceContent']>;
}
export interface PublicationProgress {
  readonly started: true;
  readonly committed?: ShareGitCommitReceipt;
  readonly verified?: ShareGitPublicationReceipt;
}
export interface PublicationIntent {
  readonly version: 1;
  readonly bindingId: string;
  readonly sourceCommit: string;
  readonly requestDigest: string;
  readonly nodes: readonly PublicationNode[];
  readonly stages: readonly PublicationStage[];
}
export interface PublicationJournal {
  readonly intent: PublicationIntent;
  readonly approvalDigest: string;
  readonly decision?: 'approve' | 'defer' | 'reject';
  readonly approvalEvidence?: string;
  readonly progress: Readonly<Record<string, PublicationProgress>>;
}
export const publicationDigest = (intent: PublicationIntent) => sha256HexSync(stableJson(intent));

/** Inspect decoded text too: markdown and embedded JSON are publication content. */
export function assertPublicationText(text: string, binding: WorkflowBinding, sharedRoot: string): void {
  let decoded = text;
  for (let attempt = 0; attempt < 8; attempt++) {
    const unescaped = decoded.replace(/\\([\\/])/gu, '$1');
    const next =
      unescaped !== decoded
        ? unescaped
        : decoded
            .replace(/\\u([0-9a-f]{4})/giu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
            .replace(/\\x([0-9a-f]{2})/giu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
            .replace(/(?:%[0-9a-f]{2})+/giu, value => {
              try {
                return decodeURIComponent(value);
              } catch {
                return value.replace(/%([0-9a-f]{2})/giu, (_, code: string) =>
                  String.fromCharCode(Number.parseInt(code, 16)),
                );
              }
            })
            .replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (_, hex: string, decimal: string) => {
              const value = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
              return value <= 0x10ffff ? String.fromCodePoint(value) : '';
            })
            .replace(
              /&(colon|sol|bsol);/giu,
              (_, name: string) => ({colon: ':', sol: '/', bsol: '\\'})[name.toLowerCase()]!,
            );
    if (next === decoded) break;
    decoded = next;
    if (attempt === 7) throw workflowError('private-publication-content', 'Publication encoding is too deeply nested.');
  }
  const normalized = decoded.replace(/\\/gu, '/').toLowerCase();
  const privatePaths = [binding.home, binding.repo].map(value => value.replace(/\\/gu, '/').toLowerCase());
  if (
    privatePaths.some(value => value.length > 1 && normalized.includes(value)) ||
    /(?:file:\/\/|\b[a-z]:\/|(?:^|[\s"'`(=])~\/|\/(?:users|home|private|tmp|var|volumes|workspace|workspaces)\/)/u.test(
      normalized,
    ) ||
    normalized.includes('/.context/') ||
    normalized.includes('/workflow-memory/')
  )
    throw workflowError('private-publication-content', 'Publication content contains a private local path.');
  const uris = decoded.match(/threadnote:\/\/[^\s"'`<>\])},]+/giu) ?? [];
  for (const uri of uris) {
    let allowed = false;
    try {
      allowed = resourceIdIsWithin(uri, sharedRoot);
    } catch {
      /* Malformed URI is denied. */
    }
    if (!allowed)
      throw workflowError(
        'private-publication-content',
        'Publication references must stay in the selected shared root.',
      );
  }
}

export function normalizePublicationNodes(
  nodes: readonly WorkflowPublicationNode[],
): readonly WorkflowPublicationNode[] {
  if (nodes.length < 1 || nodes.length > 2 || new Set(nodes.map(node => node.role)).size !== nodes.length)
    throw workflowError('invalid-publication-graph', 'Publish one architecture, one spec, or one of each.');
  const keys = new Set<string>();
  for (const node of nodes) {
    portableKey(node.key, 'node key');
    portableKey(node.topic, 'node topic');
    if (keys.has(node.key) || !node.body.trim() || node.body.length > 512 * 1024 || node.codeRefs.length > 8)
      throw workflowError(
        'invalid-publication-graph',
        'Publication nodes require unique keys and bounded nonempty content.',
      );
    keys.add(node.key);
  }
  for (const node of nodes)
    for (const relation of node.relations) {
      if (
        (relation.nodeKey === undefined) === (relation.uri === undefined) ||
        (relation.nodeKey !== undefined && (!keys.has(relation.nodeKey) || relation.nodeKey === node.key))
      )
        throw workflowError(
          'invalid-publication-graph',
          'Relations need one existing distinct node key or one shared URI.',
        );
    }
  return nodes
    .map(node => ({
      ...node,
      body: `${node.body.trim()}\n`,
      codeRefs: [...new Set(node.codeRefs)].sort(),
      relations: [...node.relations].sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

export function publicationPreview(journal: PublicationJournal) {
  const nodeProjection = (node: PublicationNode) => ({
    key: node.input.key,
    canonicalUri: node.prepared.memoryUri,
    memoryId: node.prepared.finalMetadata.memoryId,
    body: node.input.body,
    bodySha256: sha256HexSync(node.input.body),
    relations: node.prepared.finalMetadata.relations ?? ([] as readonly MemoryRelation[]),
    codeCitations: node.citations,
    relationTargets: node.externalTargets.map(target => ({canonicalUri: target.uri, memoryId: target.memoryId})),
  });
  return {
    protocolVersion: 1 as const,
    status: 'ok' as const,
    approvalDigest: journal.approvalDigest,
    sourceCommit: journal.intent.sourceCommit,
    nodes: journal.intent.nodes.map(nodeProjection),
    stages: journal.intent.stages.map(stage => ({
      key: stage.key,
      nodeKey: stage.nodeKey,
      canonicalUri: stage.prepared.memoryUri,
      content: stage.prepared.memory,
    })),
  };
}
