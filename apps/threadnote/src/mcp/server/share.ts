import {Effect, FileSystem} from 'effect';
import {type McpToolset} from '../toolset.js';
import {buildOnboardingGuide, gatherOnboardingContext} from '../../onboarding.js';
import {
  ensureSharedDirectoryChain,
  assertSharedWorktreeFileReady,
  isInSharedNamespace,
  publishShareGitChange,
  resolveTeam,
  applyScrubber,
  setMemoryVisibility,
  sharedUriFor,
  stripPersonalProvenanceForSharedPublication,
  resourceUriToWorktreeRelative,
  shareConflictCanTakeShared,
  writeMemoryFile,
  writeSharedWorktreeFile,
} from '../../share/index.js';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {
  installSharedAgentArtifacts,
  listShareConflicts,
  listSharedAgentArtifacts,
  resolveShareConflict,
  shareAgentArtifact,
  shareBundlePack,
  showShareConflict,
} from '../../effect/share.js';
import {withSharedRepositoryLock} from '../../effect/share/lock.js';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {sharePublishEligibilityError, sharePublishRelationWarnings} from '../../share/publish_policy.js';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {discardDeferredCodeAnchorIntent, hasDeferredCodeAnchorIntent} from '../../memory/deferred/code_anchor.js';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';
import {type RuntimeConfig, argumentError, mcpErrorResult} from './common.js';
import {
  readMemoryRecordsByUri,
  removeResourceWithRetry,
  runNativeHealthTool,
  runNativeReadTool,
  textFromCallToolResult,
} from './memory.js';
interface SharePublishToolOptions {
  readonly allowUncitedPendingCodeRefs?: boolean;
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

interface ShareConflictToolOptions {
  readonly team?: string;
}

interface ShareConflictResolveToolOptions {
  readonly dryRun?: boolean;
  readonly mergedContent?: string;
  readonly message?: string;
  readonly push?: boolean;
  readonly take?: 'local' | 'shared';
  readonly team?: string;
}

interface ShareSkillToolOptions {
  readonly agent?: 'claude' | 'codex' | 'cursor';
  readonly allowBinary?: boolean;
  readonly force?: boolean;
  readonly kind?: 'command' | 'pack' | 'skill';
  readonly message?: string;
  readonly name?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

interface SharedSkillFilterOptions {
  readonly agent?: 'claude' | 'codex' | 'cursor';
  readonly kind?: 'command' | 'pack' | 'skill';
  readonly name?: string;
  readonly team?: string;
}

interface InstallSharedSkillToolOptions {
  readonly agent?: 'claude' | 'codex' | 'cursor';
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly kind?: 'command' | 'pack' | 'skill';
  readonly team?: string;
}

export function runShareConflictsTool(config: RuntimeConfig, options: ShareConflictToolOptions) {
  return listShareConflicts(config, options).pipe(
    Effect.map(conflicts => {
      if (conflicts.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: options.team
                ? `No pending shared memory conflicts for team "${options.team}".`
                : 'No pending shared memory conflicts.',
            },
          ],
        };
      }
      const lines = [`Pending shared memory conflicts: ${conflicts.length}`];
      for (const conflict of conflicts) {
        lines.push(
          '',
          conflict.id,
          `uri: ${conflict.uri}`,
          `status: ${conflict.status}`,
          `reason: ${conflict.reason}`,
          `show: share_conflict_show({"id":${JSON.stringify(conflict.id)}})`,
          ...(shareConflictCanTakeShared(conflict)
            ? [`take shared: share_conflict_resolve({"id":${JSON.stringify(conflict.id)},"take":"shared"})`]
            : []),
          `take local: share_conflict_resolve({"id":${JSON.stringify(conflict.id)},"take":"local"})`,
          `merged: share_conflict_resolve({"id":${JSON.stringify(conflict.id)},"mergedContent":"<merged MEMORY markdown>"})`,
        );
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}]};
    }),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

