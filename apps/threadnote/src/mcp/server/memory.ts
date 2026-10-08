import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {DateTime, Effect, FileSystem, Path, Result} from 'effect';
import {
  type ArchiveAction,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  parseMemoryDocument,
  type MemoryRecord,
} from '@threadnote/memory/hygiene';
import {applyAtomicExactDuplicateActions} from '../../memory/hygiene/apply.js';
import {
  ensureSharedDirectoryChain,
  assertShareTeamWritable,
  assertSharedWorktreeFileReady,
  isInSharedNamespace,
  publishShareGitChange,
  resolveTeam,
  applyScrubber,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  stripPersonalProvenanceForSharedPublication,
  resourceUriToWorktreeRelative,
  setMemoryVisibility,
  sharedUriFor,
  writeMemoryFile,
  writeMemoryFileChecked,
  writeSharedWorktreeFile,
} from '../../share/index.js';
import {currentPackageVersion, safeTimestamp, sha256} from '../../utils.js';
import {errorMessage} from '@threadnote/platform/errors';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {syncSharedReposBeforeAgentRead} from '../../effect/share.js';
import {withSharedRepositoryLock} from '../../effect/share/lock.js';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  MemoryRelationWriteError,
  memoryIdentityWriteLockKeys,
  verifyAuthoredMemoryRelationTargetIdentities,
} from '../../memory/relations.js';
import {
  discardDeferredCodeAnchorIntent,
  discardDeferredCodeAnchorIntentsWithin,
  discardOtherDeferredCodeAnchorIntents,
  stageDeferredCodeAnchorIntent,
  type DeferredCodeAnchorWriteRequest,
  withDeferredCodeAnchorMutationLocks,
} from '../../memory/deferred/code_anchor.js';
import {isMemoryRelocationUri, readMemoryWithRelocations, recordMemoryRelocation} from '@threadnote/memory/relocation';
import {resolveLocalMemoryReplacementTarget} from '../../memory/replacement_target.js';
import {
  canonicalResourceUri,
  parseResourceId,
  resourceIdIsManagedMemoryNamespace,
  resourceIdIsWithin,
  resourceIdWithoutAnchor,
} from '@threadnote/store/resource-id';
import type {CursorCloudShareScope} from '../../cursor/cloud.js';
import {
  McpServerOperationError,
  type RuntimeConfig,
  argumentError,
  mcpErrorResult,
  normalizeOptionalMetadata,
  optionalResourceUri,
  rejectLeadingDash,
  requiredText,
  uriSegment,
} from './common.js';
import {memoryReadErrorResult} from './memory_read_recovery.js';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
export function registerCompactTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'compact_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Plan or apply scoped Threadnote memory hygiene. Audits personal and shared memories, but apply only mutates personal memories; defaults to dry-run.',
      inputSchema: {
        apply: McpInput.boolean('Apply the compact plan; defaults to false'),
        dryRun: McpInput.boolean('Keep the call read-only; defaults to true unless apply=true'),
        kind: McpInput.literals(['durable', 'handoff', 'incident'], 'Optional memory kind filter'),
        project: McpInput.string('Required project/repo namespace, for example threadnote'),
        topic: McpInput.string('Optional stable topic name'),
      },
    },
    ({apply, dryRun, kind, project, topic}) => {
      const checkedProject = requiredText(project, 'compact_context', 'project', {project: 'threadnote'});
      if (!checkedProject.ok) {
        return checkedProject.error;
      }
      if (apply === true && dryRun === true) {
        return {
          content: [{type: 'text', text: 'compact_context cannot combine apply=true with dryRun=true.'}],
          isError: true,
        };
      }
      return Effect.gen(function* () {
        const sharedAudit = yield* syncSharedMemoriesForCompact(config);
        const records = yield* scopedCompactRecords(config, {
          kind: kind,
          project: checkedProject.value,
        });
        const plan = buildCompactPlan(records, {
          kind: kind,
          project: checkedProject.value,
          topic: normalizeOptionalMetadata(topic),
        });
        const shouldApply = apply === true;
        const planText = [
          formatCompactPlan(plan, {apply: shouldApply}),
          '',
          formatSharedCompactAudit(sharedAudit),
        ].join('\n');
        if (!shouldApply) {
          return {content: [{type: 'text', text: planText}]};
        }

        const plannedActions = [...plan.keepUpdates, ...plan.archives, ...plan.forgets];
        const currentByUri = new Map(
          (yield* readMemoryRecordsByUri(
            config,
            plannedActions.map(action => action.uri),
          )).map(record => [record.uri, record.content]),
        );
        const changed = plannedActions.find(action => currentByUri.get(action.uri) !== action.expectedContent);
        if (changed) {
          return argumentError(`Memory ${changed.uri} changed after compact_context planned it. Re-run the plan.`);
        }

        const invalidatedUris = plannedActions.map(action => action.uri);
        return yield* Effect.gen(function* () {
          const ov = 'threadnote-native';
          const appliedMessages: string[] = [];
          const exactDuplicateApply = yield* applyAtomicExactDuplicateActions(config, plan, records);
          const atomicallyUpdatedUris = new Set(exactDuplicateApply.updatedSurvivorUris);
          for (const uri of exactDuplicateApply.updatedSurvivorUris) {
            appliedMessages.push(`Updated kept memory: ${uri}`);
          }
          for (const action of plan.keepUpdates.filter(candidate => !atomicallyUpdatedUris.has(candidate.uri))) {
            const keepResult = yield* writeMemoryContentWithExpectedHash(
              config,
              ov,
              action.uri,
              action.content,
              action.expectedContent,
            );
            if (keepResult.isError === true) {
              return keepResult;
            }
            appliedMessages.push(`Updated kept memory: ${action.uri}`);
          }
          for (const action of plan.archives) {
            const archiveResult = yield* archiveMemoryForCompact(config, action, {
              deferRecallIndexRefresh: true,
              invalidatedUris,
            });
            if (archiveResult.isError === true) {
              return archiveResult;
            }
            const [content] = archiveResult.content;
            if (content?.type === 'text') {
              appliedMessages.push(content.text);
            }
          }
          for (const uri of exactDuplicateApply.forgottenUris) {
            appliedMessages.push(`Forgot exact duplicate: ${uri}`);
          }
          return {
            content: [
              {
                type: 'text',
                text: [planText, '', 'Applied actions:', ...appliedMessages.map(message => `- ${message}`)].join('\n'),
              },
            ],
          };
        }).pipe(
          Effect.ensuring(
            refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris).pipe(Effect.asVoid),
          ),
        );
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}

export function archiveMemoryForCompact(
  config: RuntimeConfig,
  action: ArchiveAction,
  options: {readonly deferRecallIndexRefresh?: boolean; readonly invalidatedUris?: string[]} = {},
) {
  const invalidatedUris = options.invalidatedUris ?? [action.uri];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [action.uri],
      Effect.gen(function* () {
        const [source] = yield* readMemoryRecordsByUri(config, [action.uri]);
        if (!source) {
          return {content: [{type: 'text', text: `Could not read ${action.uri} before archiving.`}], isError: true};
        }
        if (source.content !== action.expectedContent) {
          return argumentError(`Memory ${action.uri} changed after compact_context planned it. Re-run the plan.`);
        }
        const schemaRewriteError = memorySchemaRewriteError(source.content);
        if (schemaRewriteError) {
          return argumentError(schemaRewriteError.message);
        }
        if (source.metadata.citationErrors && source.metadata.citationErrors.length > 0) {
          const reasons = [...new Set(source.metadata.citationErrors.map(error => error.reason))].sort().join(', ');
          return argumentError(
            `Cannot archive ${action.uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`,
          );
        }
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const archiveResult = yield* writeDurableMemory(config, {
          bodyText: memoryArchiveBody(source.body),
          deferRecallIndexRefresh: true,
          metadata: memoryArchiveMetadata(source.metadata, {
            archivedFrom: action.uri,
            kind: action.kind,
            project: action.project,
            sourceAgentClient: 'mcp',
            timestamp,
            topic: action.topic,
          }),
          skipMemoryIdentityLock: true,
        });
        if (archiveResult.isError === true) {
          return archiveResult;
        }
        const archiveUri = memoryUriFromWriteResult(archiveResult);
        if (!archiveUri) {
          return {
            content: [{type: 'text', text: `Archive write for ${action.uri} did not report its destination URI.`}],
            isError: true,
          };
        }
        invalidatedUris.push(archiveUri);
        const [currentSource] = yield* readMemoryRecordsByUri(config, [action.uri]);
        if (!currentSource || currentSource.content !== action.expectedContent) {
          const rolledBack = yield* forgetResourceWithRetry(config, archiveUri);
          return {
            content: [
              {
                type: 'text',
                text: rolledBack
                  ? `Memory ${action.uri} changed while its archive was being stored. The archived copy was rolled back; re-run compact_context.`
                  : `Memory ${action.uri} changed while its archive was being stored. The source was preserved, but cleanup of ${archiveUri} needs review.`,
              },
            ],
            isError: true,
          };
        }
        const removedOriginal = yield* forgetResourceWithRetry(config, action.uri, false, action.expectedContent, true);
        const [content] = archiveResult.content;
        const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
        return {
          content: [
            {
              type: 'text',
              text: removedOriginal
                ? `${text}\nArchived original memory: ${action.uri}`
                : `${text}\nArchive stored and the original is no longer present: ${action.uri}`,
            },
          ],
          structuredContent: {memoryUri: archiveUri},
        } satisfies CallToolResult;
      }),
    );
    return result;
  }).pipe(
    Effect.ensuring(
      options.deferRecallIndexRefresh
        ? Effect.void
        : refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris).pipe(Effect.asVoid),
    ),
  );
}

