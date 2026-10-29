import * as EffectAll from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect, Exit, FileSystem, Option, Path, PlatformError, Result} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeTextDirectoryNamePage} from '@threadnote/platform/system';
import {readTeamsFile} from '../share/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  isPublishableProcedureManifest,
  parseProcedureManifest,
  parseProcedureVerificationReceipt,
} from '@threadnote/context/procedure/contract';
import {decodeExactProcedureText} from '@threadnote/context/procedure/exact_text';
import type {PublishedProcedureCandidate, VerifiedProcedureCoverageGap} from '@threadnote/context/procedure/selection';
import * as EffectRecord from 'effect/Record';

const MAXIMUM_DISCOVERED_PROCEDURES = 128;
const MAXIMUM_ARTIFACT_SOURCES = 256;
const MAXIMUM_ARTIFACTS_PER_TEAM = 256;
const MAXIMUM_VERSIONS_PER_ARTIFACT = 16;
const MAXIMUM_INSPECTED_VERSIONS = 512;
const MAXIMUM_JSON_BYTES = 256 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 1024 * 1024;

interface ArtifactSource {
  readonly artifactId: string;
  readonly root: string;
  readonly team: string;
}

export interface PublishedProcedureRepositoryEvidence {
  readonly candidates: readonly PublishedProcedureCandidate[];
  readonly gaps: readonly VerifiedProcedureCoverageGap[];
}

/** Reads only the bounded, immutable procedure layout owned by Threadnote publication. */
export const loadPublishedProcedureCandidates = Effect.fn('procedure.repository.load')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gaps = new Set<VerifiedProcedureCoverageGap>();
  const teamsExit = yield* Effect.exit(readTeamsFile(config));
  if (Exit.isFailure(teamsExit)) {
    return {
      candidates: [],
      gaps: ['procedure-evidence-unavailable'],
    } satisfies PublishedProcedureRepositoryEvidence;
  }

  const sourcesByTeam: ArtifactSource[][] = [];
  for (const [team, teamConfig] of EffectRecord.toEntries(teamsExit.value.teams).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const artifactShareRoot = path.join(teamConfig.worktree, 'agent-artifacts');
    const artifactShareState = yield* directoryState(fs, artifactShareRoot);
    if (artifactShareState === 'missing') continue;
    if (artifactShareState !== 'directory') {
      gaps.add('procedure-evidence-unavailable');
      continue;
    }
    const root = path.join(artifactShareRoot, 'procedures');
    const rootState = yield* directoryState(fs, root);
    if (rootState === 'missing') continue;
    if (rootState !== 'directory') {
      gaps.add('procedure-evidence-unavailable');
      continue;
    }
    const page = yield* runtimeTextDirectoryNamePage(root, MAXIMUM_ARTIFACTS_PER_TEAM).pipe(Effect.option);
    if (Option.isNone(page)) {
      gaps.add('procedure-evidence-unavailable');
      continue;
    }
    if (page.value.overflow) gaps.add('procedure-evidence-truncated');
    const teamSources: ArtifactSource[] = [];
    for (const artifactId of page.value.names) {
      if (!/^[a-f0-9]{64}$/u.test(artifactId)) continue;
      const artifactRoot = path.join(root, artifactId);
      if ((yield* directoryState(fs, artifactRoot)) !== 'directory') {
        gaps.add('procedure-evidence-unavailable');
        continue;
      }
      teamSources.push({artifactId, root: artifactRoot, team});
    }
    sourcesByTeam.push(teamSources.sort(compareArtifactSource));
  }

  const sources = roundRobin(sourcesByTeam, MAXIMUM_ARTIFACT_SOURCES);
  if (
    EffectArray.some(sourcesByTeam, teamSources => EffectArray.some(teamSources, source => !sources.includes(source)))
  ) {
    gaps.add('procedure-evidence-truncated');
  }
  const versionsBySource: Array<{readonly source: ArtifactSource; readonly versions: readonly string[]}> = [];
  for (const source of sources) {
    const page = yield* runtimeTextDirectoryNamePage(source.root, MAXIMUM_VERSIONS_PER_ARTIFACT).pipe(Effect.option);
    if (Option.isNone(page)) {
      gaps.add('procedure-evidence-unavailable');
      continue;
    }
    if (page.value.overflow) gaps.add('procedure-evidence-truncated');
    const versions: string[] = [];
    for (const version of [...page.value.names].sort(compareText)) {
      const versionRoot = path.join(source.root, version);
      if ((yield* directoryState(fs, versionRoot)) !== 'directory') {
        gaps.add('procedure-evidence-unavailable');
        continue;
      }
      versions.push(version);
    }
    versionsBySource.push({source, versions});
  }

  const versionSources = roundRobin(
    EffectArray.map(versionsBySource, entry =>
      EffectArray.map(entry.versions, version => ({
        source: entry.source,
        version,
        versionRoot: path.join(entry.source.root, version),
      })),
    ),
    MAXIMUM_INSPECTED_VERSIONS,
  );
  if (
    EffectArray.some(versionsBySource, entry =>
      EffectArray.some(
        entry.versions,
        version =>
          !EffectArray.some(
            versionSources,
            candidate => candidate.source === entry.source && candidate.version === version,
          ),
      ),
    )
  ) {
    gaps.add('procedure-evidence-truncated');
  }

  const candidates: PublishedProcedureCandidate[] = [];
  for (const [index, source] of versionSources.entries()) {
    const values = yield* Effect.all(
      [
        boundedText(fs, path.join(source.versionRoot, 'manifest.json'), MAXIMUM_JSON_BYTES),
        boundedText(fs, path.join(source.versionRoot, 'receipt.json'), MAXIMUM_JSON_BYTES),
        boundedText(fs, path.join(source.versionRoot, 'artifact.txt'), MAXIMUM_ARTIFACT_BYTES),
      ],
      {concurrency: 3},
    );
    if (
      EffectAll.pipe(
        values,
        EffectArray.some((value): boolean => Option.isNone(value)),
      )
    ) {
      gaps.add('procedure-evidence-unavailable');
      continue;
    }
    const [manifestText, receiptText, artifactText] = EffectArray.map(values, Option.getOrThrow);
    const parsed = parseCandidate(manifestText, receiptText);
    if (
      parsed === undefined ||
      parsed.manifest.artifact.semanticVersion !== source.version ||
      sha256HexSync(parsed.manifest.artifact.id) !== source.source.artifactId
    ) {
      gaps.add('procedure-evidence-unavailable');
      continue;
    }
    candidates.push({
      artifactSha256: sha256HexSync(artifactText),
      manifest: parsed.manifest,
      receipt: parsed.receipt,
      team: source.source.team,
    });
    if (candidates.length >= MAXIMUM_DISCOVERED_PROCEDURES) {
      if (index < versionSources.length - 1) gaps.add('procedure-evidence-truncated');
      break;
    }
  }
  return {candidates, gaps: [...gaps].sort(compareText)} satisfies PublishedProcedureRepositoryEvidence;
});

