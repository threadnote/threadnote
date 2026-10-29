import {Array as EffectArray} from 'effect';
import {Console, Effect, FileSystem, Path, Result} from 'effect';
import {
  enrichMemoryWithInstalledLocalAi,
  isMemoryKeywordEnrichmentEligible,
  isUnusableMemoryEnrichmentOutput,
} from '../effect/ai/enrichment.js';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {scanFilesWithinBoundary} from '@threadnote/platform/safe_scan';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {runModelInstall, runModelSelect} from '../models/commands.js';
import {resolveSelectedLocalModel} from '@threadnote/inference/models/inference';
import type {EnrichMemoriesOptions} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {parsePositiveInteger} from '../utils.js';
import {
  applyScrubber,
  assertSharedWorktreeFileReady,
  readTeamsFile,
  resolveTeam,
  resourceUriToWorktreeRelative,
  sharedTeamNameForUri,
  writeMemoryFile,
  writeSharedWorktreeFile,
} from '../share/index.js';
import {uriSegment} from '@threadnote/workspace/manifest';
import {canonicalMemoryDocumentContent, formatMemoryDocumentWithKeywords} from '@threadnote/memory/document';
import {findUrisWithDeferredCodeAnchorIntents} from './deferred/code_anchor.js';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/hygiene';
import {localUserMemoriesRoot, MemoryOperationError, NATIVE_RESOURCE_BACKEND} from './migrations.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface MemoryEnrichmentCandidate {
  readonly path: string;
  readonly priority: number;
  readonly uri: string;
}

interface MemoryEnrichmentPlan {
  readonly alreadyEnriched: number;
  readonly candidates: readonly MemoryEnrichmentCandidate[];
  readonly invalid: number;
  readonly pendingAnchors: number;
  readonly personalScanned: number;
  readonly sharedScanned: number;
  readonly skippedKinds: number;
}