interface CompactSharedAudit {
  readonly syncedTeams: readonly string[];
  readonly warnings: readonly string[];
}

const syncSharedMemoriesForCompact = Effect.fn('mcpServer.syncSharedMemoriesForCompact')(function* (
  config: RuntimeConfig,
) {
  return yield* syncSharedReposBeforeAgentRead(config).pipe(
    Effect.catch(error =>
      Effect.succeed({
        syncedTeams: [] as readonly string[],
        warnings: [`Shared-memory refresh failed: ${errorMessage(error)}`] as readonly string[],
      }),
    ),
  );
});

function formatSharedCompactAudit(audit: CompactSharedAudit): string {
  return [
    'Shared audit source:',
    '- bounded auto-sync attempted before scanning local canonical mirrors',
    audit.syncedTeams.length > 0 ? `- refreshed teams: ${audit.syncedTeams.join(', ')}` : '- refreshed teams: none',
    '- freshness note: repository contention may defer refresh; hygiene actions never mutate shared memories',
    ...audit.warnings.map(warning => `- warning: ${warning}`),
  ].join('\n');
}

function memoryUriFromWriteResult(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const structuredContent = Reflect.get(result, 'structuredContent') as {readonly memoryUri?: unknown} | undefined;
  const memoryUri = structuredContent?.memoryUri;
  return typeof memoryUri === 'string' ? memoryUri : undefined;
}

const scopedCompactRecords = Effect.fn('mcpServer.scopedCompactRecords')(function* (
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directories = [
      {
        directory: yield* localMemoryDirectoryForCompact(config, kind, options.project),
        uriDirectory: memoryUriDirectoryForCompact(config, kind, options.project),
      },
      ...(yield* sharedMemoryDirectoriesForCompact(config, kind, options.project)),
    ];
    for (const {directory, uriDirectory} of directories) {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
      if (entries._tag === 'None') {
        continue;
      }
      for (const entry of entries.value) {
        if (entry.startsWith('.') || !entry.endsWith('.md')) {
          continue;
        }
        const entryPath = path.join(directory, entry);
        const info = yield* fs.stat(entryPath).pipe(Effect.option);
        if (info._tag === 'None' || info.value.type !== 'File') {
          continue;
        }
        const content = yield* readTextIfExists(entryPath);
        if (!content) {
          continue;
        }
        const record = parseMemoryDocument(`${uriDirectory}/${entry}`, content);
        if (record) {
          records.push(record);
        }
      }
    }
  }
  return records;
});

const sharedMemoryDirectoriesForCompact = Effect.fn('mcpServer.sharedMemoryDirectoriesForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedRoot = path.join(yield* localUserMemoriesRoot(config), 'shared');
  const teamEntries = yield* fs.readDirectory(sharedRoot).pipe(Effect.option);
  if (teamEntries._tag === 'None') return [];
  const projectSegment = uriSegment(project);
  const relativeParts = compactMemoryDirectoryParts(kind, projectSegment);
  const baseUri = `threadnote://user/${uriSegment(config.user)}/memories/shared`;
  const directories: Array<{readonly directory: string; readonly uriDirectory: string}> = [];
  for (const team of [...teamEntries.value].sort()) {
    if (team.startsWith('.')) continue;
    const teamRoot = path.join(sharedRoot, team);
    const teamInfo = yield* fs.stat(teamRoot).pipe(Effect.option);
    if (teamInfo._tag === 'None' || teamInfo.value.type !== 'Directory') continue;
    directories.push({
      directory: path.join(teamRoot, ...relativeParts),
      uriDirectory: `${baseUri}/${team}/${relativeParts.join('/')}`,
    });
  }
  return directories;
});

