import {Effect, FileSystem, Path, Schema} from 'effect';
import {inferProjectFromManifest, readSeedManifest, requireManifestWorkset} from '@threadnote/workspace/manifest';
import type {ProjectManifest, SeedManifest} from '@threadnote/workspace/config';
import {resolveRepositoryCheckoutIdentity} from '@threadnote/graph/repository';
import {
  deriveRecallEligibilityPolicy,
  normalizeRecallProject,
  normalizeRecallProjectNames,
  type RecallEligibilityPolicy,
  type RecallScopeProvenance,
} from '@threadnote/recall/eligibility';
import {resolveWorkspaceRepoName} from '../utils.js';
import {expandPath} from '@threadnote/platform/paths';

class RecallScopeError extends Schema.TaggedError<RecallScopeError>()('RecallScopeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface RecallScopeInput {
  readonly callerCwd?: string;
  readonly inferScope?: boolean;
  readonly pinnedUri?: string;
  readonly project?: string;
  readonly query: string;
  readonly workset?: string;
}

/** Candidate boundaries are independent of the query and ranking preferences. */
export const resolveRecallScope = Effect.fn('memory.resolveRecallScope')(function* (
  config: {readonly manifestPath: string},
  input: RecallScopeInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const infer = input.inferScope !== false && input.pinnedUri === undefined && input.query.trim().length > 0;
  const explicitProject = normalizeRecallProject(input.project);
  const manifest =
    (infer || input.workset !== undefined) && (yield* fs.exists(config.manifestPath))
      ? yield* readSeedManifest(config.manifestPath).pipe(
          Effect.mapError(cause =>
            RecallScopeError.make({
              cause,
              message: 'Configured recall manifest could not be read or parsed.',
            }),
          ),
        )
      : undefined;
  const selectedWorkset =
    input.workset === undefined
      ? undefined
      : yield* Effect.try({
          try: () => {
            if (manifest === undefined) throw new Error('Explicit workset requires a readable manifest.');
            return requireManifestWorkset(manifest, input.workset!, config.manifestPath);
          },
          catch: cause =>
            RecallScopeError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
        });
  const workset = input.pinnedUri === undefined ? selectedWorkset : undefined;
  const callerCwd = input.callerCwd && path.isAbsolute(input.callerCwd) ? input.callerCwd : undefined;
  const repoName =
    infer && callerCwd ? yield* resolveWorkspaceRepoName({cwd: callerCwd, includeProcessCwd: false}) : undefined;
  const workspaceProjects =
    infer && callerCwd && explicitProject === undefined && workset === undefined
      ? yield* resolveCheckoutProjects(manifest, callerCwd, repoName)
      : undefined;
  const preferredManifestProject =
    input.pinnedUri !== undefined
      ? undefined
      : explicitProject !== undefined
        ? manifest?.projects.find(project => normalizeRecallProject(project.name) === explicitProject)
        : infer && manifest !== undefined
          ? inferProjectFromManifest(manifest, input.query)
          : undefined;
  const preferredProject =
    input.pinnedUri !== undefined ? undefined : (explicitProject ?? preferredManifestProject?.name ?? repoName);
  const eligibility = deriveRecallEligibilityPolicy({
    explicitProject,
    originalQuery: input.query,
    pinnedHardUri: input.pinnedUri !== undefined,
    workspaceProjects,
    worksetProjectNames: workset?.projects.map(project => project.name),
  });
  const reason =
    input.pinnedUri !== undefined
      ? 'pinned-uri'
      : workset !== undefined
        ? 'explicit-workset'
        : explicitProject !== undefined
          ? 'explicit-project'
          : input.inferScope === false
            ? 'inference-disabled'
            : workspaceProjects !== undefined
              ? 'workspace-checkout'
              : 'no-workspace';
  return {
    eligibility,
    preferredProject,
    preferredManifestProject,
    provenance: recallScopeProvenance(eligibility, reason),
    workset,
  };
});

const resolveCheckoutProjects = Effect.fn('memory.resolveCheckoutProjects')(function* (
  manifest: SeedManifest | undefined,
  callerCwd: string,
  repoName: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const caller = yield* resolveRepositoryCheckoutIdentity(callerCwd);
  if (caller === undefined) return undefined;
  const byRoot = new Map<string, ProjectManifest[]>();
  for (const project of manifest?.projects ?? []) {
    // Relative manifest roots belong to the caller checkout.
    const expanded = project.path.startsWith('~') ? yield* expandPath(project.path) : project.path;
    const root = yield* fs.realPath(path.resolve(caller.repoRoot, expanded)).pipe(Effect.option);
    if (root._tag === 'None') continue;
    const projects = byRoot.get(root.value) ?? [];
    projects.push(project);
    byRoot.set(root.value, projects);
  }
  if (byRoot.size > 1_024)
    return yield* RecallScopeError.make({message: 'Recall manifest exceeds 1024 unique checkout roots.'});
  const projects = yield* Effect.forEach(
    [...byRoot],
    ([root, entries]) =>
      (root === caller.repoRoot ? Effect.succeed(caller) : resolveRepositoryCheckoutIdentity(root)).pipe(
        Effect.map(identity =>
          identity?.checkoutId === caller.checkoutId ? entries.map(project => project.name) : [],
        ),
      ),
    {concurrency: 4},
  ).pipe(Effect.timeout('10 seconds'));
  return normalizeRecallProjectNames([...projects.flat(), ...(repoName ? [repoName] : [])]);
});

function recallScopeProvenance(
  eligibility: RecallEligibilityPolicy,
  reason: RecallScopeProvenance['reason'],
): RecallScopeProvenance {
  if (eligibility.kind === 'pinned-hard-uri-bypass') return {mode: 'pinned-uri', reason};
  const projects = eligibility.projects.mode === 'allow-projects-and-projectless' ? eligibility.projects.projects : [];
  return {
    mode: eligibility.projects.mode,
    reason,
    ...(projects.length === 0
      ? {}
      : {
          projects: projects.slice(0, 4).map(boundedProjectName),
          ...(projects.slice(0, 4).some(project => new TextEncoder().encode(project).byteLength > 48)
            ? {truncatedProjectNames: true as const}
            : {}),
          omittedProjects: Math.max(0, projects.length - 4),
        }),
  };
}

function boundedProjectName(project: string): string {
  let value = '';
  for (const character of project) {
    if (new TextEncoder().encode(value + character).byteLength > 48) return `${value}…`;
    value += character;
  }
  return value;
}