export const runEnrichMemories = Effect.fn('runEnrichMemories')(function* (
  config: RuntimeConfig,
  options: EnrichMemoriesOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'memory enrichment limit') : undefined;
  yield* Console.log('Scanning personal and shared memories for enrichment eligibility...');
  const plan = yield* withSharedRepositoryLock(config, memoryEnrichmentPlan(config, options.force === true));
  const candidates = limit === undefined ? plan.candidates : plan.candidates.slice(0, limit);
  yield* Console.log(
    EffectArray.join(
      [
        `Memory enrichment: ${candidates.length} ${dryRun ? 'would be processed' : 'to process'}`,
        `${plan.alreadyEnriched} already enriched`,
        `${plan.skippedKinds} handoff/smoke memory record(s) skipped`,
        `${plan.invalid} non-memory file(s) skipped`,
        `${plan.pendingAnchors} pending-anchor memory file(s) skipped`,
        `${plan.personalScanned} personal markdown file(s) scanned`,
        `${plan.sharedScanned} shared team memory file(s) scanned`,
      ],
      '; ',
    ),
  );
  if (candidates.length === 0) {
    return;
  }
  if (dryRun) {
    for (const [index, candidate] of candidates.entries()) {
      const prefix = `[${index + 1}/${candidates.length}]`;
      yield* Console.log(`${prefix} Would enrich ${candidate.uri}`);
    }
    yield* Console.log('Run with --apply to generate and store local-model search keywords.');
    return;
  }

  const selectedGeneration = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  if (!selectedGeneration) {
    if (options.installLocalAi !== true) {
      return yield* MemoryOperationError.make({
        message:
          'No local generation model is selected. Use `threadnote models install` and `threadnote models select generation`, or rerun with `--install-local-ai`.',
      });
    }
    yield* Console.log(
      'Installing the pinned compatibility generation model before enrichment; the one-time download is 4.59 GB.',
    );
    yield* runModelInstall(config, 'gemma-4-e4b-it-q4', {});
    yield* runModelSelect(config, 'generation', 'gemma-4-e4b-it-q4', {});
  }
  yield* Console.log(
    'Generating retrieval keywords locally. This can take a long time for a large corpus; progress will stream below.',
  );

  const ov = NATIVE_RESOURCE_BACKEND;
  const fs = yield* FileSystem.FileSystem;
  let enriched = 0;
  let failed = 0;
  let noKeywords = 0;
  const enrichedSharedTeams = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    const prefix = `[${index + 1}/${candidates.length}]`;
    yield* Console.log(`${prefix} Enriching ${candidate.uri}`);
    const loaded = yield* Effect.result(fs.readFileString(candidate.path));
    if (Result.isFailure(loaded)) {
      failed += 1;
      yield* Console.error(
        `${prefix} Failed to read ${candidate.uri}: ${
          loaded.failure instanceof Error ? loaded.failure.message : String(loaded.failure)
        }`,
      );
      continue;
    }
    const record = parseMemoryDocument(candidate.uri, loaded.success);
    if (!record) {
      failed += 1;
      yield* Console.error(`${prefix} Failed ${candidate.uri}: file is no longer a valid memory document.`);
      continue;
    }
    if (!isMemoryKeywordEnrichmentEligible(record.metadata.kind)) {
      noKeywords += 1;
      yield* Console.log(`${prefix} Became ineligible since the scan; left unchanged.`);
      continue;
    }
    if (!options.force && record.metadata.keywords !== undefined) {
      noKeywords += 1;
      yield* Console.log(`${prefix} Already enriched since the scan; left unchanged.`);
      continue;
    }
    const generated = yield* Effect.result(
      enrichMemoryWithInstalledLocalAi(config, {
        body: record.body,
        kind: record.metadata.kind,
        project: record.metadata.project,
        topic: record.metadata.topic,
      }),
    );
    if (Result.isFailure(generated)) {
      if (isUnusableMemoryEnrichmentOutput(generated.failure)) {
        noKeywords += 1;
        yield* Console.log(`${prefix} No useful keywords generated; left unchanged.`);
      } else {
        failed += 1;
        yield* Console.error(
          `${prefix} Failed ${candidate.uri}: ${
            generated.failure instanceof Error ? generated.failure.message : String(generated.failure)
          }`,
        );
      }
      continue;
    }
    const keywords = generated.success;
    if (!keywords || keywords.length === 0) {
      noKeywords += 1;
      yield* Console.log(`${prefix} No useful keywords generated; left unchanged.`);
      continue;
    }
    const sharedTeam = sharedTeamNameForUri(config, candidate.uri);
    const store = withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [candidate.uri],
      Effect.gen(function* () {
        const currentContent = yield* fs.readFileString(candidate.path);
        if (canonicalMemoryDocumentContent(currentContent) !== canonicalMemoryDocumentContent(record.content)) {
          return yield* MemoryOperationError.make({
            message: `Memory changed during enrichment; left untouched so the migration can be retried.`,
          });
        }
        const content = formatMemoryDocumentWithKeywords(currentContent, keywords);
        if (sharedTeam) {
          const scrub = applyScrubber(content, {redact: false});
          if (scrub.blocker) {
            return yield* MemoryOperationError.make({
              message: `Refusing to enrich shared memory ${candidate.uri}: possible ${scrub.blocker}.`,
            });
          }
          const team = yield* resolveTeam(config, sharedTeam);
          yield* assertSharedWorktreeFileReady(
            team.config.worktree,
            resourceUriToWorktreeRelative(config, candidate.uri, team.name),
            currentContent,
          );
        }
        yield* writeMemoryFile(config, ov, candidate.uri, content, 'replace', false, {quiet: true});
        if (sharedTeam) {
          const team = yield* resolveTeam(config, sharedTeam);
          yield* writeSharedWorktreeFile(
            team.config.worktree,
            resourceUriToWorktreeRelative(config, candidate.uri, team.name),
            content,
          );
        }
      }),
    );
    const written = yield* Effect.result(sharedTeam ? withSharedRepositoryLock(config, store) : store);
    if (Result.isFailure(written)) {
      failed += 1;
      yield* Console.error(
        `${prefix} Failed to store ${candidate.uri}: ${
          written.failure instanceof Error ? written.failure.message : String(written.failure)
        }`,
      );
      continue;
    }
    enriched += 1;
    if (sharedTeam) {
      enrichedSharedTeams.set(sharedTeam, (enrichedSharedTeams.get(sharedTeam) ?? 0) + 1);
    }
    yield* Console.log(`${prefix} Stored ${keywords.length} keyword(s): ${EffectArray.join(keywords, ', ')}`);
  }
  yield* Console.log(
    `Memory enrichment summary: ${enriched} enriched; ${noKeywords} unchanged; ${failed} failed; ${candidates.length} attempted.`,
  );
  for (const [team, count] of [...enrichedSharedTeams].sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    yield* Console.log(
      `Run \`threadnote share sync --team ${team}\` to publish ${count} enriched shared ${
        count === 1 ? 'memory' : 'memories'
      }.`,
    );
  }
  if (failed > 0) {
    return yield* MemoryOperationError.make({
      message: `${failed} memory enrichment operation(s) failed. Rerun the command to resume remaining memories.`,
    });
  }
});