export const readMemoryRecordsByUri = Effect.fn('mcpServer.readMemoryRecordsByUri')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const records = yield* Effect.forEach(
    uris,
    uri =>
      Effect.gen(function* () {
        const localPath = yield* localMemoryPathForUri(config, uri);
        if (!localPath) return undefined;
        const content = yield* readTextIfExists(localPath);
        if (!content) return undefined;
        return parseMemoryDocument(uri, content);
      }),
    {concurrency: 16},
  );
  return records.filter((record): record is MemoryRecord => record !== undefined);
});

const localMemoryDirectoryForCompact = Effect.fn('mcpServer.localMemoryDirectoryForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  return path.join(root, ...compactMemoryDirectoryParts(kind, projectSegment));
});

function memoryUriDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(project);
  return `${base}/${compactMemoryDirectoryParts(kind, projectSegment).join('/')}`;
}

function compactMemoryDirectoryParts(kind: CompactableMemoryKind, projectSegment: string): readonly string[] {
  switch (kind) {
    case 'durable':
      return ['durable', 'projects', projectSegment];
    case 'handoff':
      return ['handoffs', 'active', projectSegment];
    case 'incident':
      return ['incidents', 'active', projectSegment];
  }
}

const localMemoryPathForUri = Effect.fn('mcpServer.localMemoryPathForUri')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...relative.split('/'));
});

const localUserMemoriesRoot = Effect.fn('mcpServer.localUserMemoriesRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'data', config.account, 'user', uriSegment(config.user), 'memories');
});

const readTextIfExists = Effect.fn('mcpServer.readTextIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
});

export interface WriteDurableMemoryParams {
  readonly bodyText: string;
  readonly deferredCodeAnchor?: DeferredCodeAnchorWriteRequest;
  /** Composite mutations refresh once from their final state after every enclosing lock is released. */
  readonly deferRecallIndexRefresh?: boolean;
  readonly expectedReplaceContent?: string;
  readonly expectedReplaceContentHash?: string;
  readonly expectedReplaceMemoryId?: string;
  readonly expectedSourceContent?: readonly {
    readonly allowedUriScopes?: readonly string[];
    readonly content: string;
    readonly memoryId?: string;
    readonly uri: string;
  }[];
  readonly metadata: MemoryMetadata;
  readonly operation?: 'create' | 'replace' | 'upsert';
  readonly prepared?: PreparedPersonalMemoryWrite;
  readonly replaceUri?: string;
  readonly skipMemoryIdentityLock?: boolean;
}

interface PreparedPersonalMemoryWrite {
  readonly expectedReplaceContent?: string;
  readonly finalMetadata: MemoryMetadata;
  readonly isInPlaceUpdate: boolean;
  readonly memory: string;
  readonly memoryUri: string;
}

export function writeDurableMemory(config: RuntimeConfig, inputParams: WriteDurableMemoryParams) {
  return Effect.gen(function* () {
    const replacement = inputParams.replaceUri
      ? yield* resolveLocalMemoryReplacementTarget(config, inputParams.replaceUri)
      : undefined;
    const replacementMemoryId =
      inputParams.expectedReplaceMemoryId ?? replacement?.memoryId ?? inputParams.metadata.memoryId;
    const params: WriteDurableMemoryParams = {
      ...inputParams,
      expectedReplaceContent: inputParams.expectedReplaceContent ?? replacement?.record?.content,
      expectedReplaceMemoryId: replacementMemoryId,
      metadata:
        replacementMemoryId === inputParams.metadata.memoryId
          ? inputParams.metadata
          : {...inputParams.metadata, memoryId: replacementMemoryId},
      replaceUri: replacement?.canonicalUri ?? inputParams.replaceUri,
    };
    const result = (yield* writeDurableMemoryResolved(config, params)) as CallToolResult;
    if (result.isError !== true && !params.deferRecallIndexRefresh) {
      const memoryUri = memoryUriFromWriteResult(result);
      const invalidatedUris = [memoryUri, params.replaceUri].filter((uri): uri is string => uri !== undefined);
      if (invalidatedUris.length > 0) {
        yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris);
      }
    }
    return result;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(error instanceof MemoryRelationWriteError ? argumentError(error.message) : mcpErrorResult(error)),
    ),
  );
}

