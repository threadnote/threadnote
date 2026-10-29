import {Schema} from 'effect';
import type {ConsolidationProvenance, ConsolidationSource} from '@threadnote/memory/consolidation';
import type {ReviewedMemorySupportV1} from '@threadnote/memory/reviewed-support';
export interface LibrarySearchResponse {
  readonly uris: readonly string[];
  readonly semantic: 'available' | 'unavailable' | 'timed-out' | 'failed';
  readonly warnings: readonly string[];
}

export interface ConsolidationModelOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ConsolidationModelsResponse {
  readonly models: readonly ConsolidationModelOption[];
}

export interface ConsolidationJobResponse {
  readonly sources?: readonly ConsolidationSource[];
  readonly agent: string;
  readonly model?: string;
  readonly draft?: string;
  readonly error?: string;
  readonly id: string;
  readonly sourceUris: readonly string[];
  readonly status: 'completed' | 'failed' | 'running';
}

export type PanelName =
  | 'context'
  | 'context-health'
  | 'dev-skills'
  | 'doctor'
  | 'graph'
  | 'home'
  | 'integrations'
  | 'memory'
  | 'processes'
  | 'reviews'
  | 'shares'
  | 'worksets';
export type SelectId = 'agent' | 'kind' | 'status';
export type ManagerMemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
export type ManagerMemoryStatus = 'active' | 'archived' | 'expired' | 'superseded';