function boundedText(fs: FileSystem.FileSystem, file: string, maximumBytes: number) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return yield* Effect.fail('invalid');
    const stat = yield* fs.stat(file);
    if (stat.type !== 'File' || stat.size > BigInt(maximumBytes)) return yield* Effect.fail('invalid');
    const bytes = yield* fs.readFile(file);
    if (bytes.byteLength > maximumBytes) return yield* Effect.fail('invalid');
    const decoded = decodeExactProcedureText(bytes);
    return decoded.ok ? decoded.text : yield* Effect.fail('invalid');
  }).pipe(Effect.option);
}

function directoryState(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) return 'invalid' as const;
    const stat = yield* Effect.result(fs.stat(directory));
    if (Result.isFailure(stat)) {
      return stat.failure instanceof PlatformError.PlatformError && stat.failure.reason._tag === 'NotFound'
        ? ('missing' as const)
        : ('invalid' as const);
    }
    return stat.success.type === 'Directory' ? ('directory' as const) : ('invalid' as const);
  });
}

function parseCandidate(manifestText: string, receiptText: string) {
  try {
    const manifest = parseProcedureManifest(JSON.parse(manifestText) as unknown);
    if (!isPublishableProcedureManifest(manifest)) return undefined;
    return {
      manifest,
      receipt: parseProcedureVerificationReceipt(JSON.parse(receiptText) as unknown),
    };
  } catch {
    return undefined;
  }
}

function roundRobin<A>(groups: readonly (readonly A[])[], limit: number): readonly A[] {
  const selected: A[] = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const group of groups) {
      const value = group[index];
      if (value === undefined) continue;
      selected.push(value);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function compareArtifactSource(left: ArtifactSource, right: ArtifactSource): number {
  return compareText(
    sha256HexSync(`${left.team}\u0000${left.artifactId}`),
    sha256HexSync(`${right.team}\u0000${right.artifactId}`),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