function writeDurableMemoryResolved(config: RuntimeConfig, params: WriteDurableMemoryParams) {
  const write = Effect.gen(function* () {
    const prepared = params.prepared ?? (yield* preparePersonalMemoryWrite(config, params));
    const fs = yield* FileSystem.FileSystem;
    const uris = [
      params.replaceUri,
      prepared.memoryUri,
      ...(params.expectedSourceContent ?? []).map(source => source.uri),
      ...(params.skipMemoryIdentityLock === true
        ? []
        : memoryIdentityWriteLockKeys(prepared.finalMetadata.memoryId, params.expectedSourceContent ?? [])),
    ];
    const mutation = Effect.gen(function* () {
      const ov = 'threadnote-native';
      const expectedReplaceContent = params.expectedReplaceContent ?? prepared.expectedReplaceContent;
      if (params.operation === 'replace' && !params.replaceUri) {
        return argumentError('A replace write requires replaceUri.');
      }
      const [currentReplaceTarget] = params.replaceUri
        ? yield* readMemoryRecordsByUri(config, [params.replaceUri])
        : [];
      if (params.replaceUri) {
        if (!currentReplaceTarget) {
          return argumentError(`Memory ${params.replaceUri} no longer exists.`);
        }
        const schemaRewriteError = memorySchemaRewriteError(currentReplaceTarget.content);
        if (schemaRewriteError) return argumentError(schemaRewriteError.message);
        if (expectedReplaceContent !== undefined && currentReplaceTarget.content !== expectedReplaceContent) {
          return argumentError(
            `Memory ${params.replaceUri} changed while its replacement was being prepared. Retry the update.`,
          );
        }
      }
      if (params.replaceUri && params.expectedReplaceContentHash) {
        if (
          !currentReplaceTarget ||
          (yield* sha256Hex(canonicalMemoryDocumentContent(currentReplaceTarget.content))) !==
            params.expectedReplaceContentHash
        ) {
          return argumentError(
            `Candidate replacement is stale because ${params.replaceUri} changed after review. Run review_session_context again before replacing it.`,
          );
        }
      }
      for (const source of params.expectedSourceContent ?? []) {
        const [currentSource] = yield* readMemoryRecordsByUri(config, [source.uri]);
        if (!currentSource || currentSource.content !== source.content) {
          return argumentError(
            `Memory ${source.uri} changed after this mutation was planned. Re-run the operation before writing.`,
          );
        }
      }
      yield* verifyAuthoredMemoryRelationTargetIdentities(config, params.expectedSourceContent ?? []);
      if (params.replaceUri && isInSharedNamespace(config, params.replaceUri)) {
        if (params.deferredCodeAnchor) {
          return argumentError('Deferred code anchors are private-local and cannot update shared memory.');
        }
        return yield* writeSharedMemoryReplacement(
          config,
          ov,
          {...params, metadata: prepared.finalMetadata},
          params.replaceUri,
        );
      }
      const {finalMetadata, isInPlaceUpdate, memory, memoryUri} = prepared;
      const destinationExists = yield* resourceExists(ov, config, memoryUri);
      const [destinationRecord] = destinationExists ? yield* readMemoryRecordsByUri(config, [memoryUri]) : [];
      if (destinationExists && !destinationRecord) {
        return argumentError(`Existing destination ${memoryUri} is not a readable canonical memory.`);
      }
      if (destinationRecord) {
        const schemaRewriteError = memorySchemaRewriteError(destinationRecord.content);
        if (schemaRewriteError) return argumentError(schemaRewriteError.message);
      }
      if (destinationExists && !params.replaceUri) {
        return argumentError(
          `Memory ${memoryUri} already exists. Pass replaceUri: "${memoryUri}" to update it explicitly.`,
        );
      }
      if (destinationExists && params.replaceUri !== memoryUri) {
        const sameReviewedCandidate =
          params.operation === 'replace' &&
          params.metadata.candidateId !== undefined &&
          destinationRecord?.metadata.candidateId === params.metadata.candidateId;
        if (!sameReviewedCandidate) {
          return argumentError(`Replacement destination already contains another memory: ${memoryUri}.`);
        }
      }
      const directoryUri = memoryDirectoryUri(config, finalMetadata);
      yield* ensureMemoryDirectory(ov, config, directoryUri);
      const writeMode =
        params.operation === 'create'
          ? 'create'
          : params.operation === 'replace'
            ? destinationExists
              ? 'replace'
              : 'create'
            : yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
      const stagedDeferredCodeAnchor = params.deferredCodeAnchor
        ? yield* stageDeferredCodeAnchorIntent(config, {
            memoryContent: memory,
            memoryMetadata: finalMetadata,
            memoryUri,
            request: params.deferredCodeAnchor,
          })
        : undefined;
      yield* params.expectedSourceContent?.length
        ? writeMemoryFileChecked(
            config,
            ov,
            memoryUri,
            memory,
            writeMode,
            false,
            verifyAuthoredMemoryRelationTargetIdentities(config, params.expectedSourceContent),
            {quiet: true},
          )
        : writeMemoryFile(config, ov, memoryUri, memory, writeMode, false, {quiet: true});
      if (params.replaceUri && !isInPlaceUpdate && currentReplaceTarget) {
        yield* recordMemoryRelocation(config, {
          fromContent: currentReplaceTarget.content,
          fromUri: params.replaceUri,
          toContent: memory,
          toUri: memoryUri,
        });
      }
      if (stagedDeferredCodeAnchor) {
        yield* discardOtherDeferredCodeAnchorIntents(config, memoryUri, stagedDeferredCodeAnchor.intentId);
        if (params.replaceUri && params.replaceUri !== memoryUri) {
          yield* discardDeferredCodeAnchorIntent(config, params.replaceUri);
        }
      } else {
        yield* discardDeferredCodeAnchorIntent(config, memoryUri);
        if (params.replaceUri && params.replaceUri !== memoryUri) {
          yield* discardDeferredCodeAnchorIntent(config, params.replaceUri);
        }
      }
      const messages = [`Stored memory: ${memoryUri}`];
      let replacementCleanupPending = false;
      if (params.replaceUri && !isInPlaceUpdate) {
        const removedReplacedMemory = yield* removeResourceWithRetry(ov, config, params.replaceUri);
        replacementCleanupPending = !removedReplacedMemory;
        messages.push(
          removedReplacedMemory
            ? `Forgot replaced memory: ${params.replaceUri}`
            : `Replacement stored, but superseded memory is still processing. Retry later with forget: ${params.replaceUri}`,
        );
      } else if (isInPlaceUpdate) {
        messages.push(`Updated existing memory in place: ${memoryUri}`);
      }
      return {
        content: [{type: 'text' as const, text: messages.join('\n')}],
        structuredContent: {memoryUri, replacementCleanupPending},
      };
    });
    return yield* params.deferredCodeAnchor
      ? withDeferredCodeAnchorMutationLocks(fs, config, uris, mutation)
      : withMemoryUriLocks(fs, config.agentContextHome, uris, mutation);
  });
  const serializedWrite =
    params.replaceUri && isInSharedNamespace(config, params.replaceUri)
      ? withSharedRepositoryLock(config, write)
      : write;
  return serializedWrite;
}