export interface MemoryMetadata {
  readonly reviewedSupport?: ReviewedMemorySupportV1;
  readonly topicMaintenance?: {readonly version: number; readonly sourceKind?: 'code' | 'obsidian'};
  readonly consolidation?: ConsolidationProvenance;
  readonly consolidationError?: string;
  readonly archivedFrom?: string;
  readonly kind: ManagerMemoryKind;
  readonly project?: string;
  readonly sourceAgentClient: string;
  readonly status: ManagerMemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

export interface TreeNode {
  readonly children?: readonly TreeNode[];
  readonly isDir: boolean;
  readonly isShared: boolean;
  readonly isSystem: boolean;
  readonly metadata?: MemoryMetadata;
  readonly modTime?: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sharedTeam?: string;
  readonly size?: number;
  readonly uri: string;
}

export const TreeNodeSchema: Schema.Codec<TreeNode> = Schema.Struct({
  children: Schema.optionalKey(
    Schema.Union([Schema.Undefined, Schema.Array(Schema.suspend((): Schema.Codec<TreeNode> => TreeNodeSchema))]),
  ),
  isDir: Schema.Boolean,
  isShared: Schema.Boolean,
  isSystem: Schema.Boolean,
  metadata: Schema.optionalKey(
    Schema.Union([
      Schema.Undefined,
      Schema.Struct({
        reviewedSupport: Schema.optionalKey(
          Schema.Union([
            Schema.Undefined,
            Schema.Struct({
              type: Schema.Literal('reviewed-memory-support'),
              version: Schema.Literal(1),
              active: Schema.Struct({
                bodyHash: Schema.String,
                paragraphs: Schema.Array(
                  Schema.Struct({
                    ordinal: Schema.Finite,
                    hash: Schema.String,
                    role: Schema.Union([
                      Schema.Literal('descriptive'),
                      Schema.Literal('normative'),
                      Schema.Literal('historical'),
                      Schema.Literal('unknown'),
                    ]),
                    support: Schema.Union([
                      Schema.Literal('direct'),
                      Schema.Literal('contextual'),
                      Schema.Literal('unresolved'),
                    ]),
                    evidenceIds: Schema.Array(Schema.String),
                    scope: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                    validity: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                  }),
                ),
                sources: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    source: Schema.Union([
                      Schema.Struct({
                        kind: Schema.Literal('code'),
                        citation: Schema.Struct({
                          anchorId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                          evidenceRetention: Schema.optionalKey(
                            Schema.Union([
                              Schema.Undefined,
                              Schema.Literal('capsule-retained'),
                              Schema.Literal('unavailable'),
                            ]),
                          ),
                          extractorSet: Schema.String,
                          fileContentHash: Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                          id: Schema.String,
                          path: Schema.String,
                          repositoryId: Schema.String,
                          repositoryIdentityKind: Schema.Union([Schema.Literal('local'), Schema.Literal('remote')]),
                          sourceCommit: Schema.String,
                          sourceDirty: Schema.Boolean,
                          sourceGraphContentId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                          sourceSnapshotId: Schema.String,
                          target: Schema.Union([
                            Schema.Struct({kind: Schema.Literal('file')}),
                            Schema.Struct({
                              fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
                              fragmentHash: Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                              kind: Schema.Literal('symbol'),
                              language: Schema.String,
                              name: Schema.String,
                              nodeId: Schema.String,
                              qualifiedName: Schema.String,
                              signatureHash: Schema.optionalKey(
                                Schema.Union([
                                  Schema.Undefined,
                                  Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                                ]),
                              ),
                              span: Schema.Struct({
                                column: Schema.Finite,
                                endColumn: Schema.Finite,
                                endLine: Schema.Finite,
                                line: Schema.Finite,
                              }),
                              symbolKind: Schema.String,
                            }),
                          ]),
                          version: Schema.Literal(1),
                        }),
                      }),
                      Schema.Struct({
                        kind: Schema.Literal('obsidian'),
                        evidence: Schema.Struct({
                          version: Schema.Literal(1),
                          sourceId: Schema.String,
                          sourceInstanceId: Schema.String,
                          vaultHash: Schema.String,
                          accessHash: Schema.String,
                          noteId: Schema.String,
                          relativePath: Schema.String,
                          revisionHash: Schema.String,
                          sanitizerVersion: Schema.String,
                          fragmentHash: Schema.String,
                          fragmentStart: Schema.Finite,
                          fragmentEnd: Schema.Finite,
                          pinId: Schema.String,
                          expiresAt: Schema.String,
                        }),
                      }),
                      Schema.Struct({
                        kind: Schema.Literal('memory'),
                        uri: Schema.String,
                        memoryId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                        canonicalHash: Schema.String,
                        fragment: Schema.Struct({
                          ordinal: Schema.Finite,
                          hash: Schema.String,
                          startOffset: Schema.Finite,
                          endOffset: Schema.Finite,
                        }),
                      }),
                    ]),
                    scope: Schema.Union([
                      Schema.Literal('personal'),
                      Schema.Literal('shared'),
                      Schema.Literal('external'),
                      Schema.Literal('repository'),
                    ]),
                    locator: Schema.optionalKey(
                      Schema.Union([
                        Schema.Undefined,
                        Schema.Struct({repositoryId: Schema.String, teamId: Schema.String, path: Schema.String}),
                      ]),
                    ),
                  }),
                ),
                acceptance: Schema.Struct({
                  reviewId: Schema.String,
                  approvedAt: Schema.String,
                  targetBeforeHash: Schema.String,
                  preparationDigest: Schema.String,
                  sourceVectorDigest: Schema.String,
                }),
                digest: Schema.String,
              }),
              initialApproval: Schema.optionalKey(
                Schema.Union([
                  Schema.Undefined,
                  Schema.Struct({
                    bodyHash: Schema.String,
                    paragraphs: Schema.Array(
                      Schema.Struct({
                        ordinal: Schema.Finite,
                        hash: Schema.String,
                        role: Schema.Union([
                          Schema.Literal('descriptive'),
                          Schema.Literal('normative'),
                          Schema.Literal('historical'),
                          Schema.Literal('unknown'),
                        ]),
                        support: Schema.Union([
                          Schema.Literal('direct'),
                          Schema.Literal('contextual'),
                          Schema.Literal('unresolved'),
                        ]),
                        evidenceIds: Schema.Array(Schema.String),
                        scope: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                        validity: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                      }),
                    ),
                    sources: Schema.Array(
                      Schema.Struct({
                        id: Schema.String,
                        source: Schema.Union([
                          Schema.Struct({
                            kind: Schema.Literal('code'),
                            citation: Schema.Struct({
                              anchorId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              evidenceRetention: Schema.optionalKey(
                                Schema.Union([
                                  Schema.Undefined,
                                  Schema.Literal('capsule-retained'),
                                  Schema.Literal('unavailable'),
                                ]),
                              ),
                              extractorSet: Schema.String,
                              fileContentHash: Schema.Struct({
                                algorithm: Schema.Literal('sha256'),
                                value: Schema.String,
                              }),
                              id: Schema.String,
                              path: Schema.String,
                              repositoryId: Schema.String,
                              repositoryIdentityKind: Schema.Union([Schema.Literal('local'), Schema.Literal('remote')]),
                              sourceCommit: Schema.String,
                              sourceDirty: Schema.Boolean,
                              sourceGraphContentId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              sourceSnapshotId: Schema.String,
                              target: Schema.Union([
                                Schema.Struct({kind: Schema.Literal('file')}),
                                Schema.Struct({
                                  fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
                                  fragmentHash: Schema.Struct({
                                    algorithm: Schema.Literal('sha256'),
                                    value: Schema.String,
                                  }),
                                  kind: Schema.Literal('symbol'),
                                  language: Schema.String,
                                  name: Schema.String,
                                  nodeId: Schema.String,
                                  qualifiedName: Schema.String,
                                  signatureHash: Schema.optionalKey(
                                    Schema.Union([
                                      Schema.Undefined,
                                      Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                                    ]),
                                  ),
                                  span: Schema.Struct({
                                    column: Schema.Finite,
                                    endColumn: Schema.Finite,
                                    endLine: Schema.Finite,
                                    line: Schema.Finite,
                                  }),
                                  symbolKind: Schema.String,
                                }),
                              ]),
                              version: Schema.Literal(1),
                            }),
                          }),
                          Schema.Struct({
                            kind: Schema.Literal('obsidian'),
                            evidence: Schema.Struct({
                              version: Schema.Literal(1),
                              sourceId: Schema.String,
                              sourceInstanceId: Schema.String,
                              vaultHash: Schema.String,
                              accessHash: Schema.String,
                              noteId: Schema.String,
                              relativePath: Schema.String,
                              revisionHash: Schema.String,
                              sanitizerVersion: Schema.String,
                              fragmentHash: Schema.String,
                              fragmentStart: Schema.Finite,
                              fragmentEnd: Schema.Finite,
                              pinId: Schema.String,
                              expiresAt: Schema.String,
                            }),
                          }),
                          Schema.Struct({
                            kind: Schema.Literal('memory'),
                            uri: Schema.String,
                            memoryId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                            canonicalHash: Schema.String,
                            fragment: Schema.Struct({
                              ordinal: Schema.Finite,
                              hash: Schema.String,
                              startOffset: Schema.Finite,
                              endOffset: Schema.Finite,
                            }),
                          }),
                        ]),
                        scope: Schema.Union([
                          Schema.Literal('personal'),
                          Schema.Literal('shared'),
                          Schema.Literal('external'),
                          Schema.Literal('repository'),
                        ]),
                        locator: Schema.optionalKey(
                          Schema.Union([
                            Schema.Undefined,
                            Schema.Struct({repositoryId: Schema.String, teamId: Schema.String, path: Schema.String}),
                          ]),
                        ),
                      }),
                    ),
                    acceptance: Schema.Struct({
                      reviewId: Schema.String,
                      approvedAt: Schema.String,
                      targetBeforeHash: Schema.String,
                      preparationDigest: Schema.String,
                      sourceVectorDigest: Schema.String,
                    }),
                    digest: Schema.String,
                  }),
                ]),
              ),
              legacyOrigin: Schema.optionalKey(
                Schema.Union([
                  Schema.Undefined,
                  Schema.Struct({
                    version: Schema.Literal(1),
                    revision: Schema.String,
                    body: Schema.String,
                    memoryId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                    kind: Schema.Union([
                      Schema.Literal('durable'),
                      Schema.Literal('handoff'),
                      Schema.Literal('incident'),
                      Schema.Literal('preference'),
                      Schema.Literal('smoke'),
                    ]),
                    status: Schema.Union([
                      Schema.Literal('active'),
                      Schema.Literal('archived'),
                      Schema.Literal('expired'),
                      Schema.Literal('superseded'),
                    ]),
                    headerTitle: Schema.Union([Schema.Literal('MEMORY'), Schema.Literal('HANDOFF')]),
                    codeCitations: Schema.Array(
                      Schema.Struct({
                        anchorId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                        evidenceRetention: Schema.optionalKey(
                          Schema.Union([
                            Schema.Undefined,
                            Schema.Literal('capsule-retained'),
                            Schema.Literal('unavailable'),
                          ]),
                        ),
                        extractorSet: Schema.String,
                        fileContentHash: Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                        id: Schema.String,
                        path: Schema.String,
                        repositoryId: Schema.String,
                        repositoryIdentityKind: Schema.Union([Schema.Literal('local'), Schema.Literal('remote')]),
                        sourceCommit: Schema.String,
                        sourceDirty: Schema.Boolean,
                        sourceGraphContentId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                        sourceSnapshotId: Schema.String,
                        target: Schema.Union([
                          Schema.Struct({kind: Schema.Literal('file')}),
                          Schema.Struct({
                            fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
                            fragmentHash: Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                            kind: Schema.Literal('symbol'),
                            language: Schema.String,
                            name: Schema.String,
                            nodeId: Schema.String,
                            qualifiedName: Schema.String,
                            signatureHash: Schema.optionalKey(
                              Schema.Union([
                                Schema.Undefined,
                                Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                              ]),
                            ),
                            span: Schema.Struct({
                              column: Schema.Finite,
                              endColumn: Schema.Finite,
                              endLine: Schema.Finite,
                              line: Schema.Finite,
                            }),
                            symbolKind: Schema.String,
                          }),
                        ]),
                        version: Schema.Literal(1),
                      }),
                    ),
                    relations: Schema.Array(
                      Schema.Struct({
                        type: Schema.Union([
                          Schema.Literal('depends_on'),
                          Schema.Literal('evidence_for'),
                          Schema.Literal('references'),
                          Schema.Literal('related_to'),
                          Schema.Literal('supersedes'),
                        ]),
                        uri: Schema.String,
                      }),
                    ),
                    topicMaintenance: Schema.optionalKey(
                      Schema.Union([
                        Schema.Undefined,
                        Schema.Struct({
                          version: Schema.Literal(1),
                          memoryId: Schema.String,
                          repositoryId: Schema.String,
                          bodyHash: Schema.String,
                          coverage: Schema.Literal('declared-only'),
                          paragraphs: Schema.Array(
                            Schema.Struct({
                              ordinal: Schema.Finite,
                              hash: Schema.String,
                              role: Schema.Union([
                                Schema.Literal('descriptive'),
                                Schema.Literal('normative'),
                                Schema.Literal('historical'),
                              ]),
                              support: Schema.Union([
                                Schema.Literal('direct'),
                                Schema.Literal('contextual'),
                                Schema.Literal('unresolved'),
                              ]),
                              citationIds: Schema.Array(Schema.String),
                              scope: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              validity: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                            }),
                          ),
                          additionalDependencies: Schema.Array(
                            Schema.Struct({
                              kind: Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]),
                              citationId: Schema.String,
                            }),
                          ),
                        }),
                        Schema.Struct({
                          version: Schema.Literal(2),
                          originCitationIds: Schema.Array(Schema.String),
                          acceptedSources: Schema.Array(
                            Schema.Struct({citationId: Schema.String, acceptedCitationId: Schema.String}),
                          ),
                          memoryId: Schema.String,
                          repositoryId: Schema.String,
                          bodyHash: Schema.String,
                          coverage: Schema.Literal('declared-only'),
                          paragraphs: Schema.Array(
                            Schema.Struct({
                              ordinal: Schema.Finite,
                              hash: Schema.String,
                              role: Schema.Union([
                                Schema.Literal('descriptive'),
                                Schema.Literal('normative'),
                                Schema.Literal('historical'),
                              ]),
                              support: Schema.Union([
                                Schema.Literal('direct'),
                                Schema.Literal('contextual'),
                                Schema.Literal('unresolved'),
                              ]),
                              citationIds: Schema.Array(Schema.String),
                              scope: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              validity: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                            }),
                          ),
                          additionalDependencies: Schema.Array(
                            Schema.Struct({
                              kind: Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]),
                              citationId: Schema.String,
                            }),
                          ),
                        }),
                        Schema.Struct({
                          version: Schema.Literal(3),
                          sourceKind: Schema.Literal('code'),
                          dependencyExpansions: Schema.optionalKey(
                            Schema.Union([
                              Schema.Undefined,
                              Schema.Array(
                                Schema.Struct({
                                  version: Schema.Literal(1),
                                  revision: Schema.String,
                                  proofDigest: Schema.String,
                                  requestDigest: Schema.String,
                                  previousManifestHash: Schema.String,
                                  sourceCommit: Schema.String,
                                  citationIds: Schema.Array(Schema.String),
                                }),
                              ),
                            ]),
                          ),
                          memoryId: Schema.String,
                          repositoryId: Schema.String,
                          bodyHash: Schema.String,
                          coverage: Schema.Literal('declared-only'),
                          paragraphs: Schema.Array(
                            Schema.Struct({
                              ordinal: Schema.Finite,
                              hash: Schema.String,
                              role: Schema.Union([
                                Schema.Literal('descriptive'),
                                Schema.Literal('normative'),
                                Schema.Literal('historical'),
                              ]),
                              support: Schema.Union([
                                Schema.Literal('direct'),
                                Schema.Literal('contextual'),
                                Schema.Literal('unresolved'),
                              ]),
                              citationIds: Schema.Array(Schema.String),
                              scope: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              validity: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                            }),
                          ),
                          additionalDependencies: Schema.Array(
                            Schema.Struct({
                              kind: Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]),
                              citationId: Schema.String,
                            }),
                          ),
                          originCitationIds: Schema.Array(Schema.String),
                          acceptedSources: Schema.Array(
                            Schema.Struct({citationId: Schema.String, acceptedCitationId: Schema.String}),
                          ),
                        }),
                        Schema.Struct({
                          version: Schema.Literal(3),
                          sourceKind: Schema.Literal('obsidian'),
                          memoryId: Schema.String,
                          bodyHash: Schema.String,
                          coverage: Schema.Literal('declared-only'),
                          paragraphs: Schema.Array(
                            Schema.Struct({
                              ordinal: Schema.Finite,
                              hash: Schema.String,
                              role: Schema.Union([
                                Schema.Literal('descriptive'),
                                Schema.Literal('normative'),
                                Schema.Literal('historical'),
                              ]),
                              support: Schema.Union([
                                Schema.Literal('direct'),
                                Schema.Literal('contextual'),
                                Schema.Literal('unresolved'),
                              ]),
                              citationIds: Schema.Array(Schema.String),
                              scope: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              validity: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                            }),
                          ),
                          additionalDependencies: Schema.Tuple([]),
                          originCitationId: Schema.String,
                          activeEvidence: Schema.Struct({
                            version: Schema.Literal(1),
                            sourceId: Schema.String,
                            sourceInstanceId: Schema.String,
                            vaultHash: Schema.String,
                            accessHash: Schema.String,
                            noteId: Schema.String,
                            relativePath: Schema.String,
                            revisionHash: Schema.String,
                            sanitizerVersion: Schema.String,
                            fragmentHash: Schema.String,
                            fragmentStart: Schema.Finite,
                            fragmentEnd: Schema.Finite,
                            pinId: Schema.String,
                            expiresAt: Schema.String,
                          }),
                        }),
                      ]),
                    ),
                    consolidation: Schema.optionalKey(
                      Schema.Union([
                        Schema.Undefined,
                        Schema.Struct({
                          version: Schema.Literal(1),
                          bodyHash: Schema.String,
                          requestHash: Schema.String,
                          sources: Schema.Array(
                            Schema.Struct({
                              uri: Schema.String,
                              revision: Schema.String,
                              memoryId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                              fragments: Schema.Array(Schema.String),
                              codeCitations: Schema.Array(
                                Schema.Struct({
                                  anchorId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                                  evidenceRetention: Schema.optionalKey(
                                    Schema.Union([
                                      Schema.Undefined,
                                      Schema.Literal('capsule-retained'),
                                      Schema.Literal('unavailable'),
                                    ]),
                                  ),
                                  extractorSet: Schema.String,
                                  fileContentHash: Schema.Struct({
                                    algorithm: Schema.Literal('sha256'),
                                    value: Schema.String,
                                  }),
                                  id: Schema.String,
                                  path: Schema.String,
                                  repositoryId: Schema.String,
                                  repositoryIdentityKind: Schema.Union([
                                    Schema.Literal('local'),
                                    Schema.Literal('remote'),
                                  ]),
                                  sourceCommit: Schema.String,
                                  sourceDirty: Schema.Boolean,
                                  sourceGraphContentId: Schema.optionalKey(
                                    Schema.Union([Schema.Undefined, Schema.String]),
                                  ),
                                  sourceSnapshotId: Schema.String,
                                  target: Schema.Union([
                                    Schema.Struct({kind: Schema.Literal('file')}),
                                    Schema.Struct({
                                      fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
                                      fragmentHash: Schema.Struct({
                                        algorithm: Schema.Literal('sha256'),
                                        value: Schema.String,
                                      }),
                                      kind: Schema.Literal('symbol'),
                                      language: Schema.String,
                                      name: Schema.String,
                                      nodeId: Schema.String,
                                      qualifiedName: Schema.String,
                                      signatureHash: Schema.optionalKey(
                                        Schema.Union([
                                          Schema.Undefined,
                                          Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                                        ]),
                                      ),
                                      span: Schema.Struct({
                                        column: Schema.Finite,
                                        endColumn: Schema.Finite,
                                        endLine: Schema.Finite,
                                        line: Schema.Finite,
                                      }),
                                      symbolKind: Schema.String,
                                    }),
                                  ]),
                                  version: Schema.Literal(1),
                                }),
                              ),
                              relations: Schema.Array(
                                Schema.Struct({
                                  type: Schema.Union([
                                    Schema.Literal('depends_on'),
                                    Schema.Literal('evidence_for'),
                                    Schema.Literal('references'),
                                    Schema.Literal('related_to'),
                                    Schema.Literal('supersedes'),
                                  ]),
                                  uri: Schema.String,
                                }),
                              ),
                            }),
                          ),
                          reviews: Schema.Array(
                            Schema.Struct({
                              section: Schema.String,
                              disposition: Schema.Union([
                                Schema.Literal('direct'),
                                Schema.Literal('contextual'),
                                Schema.Literal('unresolved'),
                                Schema.Literal('unsupported'),
                              ]),
                              supports: Schema.Array(
                                Schema.Struct({
                                  sourceUri: Schema.String,
                                  fragment: Schema.Finite,
                                  citationIds: Schema.Array(Schema.String),
                                  relationIndexes: Schema.Array(Schema.Finite),
                                }),
                              ),
                            }),
                          ),
                          operationId: Schema.String,
                          cleanup: Schema.Union([
                            Schema.Literal('archive'),
                            Schema.Literal('forget'),
                            Schema.Literal('keep'),
                          ]),
                          cleanupShared: Schema.Boolean,
                          target: Schema.Struct({
                            kind: Schema.Union([
                              Schema.Literal('durable'),
                              Schema.Literal('handoff'),
                              Schema.Literal('incident'),
                              Schema.Literal('preference'),
                              Schema.Literal('smoke'),
                            ]),
                            status: Schema.Union([
                              Schema.Literal('active'),
                              Schema.Literal('archived'),
                              Schema.Literal('expired'),
                              Schema.Literal('superseded'),
                            ]),
                            project: Schema.String,
                            topic: Schema.String,
                            sourceAgentClient: Schema.String,
                          }),
                        }),
                        Schema.Struct({
                          version: Schema.Literal(2),
                          origin: Schema.Struct({
                            version: Schema.Literal(1),
                            bodyHash: Schema.String,
                            requestHash: Schema.String,
                            sources: Schema.Array(
                              Schema.Struct({
                                uri: Schema.String,
                                revision: Schema.String,
                                memoryId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                                fragments: Schema.Array(Schema.String),
                                codeCitations: Schema.Array(
                                  Schema.Struct({
                                    anchorId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                                    evidenceRetention: Schema.optionalKey(
                                      Schema.Union([
                                        Schema.Undefined,
                                        Schema.Literal('capsule-retained'),
                                        Schema.Literal('unavailable'),
                                      ]),
                                    ),
                                    extractorSet: Schema.String,
                                    fileContentHash: Schema.Struct({
                                      algorithm: Schema.Literal('sha256'),
                                      value: Schema.String,
                                    }),
                                    id: Schema.String,
                                    path: Schema.String,
                                    repositoryId: Schema.String,
                                    repositoryIdentityKind: Schema.Union([
                                      Schema.Literal('local'),
                                      Schema.Literal('remote'),
                                    ]),
                                    sourceCommit: Schema.String,
                                    sourceDirty: Schema.Boolean,
                                    sourceGraphContentId: Schema.optionalKey(
                                      Schema.Union([Schema.Undefined, Schema.String]),
                                    ),
                                    sourceSnapshotId: Schema.String,
                                    target: Schema.Union([
                                      Schema.Struct({kind: Schema.Literal('file')}),
                                      Schema.Struct({
                                        fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
                                        fragmentHash: Schema.Struct({
                                          algorithm: Schema.Literal('sha256'),
                                          value: Schema.String,
                                        }),
                                        kind: Schema.Literal('symbol'),
                                        language: Schema.String,
                                        name: Schema.String,
                                        nodeId: Schema.String,
                                        qualifiedName: Schema.String,
                                        signatureHash: Schema.optionalKey(
                                          Schema.Union([
                                            Schema.Undefined,
                                            Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                                          ]),
                                        ),
                                        span: Schema.Struct({
                                          column: Schema.Finite,
                                          endColumn: Schema.Finite,
                                          endLine: Schema.Finite,
                                          line: Schema.Finite,
                                        }),
                                        symbolKind: Schema.String,
                                      }),
                                    ]),
                                    version: Schema.Literal(1),
                                  }),
                                ),
                                relations: Schema.Array(
                                  Schema.Struct({
                                    type: Schema.Union([
                                      Schema.Literal('depends_on'),
                                      Schema.Literal('evidence_for'),
                                      Schema.Literal('references'),
                                      Schema.Literal('related_to'),
                                      Schema.Literal('supersedes'),
                                    ]),
                                    uri: Schema.String,
                                  }),
                                ),
                              }),
                            ),
                            reviews: Schema.Array(
                              Schema.Struct({
                                section: Schema.String,
                                disposition: Schema.Union([
                                  Schema.Literal('direct'),
                                  Schema.Literal('contextual'),
                                  Schema.Literal('unresolved'),
                                  Schema.Literal('unsupported'),
                                ]),
                                supports: Schema.Array(
                                  Schema.Struct({
                                    sourceUri: Schema.String,
                                    fragment: Schema.Finite,
                                    citationIds: Schema.Array(Schema.String),
                                    relationIndexes: Schema.Array(Schema.Finite),
                                  }),
                                ),
                              }),
                            ),
                            operationId: Schema.String,
                            cleanup: Schema.Union([
                              Schema.Literal('archive'),
                              Schema.Literal('forget'),
                              Schema.Literal('keep'),
                            ]),
                            cleanupShared: Schema.Boolean,
                            target: Schema.Struct({
                              kind: Schema.Union([
                                Schema.Literal('durable'),
                                Schema.Literal('handoff'),
                                Schema.Literal('incident'),
                                Schema.Literal('preference'),
                                Schema.Literal('smoke'),
                              ]),
                              status: Schema.Union([
                                Schema.Literal('active'),
                                Schema.Literal('archived'),
                                Schema.Literal('expired'),
                                Schema.Literal('superseded'),
                              ]),
                              project: Schema.String,
                              topic: Schema.String,
                              sourceAgentClient: Schema.String,
                            }),
                          }),
                          originBody: Schema.String,
                          bodyHash: Schema.String,
                          requestHash: Schema.String,
                          acceptance: Schema.Struct({
                            reviewId: Schema.String,
                            targetBeforeHash: Schema.String,
                            packetDigest: Schema.String,
                            observationRevision: Schema.String,
                            paragraphs: Schema.Array(
                              Schema.Struct({
                                ordinal: Schema.Finite,
                                originOrdinal: Schema.Finite,
                                hash: Schema.String,
                                evidence: Schema.Union([Schema.Literal('origin'), Schema.Literal('reviewed-current')]),
                                citationIds: Schema.Array(Schema.String),
                              }),
                            ),
                          }),
                        }),
                      ]),
                    ),
                    obsidianEvidence: Schema.optionalKey(
                      Schema.Union([
                        Schema.Undefined,
                        Schema.Struct({
                          version: Schema.Literal(1),
                          sourceId: Schema.String,
                          sourceInstanceId: Schema.String,
                          vaultHash: Schema.String,
                          accessHash: Schema.String,
                          noteId: Schema.String,
                          relativePath: Schema.String,
                          revisionHash: Schema.String,
                          sanitizerVersion: Schema.String,
                          fragmentHash: Schema.String,
                          fragmentStart: Schema.Finite,
                          fragmentEnd: Schema.Finite,
                          pinId: Schema.String,
                          expiresAt: Schema.String,
                        }),
                      ]),
                    ),
                    sourceEvidence: Schema.optionalKey(
                      Schema.Union([
                        Schema.Undefined,
                        Schema.Struct({
                          version: Schema.Literal(1),
                          provider: Schema.Union([
                            Schema.Literal('superhuman'),
                            Schema.Literal('pocket'),
                            Schema.Literal('linear'),
                            Schema.Literal('github'),
                          ]),
                          sourceId: Schema.String,
                          sourceInstanceId: Schema.String,
                          resourceUri: Schema.String,
                          accessHash: Schema.String,
                          revisionHash: Schema.String,
                          contentHash: Schema.String,
                          rendererVersion: Schema.String,
                          sanitizerVersion: Schema.String,
                          fragmentHash: Schema.String,
                          fragmentStart: Schema.Finite,
                          fragmentEnd: Schema.Finite,
                          pinId: Schema.String,
                          expiresAt: Schema.String,
                        }),
                      ]),
                    ),
                    digest: Schema.String,
                  }),
                ]),
              ),
            }),
          ]),
        ),
        topicMaintenance: Schema.optionalKey(
          Schema.Union([
            Schema.Undefined,
            Schema.Struct({
              version: Schema.Finite,
              sourceKind: Schema.optionalKey(
                Schema.Union([Schema.Undefined, Schema.Literal('code'), Schema.Literal('obsidian')]),
              ),
            }),
          ]),
        ),
        consolidation: Schema.optionalKey(
          Schema.Union([
            Schema.Undefined,
            Schema.Struct({
              version: Schema.Literal(1),
              bodyHash: Schema.String,
              requestHash: Schema.String,
              sources: Schema.Array(
                Schema.Struct({
                  uri: Schema.String,
                  revision: Schema.String,
                  memoryId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                  fragments: Schema.Array(Schema.String),
                  codeCitations: Schema.Array(
                    Schema.Struct({
                      anchorId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                      evidenceRetention: Schema.optionalKey(
                        Schema.Union([
                          Schema.Undefined,
                          Schema.Literal('capsule-retained'),
                          Schema.Literal('unavailable'),
                        ]),
                      ),
                      extractorSet: Schema.String,
                      fileContentHash: Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                      id: Schema.String,
                      path: Schema.String,
                      repositoryId: Schema.String,
                      repositoryIdentityKind: Schema.Union([Schema.Literal('local'), Schema.Literal('remote')]),
                      sourceCommit: Schema.String,
                      sourceDirty: Schema.Boolean,
                      sourceGraphContentId: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
                      sourceSnapshotId: Schema.String,
                      target: Schema.Union([
                        Schema.Struct({kind: Schema.Literal('file')}),
                        Schema.Struct({
                          fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
                          fragmentHash: Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                          kind: Schema.Literal('symbol'),
                          language: Schema.String,
                          name: Schema.String,
                          nodeId: Schema.String,
                          qualifiedName: Schema.String,
                          signatureHash: Schema.optionalKey(
                            Schema.Union([
                              Schema.Undefined,
                              Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String}),
                            ]),
                          ),
                          span: Schema.Struct({
                            column: Schema.Finite,
                            endColumn: Schema.Finite,
                            endLine: Schema.Finite,
                            line: Schema.Finite,
                          }),
                          symbolKind: Schema.String,
                        }),
                      ]),
                      version: Schema.Literal(1),
                    }),
                  ),
                  relations: Schema.Array(
                    Schema.Struct({
                      type: Schema.Union([
                        Schema.Literal('depends_on'),
                        Schema.Literal('evidence_for'),
                        Schema.Literal('references'),
                        Schema.Literal('related_to'),
                        Schema.Literal('supersedes'),
                      ]),
                      uri: Schema.String,
                    }),
                  ),
                }),
              ),
              reviews: Schema.Array(
                Schema.Struct({
                  section: Schema.String,
                  disposition: Schema.Union([
                    Schema.Literal('direct'),
                    Schema.Literal('contextual'),
                    Schema.Literal('unresolved'),
                    Schema.Literal('unsupported'),
                  ]),
                  supports: Schema.Array(
                    Schema.Struct({
                      sourceUri: Schema.String,
                      fragment: Schema.Finite,
                      citationIds: Schema.Array(Schema.String),
                      relationIndexes: Schema.Array(Schema.Finite),
                    }),
                  ),
                }),
              ),
              operationId: Schema.String,
              cleanup: Schema.Union([Schema.Literal('archive'), Schema.Literal('forget'), Schema.Literal('keep')]),
              cleanupShared: Schema.Boolean,
              target: Schema.Struct({
                kind: Schema.Union([
                  Schema.Literal('durable'),
                  Schema.Literal('handoff'),
                  Schema.Literal('incident'),
                  Schema.Literal('preference'),
                  Schema.Literal('smoke'),
                ]),
                status: Schema.Union([
                  Schema.Literal('active'),
                  Schema.Literal('archived'),
                  Schema.Literal('expired'),
                  Schema.Literal('superseded'),
                ]),
                project: Schema.String,
                topic: Schema.String,
                sourceAgentClient: Schema.String,
              }),
            }),
          ]),
        ),
        consolidationError: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
        archivedFrom: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
        kind: Schema.Union([
          Schema.Literal('durable'),
          Schema.Literal('handoff'),
          Schema.Literal('incident'),
          Schema.Literal('preference'),
          Schema.Literal('smoke'),
        ]),
        project: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
        sourceAgentClient: Schema.String,
        status: Schema.Union([
          Schema.Literal('active'),
          Schema.Literal('archived'),
          Schema.Literal('expired'),
          Schema.Literal('superseded'),
        ]),
        supersedes: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
        timestamp: Schema.String,
        topic: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
      }),
    ]),
  ),
  modTime: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
  name: Schema.String,
  relativePath: Schema.String,
  sharedTeam: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.String])),
  size: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.Finite])),
  uri: Schema.String,
});
export const isTreeNode = Schema.is(TreeNodeSchema);