const memoryEnrichmentPlan = Effect.fn('memory.memoryEnrichmentPlan')(function* (
  config: RuntimeConfig,
  force: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const personalFiles = yield* scanFilesWithinBoundary(fs, root, root, {
    includeDirectory: directory => {
      const relative = Effect2.pipe(path.relative(root, directory), EffectString.split(path.sep));
      return (
        relative[0] !== 'shared' &&
        !EffectArray.some(relative, segment => Effect2.pipe(segment, EffectString.startsWith('.')))
      );
    },
    includeFile: (_filePath, name) =>
      Effect2.pipe(name, EffectString.endsWith('.md')) && !Effect2.pipe(name, EffectString.startsWith('.')),
  });
  const personal = EffectArray.map(personalFiles, file => {
    const relative = EffectArray.join(Effect2.pipe(path.relative(root, file.path), EffectString.split(path.sep)), '/');
    return {
      path: file.path,
      uri: `threadnote://user/${uriSegment(config.user)}/memories/${relative}`,
    };
  });
  const teams = yield* readTeamsFile(config);
  const sharedByTeam = yield* Effect.forEach(
    EffectRecord.toEntries(teams.teams).sort(([left], [right]) =>
      Effect2.pipe(left, EffectString.localeCompare(right)),
    ),
    ([team, settings]) =>
      Effect.gen(function* () {
        const files = yield* scanFilesWithinBoundary(fs, path.join(settings.worktree, 'durable'), settings.worktree, {
          includeDirectory: directory =>
            !EffectArray.some(
              Effect2.pipe(path.relative(settings.worktree, directory), EffectString.split(path.sep)),
              segment => Effect2.pipe(segment, EffectString.startsWith('.')),
            ),
          includeFile: (_filePath, name) =>
            Effect2.pipe(name, EffectString.endsWith('.md')) && !Effect2.pipe(name, EffectString.startsWith('.')),
        });
        return EffectArray.map(files, file => {
          const relative = EffectArray.join(
            Effect2.pipe(path.relative(settings.worktree, file.path), EffectString.split(path.sep)),
            '/',
          );
          return {
            path: file.path,
            uri: `threadnote://user/${uriSegment(config.user)}/memories/shared/${team}/${relative}`,
          };
        });
      }),
  );
  const shared = sharedByTeam.flat();
  const files = [...personal, ...shared];
  const pendingUris = yield* findUrisWithDeferredCodeAnchorIntents(
    config,
    EffectArray.map(files, file => file.uri),
  );
  const candidates: MemoryEnrichmentCandidate[] = [];
  let alreadyEnriched = 0;
  let invalid = 0;
  let pendingAnchors = 0;
  let skippedKinds = 0;
  for (const file of files) {
    const content = yield* fs.readFileString(file.path);
    const record = parseMemoryDocument(file.uri, content);
    if (!record) {
      invalid += 1;
      continue;
    }
    if (!isMemoryKeywordEnrichmentEligible(record.metadata.kind)) {
      skippedKinds += 1;
      continue;
    }
    if (pendingUris.has(file.uri)) {
      pendingAnchors += 1;
      continue;
    }
    if (!force && record.metadata.keywords !== undefined) {
      alreadyEnriched += 1;
      continue;
    }
    candidates.push({path: file.path, priority: memoryEnrichmentPriority(record), uri: file.uri});
  }
  candidates.sort(
    (left, right) => left.priority - right.priority || Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)),
  );
  return {
    alreadyEnriched,
    candidates,
    invalid,
    pendingAnchors,
    personalScanned: personal.length,
    sharedScanned: shared.length,
    skippedKinds,
  } satisfies MemoryEnrichmentPlan;
});

function memoryEnrichmentPriority(record: MemoryRecord): number {
  const statusPriority = record.metadata.status === 'active' ? 0 : record.metadata.status === 'archived' ? 10 : 20;
  const kindPriority = {
    durable: 0,
    handoff: 1,
    incident: 2,
    preference: 3,
    smoke: 4,
  }[record.metadata.kind];
  return statusPriority + kindPriority;
}