export function writeCursorCloudSharedMemory(
  config: RuntimeConfig,
  scope: CursorCloudShareScope,
  params: WriteDurableMemoryParams,
) {
  const write = withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      if (params.metadata.kind !== 'durable') {
        return argumentError('Cursor Cloud shared memory writes support durable memories only.');
      }
      if (params.deferredCodeAnchor) {
        return argumentError('Deferred code anchors are private-local and cannot write shared memory.');
      }
      const prepared = yield* preparePersonalMemoryWrite(config, params);
      const targetUri = params.replaceUri ?? sharedUriFor(config, prepared.memoryUri, scope.team);
      if (!resourceIdIsWithin(targetUri, scope.root)) {
        return argumentError(`Cursor Cloud durable memory writes must stay within ${scope.root}.`);
      }
      const resolved = yield* resolveTeam(config, scope.team);
      assertShareTeamWritable(resolved, 'write Cursor Cloud memories');
      const fs = yield* FileSystem.FileSystem;
      return yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [
          targetUri,
          ...(params.expectedSourceContent ?? []).map(source => source.uri),
          ...memoryIdentityWriteLockKeys(prepared.finalMetadata.memoryId, params.expectedSourceContent ?? []),
        ],
        Effect.gen(function* () {
          for (const source of params.expectedSourceContent ?? []) {
            const [currentSource] = yield* readMemoryRecordsByUri(config, [source.uri]);
            if (!currentSource || currentSource.content !== source.content) {
              return argumentError('A relation target changed during the write; refresh memory and retry.');
            }
          }
          yield* verifyAuthoredMemoryRelationTargetIdentities(config, params.expectedSourceContent ?? []);
          const [existingTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
          if (params.replaceUri && !existingTarget) {
            return argumentError(`Shared memory ${targetUri} no longer exists.`);
          }
          if (params.replaceUri && existingTarget) {
            const schemaRewriteError = memorySchemaRewriteError(existingTarget.content);
            if (schemaRewriteError) return argumentError(schemaRewriteError.message);
            if (
              prepared.expectedReplaceContent !== undefined &&
              existingTarget.content !== prepared.expectedReplaceContent
            ) {
              return argumentError(
                `Memory ${targetUri} changed while its replacement was being prepared. Retry the update.`,
              );
            }
          }
          const metadata: MemoryMetadata = {
            ...prepared.finalMetadata,
            createdAt:
              existingTarget?.metadata.createdAt ??
              existingTarget?.metadata.timestamp ??
              prepared.finalMetadata.createdAt,
            memoryId: existingTarget?.metadata.memoryId ?? prepared.finalMetadata.memoryId,
            supersedes: undefined,
            visibility: 'shared',
          };
          const rawMemory = setMemoryVisibility(formatMemoryDocument('MEMORY', metadata, params.bodyText), 'shared');
          const scrub = applyScrubber(rawMemory, {redact: false});
          if (scrub.blocker) {
            return argumentError(
              `Refusing to write shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
            );
          }
          const relativePath = resourceUriToWorktreeRelative(config, targetUri, resolved.name);
          yield* assertSharedWorktreeFileReady(resolved.config.worktree, relativePath, existingTarget?.content);
          yield* ensureSharedDirectoryChain(config, 'threadnote-native', targetUri, false, {quiet: true});
          yield* params.expectedSourceContent?.length
            ? writeMemoryFileChecked(
                config,
                'threadnote-native',
                targetUri,
                scrub.cleaned,
                existingTarget ? 'replace' : 'create',
                false,
                verifyAuthoredMemoryRelationTargetIdentities(config, params.expectedSourceContent),
                {quiet: true},
              )
            : writeMemoryFile(
                config,
                'threadnote-native',
                targetUri,
                scrub.cleaned,
                existingTarget ? 'replace' : 'create',
                false,
                {quiet: true},
              );
          const [storedTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
          if (
            !storedTarget ||
            canonicalMemoryDocumentContent(storedTarget.content) !== canonicalMemoryDocumentContent(scrub.cleaned)
          ) {
            return argumentError(`Shared memory verification failed after writing ${targetUri}.`);
          }
          yield* writeSharedWorktreeFile(resolved.config.worktree, relativePath, scrub.cleaned);
          const gitMessages = yield* publishShareGitChange(
            resolved.config.worktree,
            relativePath,
            `cloud: ${existingTarget ? 'update' : 'store'} ${relativePath}`,
          );
          const messages = [`${existingTarget ? 'Updated' : 'Stored'} shared memory: ${targetUri}`, ...gitMessages];
          return {
            _meta: {
              'threadnote.io/memory-scope': {
                memoryRoots: [scope.root],
                mode: 'shared-read-write',
                shares: [{root: scope.root, team: scope.team}],
                teams: [scope.team],
                type: 'threadnote-memory-scope',
                version: 2,
              },
            },
            content: [{type: 'text' as const, text: messages.join('\n')}],
            structuredContent: {memoryUri: targetUri, persistence: 'shared-git-pushed'},
          } satisfies CallToolResult;
        }),
      );
    }),
  );
  return write.pipe(
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
    Effect.map(result => result),
  );
}

/**
 * Computes the exact personal-memory destination and final document before a
 * candidate enters its recoverable `applying` state. The writer consumes this
 * same prepared value so recovery and the actual write cannot disagree.
 */
export function preparePersonalMemoryWrite(
  config: RuntimeConfig,
  inputParams: Pick<
    WriteDurableMemoryParams,
    'bodyText' | 'expectedReplaceContent' | 'expectedReplaceMemoryId' | 'metadata' | 'replaceUri'
  >,
) {
  return Effect.gen(function* () {
    const replacement = inputParams.replaceUri
      ? yield* resolveLocalMemoryReplacementTarget(config, inputParams.replaceUri)
      : undefined;
    const replacementMemoryId =
      inputParams.expectedReplaceMemoryId ?? replacement?.memoryId ?? inputParams.metadata.memoryId;
    return yield* preparePersonalMemoryWriteResolved(config, {
      ...inputParams,
      expectedReplaceContent: inputParams.expectedReplaceContent ?? replacement?.record?.content,
      metadata:
        replacementMemoryId === inputParams.metadata.memoryId
          ? inputParams.metadata
          : {...inputParams.metadata, memoryId: replacementMemoryId},
      replaceUri: replacement?.canonicalUri ?? inputParams.replaceUri,
    });
  });
}

const preparePersonalMemoryWriteResolved = Effect.fn('mcpServer.preparePersonalMemoryWrite')(function* (
  config: RuntimeConfig,
  params: Pick<WriteDurableMemoryParams, 'bodyText' | 'expectedReplaceContent' | 'metadata' | 'replaceUri'>,
) {
  const [replaced] = params.replaceUri ? yield* readMemoryRecordsByUri(config, [params.replaceUri]) : [];
  if (replaced) {
    const schemaRewriteError = memorySchemaRewriteError(replaced.content);
    if (schemaRewriteError) return yield* Effect.fail(schemaRewriteError);
  }
  const replacementProof =
    params.replaceUri && params.expectedReplaceContent
      ? parseMemoryDocument(params.replaceUri, params.expectedReplaceContent)
      : undefined;
  const replacementLifecycle = replacementProof ?? replaced;
  const metadata: MemoryMetadata = {
    ...params.metadata,
    createdAt:
      replacementLifecycle?.metadata.createdAt ??
      replacementLifecycle?.metadata.timestamp ??
      params.metadata.createdAt ??
      params.metadata.timestamp,
    memoryId:
      params.metadata.memoryId ??
      replaced?.metadata.memoryId ??
      `tn_${(yield* sha256Hex(
        params.metadata.candidateId ??
          `${params.metadata.project ?? ''}\n${params.metadata.topic ?? ''}\n${params.bodyText}`,
      )).slice(0, 20)}`,
    schemaVersion: Math.max(MEMORY_SCHEMA_VERSION, params.metadata.schemaVersion ?? 0),
    updatedAt: params.metadata.updatedAt ?? params.metadata.timestamp,
    visibility: 'personal',
  };
  if (
    metadata.memoryId !== undefined &&
    metadata.relations?.some(relation => memoryIdFromIdentityAlias(relation.uri) === metadata.memoryId)
  ) {
    return yield* McpServerOperationError.make({message: 'A memory cannot relate to itself.'});
  }
  // Two-pass formatting: see src/memory/index.ts:storeMemory for the rationale.
  // Drops the supersedes line when replaceUri points at the URI we're about
  // to write to (in-place update).
  const candidateMetadata: MemoryMetadata =
    params.replaceUri === undefined ? metadata : {...metadata, supersedes: params.replaceUri};
  const candidateMemory = formatMemoryDocument('MEMORY', candidateMetadata, params.bodyText);
  const memoryUri = yield* memoryUriFor(config, candidateMemory, candidateMetadata);
  const isInPlaceUpdate = params.replaceUri !== undefined && params.replaceUri === memoryUri;
  const finalMetadata: MemoryMetadata = isInPlaceUpdate
    ? {...metadata, supersedes: replacementLifecycle?.metadata.supersedes}
    : candidateMetadata;
  const memory = isInPlaceUpdate ? formatMemoryDocument('MEMORY', finalMetadata, params.bodyText) : candidateMemory;
  return {
    expectedReplaceContent: params.expectedReplaceContent ?? replaced?.content,
    finalMetadata,
    isInPlaceUpdate,
    memory,
    memoryUri,
  } satisfies PreparedPersonalMemoryWrite;
});

function memorySchemaRewriteError(content: string): Error | undefined {
  try {
    assertMemoryDocumentSchemaWritable(content);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const writeSharedMemoryReplacement = Effect.fn('mcp_server.writeSharedMemoryReplacement')(function* (
  config: RuntimeConfig,
  ov: string,
  params: WriteDurableMemoryParams,
  targetUri: string,
) {
  if (params.metadata.kind !== 'durable') {
    return argumentError('Shared memory replacement only supports durable memories.');
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    return argumentError(`Memory ${targetUri} is not in the shared namespace.`);
  }
  const resolved = yield* resolveTeam(config, teamName);
  const inferred = sharedMemoryUriParts(config, targetUri);
  const metadata: MemoryMetadata = {
    ...params.metadata,
    project: inferred?.project ?? params.metadata.project,
    supersedes: undefined,
    topic: params.metadata.topic ?? inferred?.topic,
    visibility: 'shared',
  };
  const rawMemory = formatMemoryDocument('MEMORY', metadata, params.bodyText);
  const citationBlocker = memoryCodeCitationSharingBlocker(metadata);
  if (citationBlocker) {
    return argumentError(
      `Refusing to update shared memory ${targetUri}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    );
  }
  const scrub = applyScrubber(stripPersonalProvenanceForSharedPublication(rawMemory), {
    redact: false,
  });
  if (scrub.blocker) {
    return argumentError(
      `Refusing to update shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
    );
  }

  const [existingTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
  if (!existingTarget) {
    return argumentError(`Shared memory ${targetUri} no longer exists.`);
  }
  const relativePath = resourceUriToWorktreeRelative(config, targetUri, resolved.name);
  yield* assertSharedWorktreeFileReady(resolved.config.worktree, relativePath, existingTarget.content);
  yield* ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
  yield* params.expectedSourceContent?.length
    ? writeMemoryFileChecked(
        config,
        ov,
        targetUri,
        scrub.cleaned,
        'replace',
        false,
        verifyAuthoredMemoryRelationTargetIdentities(config, params.expectedSourceContent),
        {quiet: true},
      )
    : writeMemoryFile(config, ov, targetUri, scrub.cleaned, 'replace', false, {quiet: true});

  yield* writeSharedWorktreeFile(resolved.config.worktree, relativePath, scrub.cleaned);
  const messages = [`Updated shared memory: ${targetUri}`];
  for (const redaction of scrub.redactions) {
    messages.push(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  messages.push(
    ...(yield* publishShareGitChange(resolved.config.worktree, relativePath, `share: update ${relativePath}`)),
  );
  return {content: [{type: 'text', text: messages.join('\n')}]};
});

export const resourceExists = Effect.fn('mcp_server.resourceExists')(function* (
  _ov: string,
  config: RuntimeConfig,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

export function removeResourceWithRetry(_ov: string, config: RuntimeConfig, uri: string, recursive = false) {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    return yield* store.remove(resourceStoreLocation(config), uri, {recursive}).pipe(
      Effect.as(true),
      Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
    );
  });
}

export function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  } as const;
}

export function runNativeRemoveTool(config: RuntimeConfig, uri: string, recursive: boolean) {
  return Effect.gen(function* () {
    const removed = yield* forgetResourceWithRetry(config, uri, recursive);
    return {
      content: [
        {
          type: 'text',
          text: removed ? `Removed: ${uri}` : `Resource not found: ${uri}`,
        },
      ],
      isError: false,
    } satisfies CallToolResult;
  }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

const ensureMemoryDirectory = Effect.fn('mcp_server.ensureMemoryDirectory')(function* (
  _ov: string,
  config: RuntimeConfig,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  yield* store.makeDirectory(resourceStoreLocation(config), directoryUri);
});

const memoryUriFor = Effect.fn('mcpServer.memoryUriFor')(function* (
  config: RuntimeConfig,
  memory: string,
  metadata: MemoryMetadata,
) {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${(yield* sha256(memory)).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
});

function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(metadata.project ?? 'general');
  switch (metadata.kind) {
    case 'preference':
      return metadata.status === 'active'
        ? `${baseUri}/preferences`
        : `${baseUri}/preferences/${uriSegment(metadata.status)}`;
    case 'handoff':
      return `${baseUri}/handoffs/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'incident':
      return `${baseUri}/incidents/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'smoke':
      return `${baseUri}/smoke/${uriSegment(metadata.status)}`;
    case 'durable':
      return metadata.status === 'active'
        ? `${baseUri}/durable/projects/${projectSegment}`
        : `${baseUri}/durable/${uriSegment(metadata.status)}/${projectSegment}`;
  }
}

function shouldUseStableMemoryUri(metadata: MemoryMetadata): boolean {
  return metadata.status === 'active' && metadata.topic !== undefined && metadata.kind !== 'smoke';
}

const memoryWriteMode = Effect.fn('mcp_server.memoryWriteMode')(function* (
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
) {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (yield* resourceExists(ov, config, memoryUri)) ? 'replace' : 'create';
});

interface NativeAddResourceParams {
  readonly description?: string;
  readonly path?: string;
  readonly tempFileId?: string;
  readonly to?: string;
  readonly wait?: boolean;
  readonly watchInterval?: number;
}

export const runNativeAddResourceTool = Effect.fn('mcp_server.runNativeAddResourceTool')(function* (
  config: RuntimeConfig,
  toolName: string,
  params: NativeAddResourceParams,
) {
  const tempFileId = params.tempFileId?.trim();
  const source = params.path?.trim();
  if (!source && !tempFileId) {
    return argumentError(
      [
        `Threadnote MCP tool "${toolName}" needs a non-empty "path" argument.`,
        'Pass JSON arguments to the tool call.',
        `Example: ${toolName}(${JSON.stringify({path: '/path/to/README.md', to: 'threadnote://resources/my-repo/README.md'})})`,
      ].join('\n'),
    );
  }
  if (source) {
    const checkedSource = rejectLeadingDash(source, toolName, 'path');
    if (!checkedSource.ok) {
      return checkedSource.error;
    }
  }
  if (tempFileId) {
    return argumentError(
      `Threadnote 4 does not support native canonical store progressive-upload IDs. Pass a local file or directory in "path".`,
    );
  }
  const checkedTo = optionalResourceUri(params.to, toolName);
  if (!checkedTo.ok) {
    return checkedTo.error;
  }
  if (checkedTo.value && resourceIdIsManagedMemoryNamespace(checkedTo.value)) {
    return argumentError(
      'add_resource cannot write Threadnote memory namespaces. Use remember_context so memory identity and write locks are preserved.',
    );
  }
  if (!source) return argumentError(`Threadnote MCP tool "${toolName}" needs a local path.`);
  if (/^https?:\/\//i.test(source)) {
    return argumentError(
      'Threadnote 4 add_resource accepts local files only; download and review remote content first.',
    );
  }
  if ((params.watchInterval ?? 0) > 0) {
    return argumentError(
      'Threadnote 4 does not run filesystem watches. Re-run add_resource or `threadnote seed` when content changes.',
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedSource = path.resolve(source);
  const link = yield* fs.readLink(resolvedSource).pipe(Effect.option);
  if (link._tag === 'Some') {
    return argumentError(`Refusing to import a symbolic link: ${resolvedSource}`);
  }
  const info = yield* fs.stat(resolvedSource).pipe(Effect.result);
  if (Result.isFailure(info)) {
    return argumentError(`Could not read local import path ${resolvedSource}: ${errorMessage(info.failure)}`);
  }
  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  const imported: string[] = [];
  if (info.success.type === 'File') {
    const target = checkedTo.value
      ? resourceIdWithoutAnchor(parseResourceId(checkedTo.value)).canonicalUri
      : canonicalResourceUri('resources', ['imports', path.basename(resolvedSource).normalize('NFC')]);
    yield* store.write(location, target, yield* fs.readFileString(resolvedSource), {mode: 'upsert'});
    imported.push(target);
  } else if (info.success.type === 'Directory') {
    const root = resourceIdWithoutAnchor(
      parseResourceId(
        checkedTo.value ??
          canonicalResourceUri('resources', ['imports', path.basename(resolvedSource).normalize('NFC')]),
      ),
    );
    const planned: Array<{readonly filePath: string; readonly target: string}> = [];
    for (const entry of yield* fs.readDirectory(resolvedSource, {recursive: true})) {
      const filePath = path.join(resolvedSource, entry);
      if ((yield* fs.readLink(filePath).pipe(Effect.option))._tag === 'Some') continue;
      const fileInfo = yield* fs.stat(filePath);
      if (fileInfo.type !== 'File') continue;
      const relativeSegments = path
        .relative(resolvedSource, filePath)
        .split(path.sep)
        .map(segment => segment.normalize('NFC'));
      planned.push({
        filePath,
        target: canonicalResourceUri(root.namespace, [...root.segments, ...relativeSegments]),
      });
    }
    const destinations = new Set<string>();
    for (const plannedImport of planned) {
      const collisionKey = plannedImport.target.normalize('NFC').toLocaleLowerCase();
      if (destinations.has(collisionKey)) {
        return argumentError(`Local import paths collide at destination URI: ${plannedImport.target}`);
      }
      destinations.add(collisionKey);
    }
    const mutations: ResourceStoreMutation[] = [];
    for (const plannedImport of planned) {
      mutations.push({
        content: yield* fs.readFileString(plannedImport.filePath),
        options: {mode: 'upsert'},
        type: 'write',
        uri: plannedImport.target,
      });
      imported.push(plannedImport.target);
    }
    yield* store.mutate(location, mutations);
  } else {
    return argumentError(`Refusing to import non-file path: ${resolvedSource}`);
  }
  return {
    content: [
      {
        type: 'text',
        text: `Imported ${imported.length} canonical resource(s).${params.description ? ` ${params.description.trim()}` : ''}`,
      },
    ],
    structuredContent: {imported},
  } satisfies CallToolResult;
});

interface NativeListToolOptions {
  readonly all?: boolean;
  readonly nodeLimit?: number;
  readonly recursive?: boolean;
  readonly simple?: boolean;
  readonly uri: string;
}

interface NativePatternToolOptions {
  readonly caseInsensitive?: boolean;
  readonly nodeLimit?: number;
  readonly pattern: string;
  readonly uri: string;
}

export function runNativeListTool(
  config: RuntimeConfig,
  options: NativeListToolOptions,
): Effect.Effect<CallToolResult, never, ResourceStore> {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const location = resourceStoreLocation(config);
    const listOne = (uri: string) =>
      store
        .list(location, uri, {recursive: options.recursive === true})
        .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
    const entries =
      options.uri === 'threadnote://'
        ? [
            ...(yield* listOne('threadnote://resources')),
            ...(yield* listOne(`threadnote://user/${uriSegment(config.user)}`)),
          ]
        : yield* listOne(options.uri);
    const visible =
      options.all === true ? entries : entries.filter(entry => !entry.uri.split('/').at(-1)?.startsWith('.'));
    const limited = visible.slice(0, options.nodeLimit ?? 1000);
    const text =
      limited.length === 0
        ? `(nothing found at ${options.uri})`
        : options.simple === true
          ? limited.map(entry => entry.uri).join('\n')
          : limited
              .map(entry => `${entry.type === 'directory' ? 'directory' : 'file'}\t${entry.size}\t${entry.uri}`)
              .join('\n');
    return {
      content: [{type: 'text' as const, text}],
      structuredContent: {entries: limited},
    } satisfies CallToolResult;
  }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

export function runNativeGrepTool(
  config: RuntimeConfig,
  options: NativePatternToolOptions,
): Effect.Effect<CallToolResult, never, ResourceStore> {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const matches = yield* store.grep(
      resourceStoreLocation(config),
      options.uri,
      options.pattern,
      options.nodeLimit ?? 100,
    );
    const text =
      matches.length === 0
        ? `(nothing found at ${options.uri})`
        : matches.map(match => `${match.uri}:${match.line}:${match.text}`).join('\n');
    return {
      content: [{type: 'text' as const, text}],
      structuredContent: {matches},
    } satisfies CallToolResult;
  }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

export function runNativeGlobTool(
  config: RuntimeConfig,
  options: NativePatternToolOptions,
): Effect.Effect<CallToolResult, never, ResourceStore> {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const entries = yield* store.glob(resourceStoreLocation(config), options.uri, options.pattern);
    const limited = entries.slice(0, options.nodeLimit ?? 100);
    return {
      content: [
        {
          type: 'text' as const,
          text: limited.length === 0 ? `(nothing found at ${options.uri})` : limited.map(entry => entry.uri).join('\n'),
        },
      ],
      structuredContent: {entries: limited},
    } satisfies CallToolResult;
  }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

export const runNativeHealthTool = Effect.fn('mcp_server.runNativeHealthTool')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const homeExists = yield* fs.exists(config.agentContextHome);
  const runtimeVersion = yield* currentPackageVersion();
  return {
    content: [
      {
        type: 'text' as const,
        text: `Threadnote native runtime: ok\nVersion: ${runtimeVersion}\nHome: ${config.agentContextHome}\nHome initialized: ${homeExists ? 'yes' : 'no'}`,
      },
    ],
    structuredContent: {
      home: config.agentContextHome,
      homeInitialized: homeExists,
      runtimeVersion,
      status: 'ok',
      storage: 'native',
    },
  } satisfies CallToolResult;
});

export function runNativeReadTool(
  config: RuntimeConfig,
  uris: readonly string[],
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly followRelocations?: boolean;
    readonly resolveIdentityAliases?: boolean;
  } = {},
) {
  // Canonical memory reads are intentionally complete. Context budgets belong
  // to derived graph/search evidence, never to user-authored memory content.
  // Keep the canonical bytes in MCP content only: repeating them in
  // structuredContent can make an otherwise valid read exceed a client's
  // transport-frame policy, while metadata-only structuredContent can cause
  // clients that prefer structured results to hide the canonical bytes. The
  // URI-to-content association is implementation metadata, so keep it in the
  // protocol-reserved _meta field instead of a model-facing result field.
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const resolvedInputs =
      options.resolveIdentityAliases === true
        ? yield* resolveMemoryIdentityAliases(
            config,
            uris,
            options.allowedUriScopes ?? [`threadnote://user/${uriSegment(config.user)}/memories`],
          )
        : uris.map(requestedUri => ({canonicalUri: requestedUri, requestedUri}));
    const content: Array<{readonly text: string; readonly type: 'text'}> = [];
    const resources: Array<{
      readonly canonicalUri: string;
      readonly contentIndex: number;
      readonly relocationDepth: number;
      readonly requestedUri: string;
      /** Compatibility field retained for canonical-read v1 consumers. */
      readonly uri: string;
    }> = [];
    const missing: string[] = [];
    let firstFailure: unknown;
    for (const input of resolvedInputs) {
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          const uri = input.canonicalUri;
          const resolved =
            options.followRelocations !== false && isMemoryRelocationUri(config, uri)
              ? yield* readMemoryWithRelocations(config, uri)
              : {
                  canonicalUri: parseResourceId(uri).canonicalUri,
                  content: yield* store.read(resourceStoreLocation(config), uri),
                  relocationDepth: 0,
                  requestedUri: parseResourceId(uri).canonicalUri,
                };
          yield* verifyResolvedMemoryIdentity(input, resolved.canonicalUri, resolved.content);
          return resolved;
        }),
      );
      if (Result.isFailure(outcome)) {
        firstFailure ??= outcome.failure;
        missing.push(input.requestedUri);
        continue;
      }
      const resolved = outcome.success;
      resources.push({
        canonicalUri: resolved.canonicalUri,
        contentIndex: content.length,
        relocationDepth: resolved.relocationDepth,
        requestedUri: input.requestedUri,
        uri: input.requestedUri,
      });
      content.push({text: resolved.content, type: 'text'});
    }
    if (content.length === 0) {
      return memoryReadErrorResult(config, firstFailure);
    }
    const result: CallToolResult = {
      _meta: {
        'threadnote.io/canonical-read': {
          resources,
          type: 'threadnote-canonical-read',
          version: 1,
          ...(missing.length > 0 ? {missing} : {}),
        },
      },
      content,
    };
    return result;
  }).pipe(Effect.catch(error => Effect.succeed(memoryReadErrorResult(config, error))));
}