export interface ShareSummary {
  readonly addedAt: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly default: boolean;
  readonly dirty?: boolean;
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly status?: string;
  readonly warning?: string;
  readonly worktree: string;
}

export interface BulkItemResult {
  readonly error?: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly uri: string;
}

export interface TargetForm {
  kind: ManagerMemoryKind;
  project: string;
  status: ManagerMemoryStatus;
  team: string;
  topic: string;
}

export interface MemoryResponse {
  readonly content: string;
  readonly node: TreeNode;
  readonly record?: {
    readonly body: string;
    readonly content: string;
    readonly metadata: MemoryMetadata;
    readonly uri: string;
  };
}
export interface ReadResponse {
  readonly content: string;
  readonly localMemory?: MemoryResponse;
  readonly output: string;
}

export interface TreeResponse {
  readonly resourcesTree: TreeNode;
  readonly tree: TreeNode;
}

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: 'fail' | 'ok' | 'warn';
}

export type AgentClient = 'claude' | 'codex' | 'copilot' | 'cursor' | 'effect-ai' | 'local-ai';

export interface AgentOption {
  readonly available: boolean;
  readonly command?: string;
  readonly id: AgentClient;
  readonly label: string;
}

export interface StateResponse {
  readonly agents: readonly AgentOption[];
  readonly autoUpdate: {
    readonly effectivePolicy: 'automatic' | 'notify';
    readonly lastFailure?: {readonly attempt: number; readonly failedAt: string; readonly summary: string};
    readonly lastSuccess?: {
      readonly completedAt: string;
      readonly fromVersion: string;
      readonly repairRequired: boolean;
      readonly toVersion: string;
    };
    readonly running?: {readonly attempt: number; readonly fromVersion: string; readonly startedAt: string};
  };
  readonly config: {
    readonly account: string;
    readonly agentContextHome: string;
    readonly user: string;
  };
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly version: string;
}
