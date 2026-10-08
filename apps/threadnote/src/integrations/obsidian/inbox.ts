import {Console, Crypto, DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import * as yaml from 'js-yaml';
import {
  buildCandidateReview,
  readActiveProjectMemories,
  saveCandidateReview,
  type CandidateReview,
  type SessionCloseoutInput,
  validateSessionCloseoutInput,
} from '@threadnote/memory/candidate';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {scanFilesWithinBoundary} from '@threadnote/platform/safe_scan';
import {readObsidianConfiguration, requireObsidianSource} from '../config.js';
import {scrubberBlocker} from '@threadnote/platform/scrubber';
import type {MemoryKind} from '@threadnote/memory/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isJsonObject, toPosixPath} from '../../utils.js';

class ObsidianInboxError extends Schema.TaggedError<ObsidianInboxError>()('ObsidianInboxError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface ObsidianInboxScanOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly source: string;
}

interface ObsidianInboxStateEntry {
  readonly contentHash: string;
  readonly reviewId: string;
  readonly reviewedAt: string;
}

interface ObsidianInboxState {
  readonly entries: Readonly<Record<string, ObsidianInboxStateEntry>>;
  readonly sourceId: string;
  readonly version: 1;
}

interface ParsedInboxNote {
  readonly body: string;
  readonly category?: 'decision' | 'invariant';
  readonly evidence: readonly string[];
  readonly kind: Extract<MemoryKind, 'durable' | 'handoff' | 'preference'>;
  readonly project: string;
  readonly topic: string;
}

const INBOX_STATE_VERSION = 1;
const INBOX_STATE_FILENAME = 'state-v1.json';
const INBOX_LOCK_RETRY_MILLISECONDS = 25;
const INBOX_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const INBOX_LOCK_WAIT_MILLISECONDS = 10_000;
const INBOX_LOCK_OPTIONS = {
  retryIntervalMilliseconds: INBOX_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: INBOX_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: INBOX_LOCK_WAIT_MILLISECONDS,
} as const;
const INBOX_FILE_MODE = 0o600;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export const runObsidianInboxScan = Effect.fn('obsidian.inboxScan')(function* (
  config: RuntimeConfig,
  options: ObsidianInboxScanOptions,
) {
  const apply = options.apply === true && options.dryRun !== true;
  const source = requireObsidianSource(yield* readObsidianConfiguration(config), options.source);
  if (!source.inbox) {
    return yield* ObsidianInboxError.make({
      message: `Obsidian source "${source.id}" has no Inbox. Configure one with source add --inbox.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const inboxRoot = pathService.join(source.vault, ...source.inbox.split('/'));
  if (!(yield* fs.exists(inboxRoot))) {
    return yield* ObsidianInboxError.make({message: `Configured Obsidian Inbox does not exist: ${source.inbox}`});
  }
  const statePath = yield* inboxStatePath(config, source.id);
  return yield* withExclusiveFileLock(
    fs,
    `${statePath}.lock`,
    INBOX_LOCK_OPTIONS,
    Effect.gen(function* () {
      const state = yield* readInboxState(statePath, source.id);
      const files = yield* scanFilesWithinBoundary(fs, inboxRoot, source.vault, {
        includeFile: path => pathService.extname(path).toLowerCase() === '.md',
        recursive: false,
      });
      if (files.length === 0) {
        yield* Console.log(`Obsidian Inbox "${source.inbox}" contains no eligible Markdown notes.`);
        return [] satisfies readonly CandidateReview[];
      }
      const now = yield* DateTime.nowAsDate;
      const nextEntries = {...state.entries};
      const reviews: CandidateReview[] = [];
      for (const file of files) {
        const relativePath = toPosixPath(pathService.relative(inboxRoot, file.path));
        const content = yield* fs.readFileString(file.path);
        const blocker = scrubberBlocker(content);
        if (blocker) {
          yield* Console.log(`SKIP ${relativePath}: possible ${blocker}.`);
          continue;
        }
        const parsed = yield* Effect.try({
          try: () => parseObsidianInboxNote(content, relativePath),
          catch: cause =>
            Schema.is(ObsidianInboxError)(cause)
              ? cause
              : ObsidianInboxError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
        }).pipe(
          Effect.catch(error => Console.log(`SKIP ${relativePath}: ${error.message}`).pipe(Effect.as(undefined))),
        );
        if (!parsed) {
          continue;
        }
        const contentHash = yield* sha256Hex(content);
        const recorded = state.entries[relativePath];
        if (recorded?.contentHash === contentHash) {
          yield* Console.log(`UNCHANGED ${relativePath} · review ${recorded.reviewId}`);
          continue;
        }
        const closeout = closeoutForInbox(source.id, relativePath, contentHash, parsed);
        const validationError = validateSessionCloseoutInput(closeout);
        if (validationError) {
          yield* Console.log(`SKIP ${relativePath}: ${validationError}`);
          continue;
        }
        const existing = yield* readActiveProjectMemories(config, parsed.project);
        const review = yield* buildCandidateReview(closeout, existing, now);
        reviews.push(review);
        yield* printInboxReview(relativePath, review, apply);
        if (!apply) {
          continue;
        }
        yield* saveCandidateReview(config.agentContextHome, review);
        nextEntries[relativePath] = {
          contentHash,
          reviewId: review.reviewId,
          reviewedAt: now.toISOString(),
        };
      }
      if (apply) {
        yield* writeInboxState(statePath, {
          entries: nextEntries,
          sourceId: source.id,
          version: INBOX_STATE_VERSION,
        });
        yield* Console.log(
          reviews.length > 0
            ? `Created ${reviews.length} candidate review(s). Review them in the agent workflow or Candidate Inbox.`
            : 'No new candidate reviews were created.',
        );
      } else {
        yield* Console.log('Dry run complete. Re-run with --apply to persist these candidate reviews.');
      }
      return reviews;
    }),
  );
});

export function parseObsidianInboxNote(content: string, label = 'Inbox note'): ParsedInboxNote {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    throw ObsidianInboxError.make({message: 'missing YAML frontmatter'});
  }
  const loaded = yaml.load(match[1] ?? '');
  if (!isJsonObject(loaded)) {
    throw ObsidianInboxError.make({message: 'frontmatter must be an object'});
  }
  if (loaded.threadnote_candidate !== true) {
    throw ObsidianInboxError.make({message: 'threadnote_candidate must be true'});
  }
  const kind = inboxKind(loaded.kind);
  const project = requiredMetadataString(loaded.project, 'project');
  const topic = requiredMetadataString(loaded.topic, 'topic');
  const category =
    loaded.category === undefined
      ? undefined
      : loaded.category === 'decision' || loaded.category === 'invariant'
        ? loaded.category
        : (() => {
            throw ObsidianInboxError.make({message: 'category must be decision or invariant'});
          })();
  const evidence =
    loaded.evidence === undefined
      ? []
      : Array.isArray(loaded.evidence) && loaded.evidence.every(value => typeof value === 'string')
        ? loaded.evidence.map(value => value.trim()).filter(Boolean)
        : (() => {
            throw ObsidianInboxError.make({message: 'evidence must be a string array'});
          })();
  const body = content.slice(match[0].length).trim();
  if (!body) {
    throw ObsidianInboxError.make({message: `${label} has an empty body`});
  }
  return {body, category, evidence, kind, project, topic};
}

function closeoutForInbox(
  sourceId: string,
  relativePath: string,
  contentHash: string,
  note: ParsedInboxNote,
): SessionCloseoutInput {
  const evidence = [`obsidian:${sourceId}/${relativePath}`, `sha256:${contentHash}`, ...note.evidence];
  return {
    ...(note.kind === 'durable' && note.category === 'invariant'
      ? {invariants: [note.body]}
      : note.kind === 'durable'
        ? {decisions: [note.body]}
        : note.kind === 'handoff'
          ? {handoff: [note.body]}
          : {preferences: [note.body]}),
    evidence,
    outcome: `Reviewed an explicit Obsidian Inbox candidate for ${note.project}/${note.topic}.`,
    project: note.project,
    sourceAgentClient: 'obsidian-inbox',
    sourceSessionId: `obsidian:${sourceId}:${contentHash.slice(0, 20)}`,
    task: `Import Obsidian Inbox note ${relativePath}`,
    topic: note.topic,
  };
}

const printInboxReview = Effect.fn('obsidian.printInboxReview')(function* (
  relativePath: string,
  review: CandidateReview,
  applying: boolean,
) {
  yield* Console.log(`${applying ? 'CREATE' : 'WOULD CREATE'} ${relativePath} · review ${review.reviewId}`);
  for (const candidate of review.candidates) {
    yield* Console.log(
      `  ${candidate.recommendation} · ${candidate.kind}/${candidate.project}/${candidate.topic} · ${candidate.reason}`,
    );
  }
});

const inboxStatePath = Effect.fn('obsidian.inboxStatePath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  sourceId: string,
) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'threadnote', 'inbox', 'obsidian', sourceId, INBOX_STATE_FILENAME);
});

const readInboxState = Effect.fn('obsidian.readInboxState')(function* (path: string, sourceId: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) {
    return emptyInboxState(sourceId);
  }
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseInboxState(JSON.parse(raw), sourceId),
    catch: cause =>
      Schema.is(ObsidianInboxError)(cause)
        ? cause
        : ObsidianInboxError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

const writeInboxState = Effect.fn('obsidian.writeInboxState')(function* (path: string, state: ObsidianInboxState) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
  const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, {mode: INBOX_FILE_MODE});
  yield* fs
    .rename(temporaryPath, path)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  yield* fs.chmod(path, INBOX_FILE_MODE);
});

function parseInboxState(value: unknown, sourceId: string): ObsidianInboxState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== INBOX_STATE_VERSION ||
    !('sourceId' in value) ||
    value.sourceId !== sourceId ||
    !('entries' in value) ||
    typeof value.entries !== 'object' ||
    value.entries === null
  ) {
    throw ObsidianInboxError.make({message: `Invalid Obsidian Inbox state for "${sourceId}".`});
  }
  const entries: Record<string, ObsidianInboxStateEntry> = {};
  for (const [relativePath, entry] of Object.entries(value.entries)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('contentHash' in entry) ||
      typeof entry.contentHash !== 'string' ||
      !('reviewId' in entry) ||
      typeof entry.reviewId !== 'string' ||
      !('reviewedAt' in entry) ||
      typeof entry.reviewedAt !== 'string'
    ) {
      throw ObsidianInboxError.make({message: `Invalid Obsidian Inbox state entry "${relativePath}".`});
    }
    entries[relativePath] = {
      contentHash: entry.contentHash,
      reviewId: entry.reviewId,
      reviewedAt: entry.reviewedAt,
    };
  }
  return {entries, sourceId, version: INBOX_STATE_VERSION};
}

function emptyInboxState(sourceId: string): ObsidianInboxState {
  return {entries: {}, sourceId, version: INBOX_STATE_VERSION};
}

function inboxKind(value: unknown): ParsedInboxNote['kind'] {
  if (value === 'durable' || value === 'handoff' || value === 'preference') {
    return value;
  }
  throw ObsidianInboxError.make({message: 'kind must be durable, handoff, or preference'});
}

function requiredMetadataString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ObsidianInboxError.make({message: `${label} must be a non-empty string`});
  }
  return value.trim();
}