export function textFromCallToolResult(result: CallToolResult): string {
  return result.content
    .map(content => (content.type === 'text' ? content.text : ''))
    .join('\n')
    .trim();
}

export function writeMemoryContentWithExpectedHash(
  config: RuntimeConfig,
  ov: string,
  uri: string,
  content: string,
  expectedContent: string,
  options: {readonly alreadyLocked?: boolean} = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const write = Effect.gen(function* () {
      const [current] = yield* readMemoryRecordsByUri(config, [uri]);
      if (!current || current.content !== expectedContent) {
        return argumentError(`Memory ${uri} changed after compact_context planned its update. Re-run the plan.`);
      }
      const schemaError = memorySchemaRewriteError(content);
      const postcondition = parseMemoryDocument(uri, content);
      if (
        schemaError ||
        !postcondition ||
        postcondition.metadata.consolidationError ||
        (postcondition.metadata.citationErrors?.length ?? 0) > 0
      ) {
        return argumentError(schemaError?.message ?? `Repair would produce invalid memory evidence for ${uri}.`);
      }
      if (
        current.metadata.consolidation !== undefined &&
        JSON.stringify(current.metadata.consolidation) !== JSON.stringify(postcondition.metadata.consolidation)
      ) {
        return argumentError(
          'Consolidation derivation requires evidence review before replacement; repair must preserve its pinned receipt.',
        );
      }
      yield* writeMemoryFile(config, ov, uri, content, 'replace', false, {quiet: true});
      yield* discardDeferredCodeAnchorIntent(config, uri);
      return {content: [{type: 'text' as const, text: `Updated memory: ${uri}`}]};
    });
    return yield* options.alreadyLocked === true
      ? write
      : withMemoryUriLocks(fs, config.agentContextHome, [uri], write);
  });
}

export function forgetResourceWithRetry(
  config: RuntimeConfig,
  uri: string,
  recursive = false,
  expectedContent?: string,
  alreadyLocked = false,
) {
  const remove = Effect.gen(function* () {
    if (expectedContent) {
      const [current] = yield* readMemoryRecordsByUri(config, [uri]);
      if (!current || current.content !== expectedContent) {
        return yield* McpServerOperationError.make({
          message: `Memory ${uri} changed after this removal was planned. Re-run the operation.`,
        });
      }
    }
    const removed = yield* removeResourceWithRetry('threadnote-native', config, uri, recursive);
    if (removed) yield* discardDeferredCodeAnchorIntentsWithin(config, uri);
    return removed;
  });
  if (alreadyLocked) {
    return remove;
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withDeferredCodeAnchorMutationLocks(fs, config, [uri], remove);
  });
}