export function runShareConflictShowTool(config: RuntimeConfig, id: string, options: ShareConflictToolOptions) {
  return showShareConflict(config, id, options).pipe(
    Effect.map(detail => ({
      content: [
        {
          type: 'text' as const,
          text: [
            `Conflict: ${detail.id}`,
            `URI: ${detail.uri}`,
            `Status: ${detail.status}`,
            `Reason: ${detail.reason}`,
            '',
            detail.diff,
            '',
            'Resolve:',
            ...(shareConflictCanTakeShared(detail)
              ? [`share_conflict_resolve({"id":${JSON.stringify(detail.id)},"take":"shared"})`]
              : []),
            `share_conflict_resolve({"id":${JSON.stringify(detail.id)},"take":"local"})`,
            `share_conflict_resolve({"id":${JSON.stringify(detail.id)},"mergedContent":"<merged MEMORY markdown>"})`,
          ].join('\n'),
        },
      ],
    })),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

export function runShareConflictResolveTool(
  config: RuntimeConfig,
  id: string,
  options: ShareConflictResolveToolOptions,
) {
  return resolveShareConflict(config, id, {
    dryRun: options.dryRun,
    mergedContent: options.mergedContent,
    message: options.message,
    push: options.push,
    take: options.take,
    team: options.team,
  }).pipe(
    Effect.map(result => {
      const lines = [...result.messages];
      if (result.backupPath) {
        lines.push(`Backup: ${result.backupPath}`);
      }
      lines.push(
        ...result.gitMessages,
        options.dryRun === true
          ? `Would resolve shared memory conflict: ${result.id}`
          : `Resolved shared memory conflict: ${result.id}`,
      );
      return {content: [{type: 'text' as const, text: lines.join('\n')}]};
    }),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

export function runSharePublishTool(config: RuntimeConfig, sourceUri: string, options: SharePublishToolOptions) {
  return Effect.gen(function* () {
    if (isInSharedNamespace(config, sourceUri)) {
      return argumentError(`Memory ${sourceUri} is already in the shared namespace.`);
    }
    const hasPendingCodeRefs = yield* hasDeferredCodeAnchorIntent(config, sourceUri);
    if (hasPendingCodeRefs && options.allowUncitedPendingCodeRefs !== true) {
      return argumentError(
        `Refusing to publish ${sourceUri}: code citations are still pending. Prepare the graph and call finalize_code_refs, or pass allowUncitedPendingCodeRefs=true to publish without them and discard the private intent.`,
      );
    }
    const ov = 'threadnote-native';
    const readResult = yield* runNativeReadTool(config, [sourceUri], {followRelocations: false});
    const sourceText = textFromCallToolResult(readResult);
    if (readResult.isError === true || !sourceText) {
      return {
        content: [
          {
            type: 'text',
            text: `Could not read ${sourceUri}: ${sourceText || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    const eligibilityError = sharePublishEligibilityError(config, sourceUri, sourceText);
    if (eligibilityError) return argumentError(eligibilityError);
    const citationBlocker = memoryCodeCitationContentSharingBlocker(sourceUri, sourceText);
    if (citationBlocker) {
      return argumentError(
        `Refusing to publish ${sourceUri}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
      );
    }
    const stripped = setMemoryVisibility(stripPersonalProvenanceForSharedPublication(sourceText), 'shared');
    const scrub = applyScrubber(stripped, {redact: options.redact === true});

    if (options.preview === true) {
      const resolved = yield* resolveTeam(config, options.team);
      const targetUri = sharedUriFor(config, sourceUri, resolved.name);
      const previewLines = [`PREVIEW source: ${sourceUri}`, `PREVIEW destination: ${targetUri}`];
      if (scrub.blocker) {
        previewLines.push(
          `PREVIEW BLOCKED: ${scrub.blocker}. Strip the sensitive value or pass redact=true for soft-leak patterns.`,
        );
        return {content: [{type: 'text', text: previewLines.join('\n')}]};
      }
      for (const redaction of scrub.redactions) {
        previewLines.push(`PREVIEW redact: ${redaction.count}× ${redaction.name}`);
      }
      previewLines.push(...(yield* sharePublishRelationWarnings(config, sourceUri, scrub.cleaned, resolved.name)));
      previewLines.push('-----BEGIN PREVIEW-----');
      previewLines.push(scrub.cleaned);
      previewLines.push('-----END PREVIEW-----');
      return {content: [{type: 'text', text: previewLines.join('\n')}]};
    }

    if (scrub.blocker) {
      return argumentError(
        `Refusing to publish ${sourceUri}: possible ${scrub.blocker}. Strip the sensitive value or pass redact=true for soft-leak patterns.`,
      );
    }
    const {publication, targetUri} = yield* withSharedRepositoryLock(
      config,
      Effect.gen(function* () {
        const resolved = yield* resolveTeam(config, options.team);
        const targetUri = sharedUriFor(config, sourceUri, resolved.name);
        const relativePath = resourceUriToWorktreeRelative(config, targetUri, resolved.name);
        const commitMessage = options.message ?? `share: publish ${relativePath}`;
        const fs = yield* FileSystem.FileSystem;
        const publication = yield* withMemoryUriLocks(
          fs,
          config.agentContextHome,
          [sourceUri, targetUri],
          Effect.gen(function* () {
            if (yield* hasDeferredCodeAnchorIntent(config, sourceUri)) {
              if (options.allowUncitedPendingCodeRefs !== true) {
                return {kind: 'pending_code_refs' as const};
              }
            }
            const currentReadResult = yield* runNativeReadTool(config, [sourceUri], {followRelocations: false});
            const currentSourceText = textFromCallToolResult(currentReadResult);
            if (currentReadResult.isError === true || !currentSourceText) {
              return {kind: 'source_missing' as const};
            }
            const currentEligibilityError = sharePublishEligibilityError(config, sourceUri, currentSourceText);
            if (currentEligibilityError) {
              return {kind: 'ineligible' as const, message: currentEligibilityError};
            }
            const currentCitationBlocker = memoryCodeCitationContentSharingBlocker(sourceUri, currentSourceText);
            if (currentCitationBlocker) {
              return {blocker: currentCitationBlocker, kind: 'citation_blocked' as const};
            }
            const currentScrub = applyScrubber(
              setMemoryVisibility(
                stripPersonalProvenanceForSharedPublication(canonicalMemoryDocumentContent(currentSourceText)),
                'shared',
              ),
              {
                redact: options.redact === true,
              },
            );
            if (currentScrub.blocker) {
              return {blocker: currentScrub.blocker, kind: 'blocked' as const};
            }
            const [existingTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
            if (existingTarget && !sharedPublicationContentEquivalent(existingTarget.content, currentScrub.cleaned)) {
              return {kind: 'target_conflict' as const};
            }
            // A pre-4.6 MCP publication may have committed otherwise-identical
            // bytes without shared visibility before source cleanup completed.
            // Accept only that visibility difference, then upgrade both stores.
            yield* assertSharedWorktreeFileReady(
              resolved.config.worktree,
              relativePath,
              existingTarget?.content,
              false,
              sharedPublicationContentEquivalent,
              {allowCleanTrackedReplacement: existingTarget === undefined},
            );
            yield* ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
            yield* writeMemoryFile(
              config,
              ov,
              targetUri,
              currentScrub.cleaned,
              existingTarget ? 'replace' : 'create',
              false,
              {quiet: true},
            );
            const [storedTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
            if (
              !storedTarget ||
              canonicalMemoryDocumentContent(storedTarget.content) !==
                canonicalMemoryDocumentContent(currentScrub.cleaned)
            ) {
              return {kind: 'target_verification_failed' as const};
            }
            yield* writeSharedWorktreeFile(resolved.config.worktree, relativePath, currentScrub.cleaned);
            const gitMessages = yield* publishShareGitChange(resolved.config.worktree, relativePath, commitMessage, {
              push: options.push,
            });
            const sourceBeforeRemovalResult = yield* runNativeReadTool(config, [sourceUri], {followRelocations: false});
            const sourceBeforeRemovalText = textFromCallToolResult(sourceBeforeRemovalResult);
            if (
              sourceBeforeRemovalResult.isError === true ||
              canonicalMemoryDocumentContent(sourceBeforeRemovalText) !==
                canonicalMemoryDocumentContent(currentSourceText)
            ) {
              return {
                gitMessages,
                kind: 'source_changed' as const,
                redactions: currentScrub.redactions,
              };
            }
            yield* recordMemoryRelocation(config, {
              fromContent: sourceBeforeRemovalText,
              fromUri: sourceUri,
              toContent: currentScrub.cleaned,
              toUri: targetUri,
            });
            const removed = yield* removeResourceWithRetry(ov, config, sourceUri);
            if (removed) {
              yield* discardDeferredCodeAnchorIntent(config, sourceUri);
            }
            return {
              gitMessages,
              kind: removed ? ('published' as const) : ('cleanup_pending' as const),
              redactions: currentScrub.redactions,
            };
          }),
        );
        return {publication, targetUri};
      }),
    );
    if (publication.kind === 'source_missing') {
      return argumentError(`Could not resolve local memory content for ${sourceUri} before publishing.`);
    }
    if (publication.kind === 'ineligible') return argumentError(publication.message);
    if (publication.kind === 'pending_code_refs') {
      return argumentError(
        `Refusing to publish ${sourceUri}: code citations are still pending. Prepare the graph and call finalize_code_refs, or pass allowUncitedPendingCodeRefs=true to publish without them and discard the private intent.`,
      );
    }
    if (publication.kind === 'citation_blocked') {
      return argumentError(
        `Refusing to publish ${sourceUri}: ${memoryCodeCitationSharingBlockerMessage(publication.blocker)}.`,
      );
    }
    if (publication.kind === 'blocked') {
      return argumentError(
        `Refusing to publish ${sourceUri}: possible ${publication.blocker}. Strip the sensitive value or pass redact=true for soft-leak patterns.`,
      );
    }
    if (publication.kind === 'target_conflict') {
      return argumentError(
        `Refusing to publish: ${targetUri} already exists in the shared namespace. Inspect it via threadnote read; if it should be replaced, forget the existing shared copy first.`,
      );
    }
    if (publication.kind === 'target_verification_failed') {
      return argumentError(
        `Shared target verification failed after writing ${targetUri}. The personal source was preserved for recovery.`,
      );
    }
    const messages = [`Published ${sourceUri} -> ${targetUri}`];
    for (const redaction of publication.redactions) {
      messages.push(`Redacted ${redaction.count}× ${redaction.name} before publish.`);
    }
    if (publication.kind === 'source_changed' || publication.kind === 'cleanup_pending') {
      const cleanupReason =
        publication.kind === 'source_changed'
          ? `Memory ${sourceUri} changed while publication was in progress.`
          : `Resource is still being processed: ${sourceUri}`;
      return {
        content: [
          {
            type: 'text',
            text: [
              ...messages,
              ...publication.gitMessages,
              `Could not remove the personal source after publish: ${sourceUri}.`,
              `Retry cleanup later with: threadnote forget ${sourceUri}`,
              cleanupReason,
            ].join('\n'),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{type: 'text', text: [...messages, ...publication.gitMessages].join('\n')}],
      isError: false,
    };
  }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

function sharedPublicationContentEquivalent(currentContent: string, expectedContent: string): boolean {
  return (
    canonicalMemoryDocumentContent(setMemoryVisibility(currentContent, 'shared')) ===
    canonicalMemoryDocumentContent(setMemoryVisibility(expectedContent, 'shared'))
  );
}

export function runShareSkillTool(config: RuntimeConfig, sourcePath: string, options: ShareSkillToolOptions) {
  return shareAgentArtifact(config, sourcePath, options).pipe(
    Effect.map(result => {
      const lines = [...result.messages, ...result.gitMessages];
      if (result.previewContent !== undefined) {
        lines.push('-----BEGIN PREVIEW-----');
        lines.push(result.previewContent);
        lines.push('-----END PREVIEW-----');
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}], isError: false};
    }),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

interface ShareBundleToolOptions {
  readonly allowBinary?: boolean;
  readonly force?: boolean;
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

export function runShareBundleTool(config: RuntimeConfig, manifestPath: string, options: ShareBundleToolOptions) {
  return shareBundlePack(config, manifestPath, options).pipe(
    Effect.map(result => {
      const lines = [...result.messages, ...result.gitMessages];
      if (result.previewContent !== undefined) {
        lines.push('-----BEGIN PREVIEW-----');
        lines.push(result.previewContent);
        lines.push('-----END PREVIEW-----');
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}], isError: false};
    }),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

export const runThreadnoteGuideTool = Effect.fn('mcp_server.runThreadnoteGuideTool')(function* (
  config: RuntimeConfig,
  toolset: McpToolset,
) {
  const runtimeReady = yield* probeRuntimeReady(config);
  const context = yield* gatherOnboardingContext(config);
  const text = buildOnboardingGuide({...context, runtimeReady, toolset});
  return {content: [{type: 'text', text}], isError: false};
});

const probeRuntimeReady = Effect.fn('mcp_server.probeRuntimeReady')(function* (config: RuntimeConfig) {
  return yield* runNativeHealthTool(config).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

export function runListSharedSkillsTool(config: RuntimeConfig, options: SharedSkillFilterOptions) {
  return listSharedAgentArtifacts(config, options).pipe(
    Effect.map(result => {
      const lines = shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings);
      if (result.artifacts.length === 0) {
        lines.push(`No shared skills or commands found for team "${result.team}".`);
      } else {
        lines.push(`Shared skills and commands for team "${result.team}":`);
        for (const artifact of result.artifacts) {
          lines.push(
            `- ${artifact.artifact.kind} ${artifact.artifact.agent}/${artifact.artifact.name} (${artifact.installStatus})`,
          );
          lines.push(
            `  install: install_shared_skill({"name":"${artifact.artifact.name}","agent":"${artifact.artifact.agent}","kind":"${artifact.artifact.kind}"})`,
          );
        }
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}], isError: false};
    }),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

export function runInstallSharedSkillTool(config: RuntimeConfig, name: string, options: InstallSharedSkillToolOptions) {
  return installSharedAgentArtifacts(config, {
    ...options,
    apply: options.dryRun !== true,
    name,
  }).pipe(
    Effect.map(result => ({
      content: [
        {
          type: 'text' as const,
          text: [...shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings), ...result.messages].join(
            '\n',
          ),
        },
      ],
      isError: false,
    })),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}

function shareArtifactToolHeader(team: string, syncedTeams: readonly string[], warnings: readonly string[]): string[] {
  const lines = [`Team: ${team}`];
  if (syncedTeams.length > 0) {
    lines.push(`Synced shared teams: ${syncedTeams.join(', ')}`);
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines;
}
