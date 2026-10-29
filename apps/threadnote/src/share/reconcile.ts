import {Array as EffectArray} from 'effect';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {Command} from 'effect/cli';
import {argument, boolean, optionalString} from '../effect/cli/flags.js';
import {
  assertMemoryDocumentSchemaWritable,
  parseMemoryDocument,
  parseMemoryRelationValue,
} from '@threadnote/memory/document';
import {isMemoryId, memoryIdentityLockKey} from '@threadnote/memory/identity-alias';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {ShareRuntime} from '../types.js';
import {runCommand} from '../utils.js';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {
  assertSafeShareRelativePath,
  prepareSharedInboundContentEffect,
  resolveTeam,
  resourceStoreLocation,
  resourceUriToWorktreeRelative,
  sharedMemoryUriParts,
  teamsFilePath,
} from './core.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface ShareReconcileOptions {
  readonly apply?: boolean;
  readonly plan?: string;
  readonly approvalDigest?: string;
}

export function makeShareReconcileCommand<E, R>(
  handler: (uri: string, options: ShareReconcileOptions) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'reconcile',
    {
      uri: argument('canonical-shared-uri', 'Existing canonical shared durable memory URI'),
      apply: boolean('apply', 'Apply an explicitly approved saved reconciliation preview'),
      plan: optionalString('plan', 'Saved JSON reconciliation preview'),
      approvalDigest: optionalString('approval-digest', 'Approval digest from the reviewed preview'),
    },
    ({uri, ...options}) => handler(uri, options),
  ).pipe(Command.withDescription('Preview or apply one guarded committed shared memory import'));
}

export class ShareReconcileError extends Schema.TaggedError<ShareReconcileError, {readonly brand: unique symbol}>()(
  'ShareReconcileError',
  {
    message: Schema.String,
  },
) {}
const fail = (message: string) => ShareReconcileError.make({message});
const hash = (text: string | Uint8Array) => sha256HexSync(text);
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const fields = {
  version: Schema.Literal(1),
  uri: Schema.String,
  team: Schema.String,
  configSha256: digest,
  head: gitObject,
  relativePath: Schema.String,
  blob: gitObject,
  rawSha256: digest,
  inboundSha256: digest,
  nativeSha256: digest,
  memoryId: Schema.String,
  createdAt: Schema.String,
};
const planSchema = Schema.Struct({...fields, approvalDigest: digest});
export type ShareReconcilePlan = typeof planSchema.Type;
const planKeys = [...EffectRecord.keys(fields), 'approvalDigest'];
// Fixed field order gives approvals a stable data encoding independent of JSON key order.
const approval = (plan: Omit<ShareReconcilePlan, 'approvalDigest'>) =>
  hash(JSON.stringify(EffectArray.map(EffectRecord.keys(fields), key => [key, plan[key]])));

/** Closed-schema data parser; does not read files or execute values from a saved preview. */
export function parseShareReconcilePlan(input: unknown, uri: string, approvalDigest: string): ShareReconcilePlan {
  if (
    typeof input !== 'object' ||
    input === null ||
    EffectArray.isArray(input) ||
    EffectRecord.keys(input).length !== planKeys.length ||
    EffectArray.some(EffectRecord.keys(input), key => !planKeys.includes(key))
  )
    throw fail('Reconciliation requires an exact closed-schema saved preview.');
  const plan = Schema.decodeUnknownSync(planSchema)(input);
  if (plan.uri !== uri || plan.approvalDigest !== approvalDigest || approval(plan) !== approvalDigest)
    throw fail('Reconciliation URI or approval digest does not match the saved preview.');
  return plan;
}

const git = Effect.fn('share.reconcile.git')(function* (cwd: string, args: readonly string[]) {
  return (yield* runCommand('git', ['--no-optional-locks', '--no-replace-objects', ...args], {cwd})).stdout;
});

function validateMemory(uri: string, content: string, project: string, topic: string) {
  assertMemoryDocumentSchemaWritable(content);
  const record = parseMemoryDocument(uri, content);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const header = Effect2.pipe(Effect2.pipe(content, EffectString.trim).split('\n\n', 1)[0], EffectString.split('\n'));
  const single = (key: string, expected?: string) => {
    const lines = EffectArray.filter(
      header,
      __effectArrayValue => !!(line => new RegExp(`^\\s*${key}\\s*:`, 'u').test(line))(__effectArrayValue),
    );
    return lines.length === 1 && lines[0] === `${key}: ${expected}`;
  };
  const metadata = record?.metadata;
  if (
    !record ||
    record.headerTitle !== 'MEMORY' ||
    !metadata ||
    !single('kind', 'durable') ||
    !single('status', 'active') ||
    !single('visibility', 'shared') ||
    !single('project', project) ||
    !single('topic', topic) ||
    !metadata.memoryId ||
    !isMemoryId(metadata.memoryId) ||
    !single('memory_id', metadata.memoryId) ||
    !metadata.createdAt ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    !single('created_at', metadata.createdAt) ||
    metadata.citationErrors?.length ||
    metadata.consolidationError ||
    metadata.reviewedSupportError ||
    metadata.topicMaintenanceError ||
    metadata.sourceEvidenceError ||
    metadata.obsidianEvidenceError ||
    EffectArray.some(
      header,
      line =>
        /^\s*relation\s*:/u.test(line) &&
        (!Effect2.pipe(line, EffectString.startsWith('relation: ')) ||
          !parseMemoryRelationValue(Effect2.pipe(line, EffectString.slice('relation: '.length)))),
    )
  )
    throw fail('Reconciliation requires valid active shared durable metadata and established identity.');
  return {memoryId: metadata.memoryId, createdAt: metadata.createdAt};
}

/** F001: the approved native revision includes every UTF-8 byte, including a leading BOM. */
const readExistingNativeContent = Effect.fn('share.reconcile.readExistingNativeContent')(function* (
  config: ShareRuntime,
  uri: string,
) {
  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  // Preserve the existing-only root/existence check. Its default decoded text is
  // deliberately discarded: only the lossless bounded read below is authority.
  yield* store.read(location, uri, {existingOnly: true});
  const stat = yield* store.stat(location, uri);
  if (stat.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size >= Number.MAX_SAFE_INTEGER)
    return yield* fail('Native preimage has an invalid byte size.');
  // Bound allocation by this existing resource's observed size, never a sentinel
  // maximum. ResourceStore checks path/open-file safety and fatal UTF-8 decoding.
  const result = yield* store.readBounded(location, uri, stat.size);
  if (result.truncated || new TextEncoder().encode(result.content).length !== stat.size)
    return yield* fail('Native preimage changed size or its bounded read was truncated.');
  return result.content;
});

/** Reads only committed source objects and existing native resources; shared input is never executable authority. */
const inspect = Effect.fn('share.reconcile.inspect')(function* (config: ShareRuntime, uri: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resource = yield* Effect.try(() => parseResourceId(uri));
  const parts = sharedMemoryUriParts(config, uri);
  if (
    resource.canonicalUri !== uri ||
    resource.anchor !== undefined ||
    !Effect2.pipe(uri, EffectString.endsWith('.md')) ||
    !parts?.kind ||
    !parts.project ||
    !parts.topic
  )
    return yield* fail('Reconciliation requires one canonical shared durable memory URI.');
  const team = yield* resolveTeam(config, parts.team);
  const relativePath = yield* Effect.try(() =>
    assertSafeShareRelativePath(resourceUriToWorktreeRelative(config, uri, team.name)),
  );
  const worktree = yield* fs.realPath(team.config.worktree);
  const gitdir = yield* fs.realPath(team.config.gitdir);
  const actualRoot = yield* fs.realPath(
    Effect2.pipe(yield* git(worktree, ['rev-parse', '--show-toplevel']), EffectString.trim),
  );
  const actualGitdir = yield* fs.realPath(
    Effect2.pipe(yield* git(worktree, ['rev-parse', '--absolute-git-dir']), EffectString.trim),
  );
  if (worktree !== actualRoot || gitdir !== actualGitdir)
    return yield* fail('Configured shared repository identity does not match Git.');
  const configSha256 = hash(
    JSON.stringify({
      account: config.account,
      user: config.user,
      agentId: config.agentId,
      home: yield* fs.realPath(config.agentContextHome),
      teams: yield* fs.readFileString(yield* teamsFilePath(config)),
      worktree,
      gitdir,
      gitConfig: yield* git(worktree, ['config', '--local', '--list', '--null']),
    }),
  );
  const head = Effect2.pipe(yield* git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']), EffectString.trim);
  // Literal pathspecs prevent wildcard/magic interpretation. All tracked/untracked dirt is rejected.
  if (
    (yield* git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length ||
    (yield* git(worktree, ['status', '--porcelain=v1', '-z', '--ignored', '--', `:(literal)${relativePath}`])).length
  )
    return yield* fail('Shared repository or selected path is dirty.');
  const tree = yield* git(worktree, ['ls-tree', '-z', head, '--', `:(literal)${relativePath}`]);
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(tree);
  if (!match || match[3] !== relativePath)
    return yield* fail('Selected committed path is missing or is not one regular Git blob.');
  const file = path.join(worktree, relativePath);
  if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== 'File')
    return yield* fail('Selected shared path must be a regular file without symlink traversal.');
  const rawBytes = (yield* runBinaryCommandEffect(
    'git',
    ['--no-optional-locks', '--no-replace-objects', 'show', `${head}:${relativePath}`, '--'],
    {cwd: worktree},
  )).stdout;
  const raw = yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(rawBytes));
  if (hash(yield* fs.readFile(file)) !== hash(rawBytes))
    return yield* fail('Shared worktree bytes differ from the committed blob.');
  const inbound = yield* prepareSharedInboundContentEffect(uri, raw);
  // Canonical outer whitespace is allowed; no approved header or body may be stripped or rewritten.
  if (inbound !== Effect2.pipe(raw, EffectString.trim))
    return yield* fail('Shared inbound projection changes the approved content.');
  const identity = yield* Effect.try(() => validateMemory(uri, inbound, parts.project!, parts.topic!));
  const native = yield* readExistingNativeContent(config, uri);
  const nativeIdentity = yield* Effect.try(() => validateMemory(uri, native, parts.project!, parts.topic!));
  if (identity.memoryId !== nativeIdentity.memoryId || identity.createdAt !== nativeIdentity.createdAt)
    return yield* fail('Shared and native memory identity or creation time differ.');
  const preimage = {
    version: 1 as const,
    uri,
    team: team.name,
    configSha256,
    head,
    relativePath,
    blob: match[2],
    rawSha256: hash(rawBytes),
    inboundSha256: hash(inbound),
    nativeSha256: hash(native),
    ...identity,
  };
  return {plan: {...preimage, approvalDigest: approval(preimage)}, inbound, native};
});

export const previewShareReconcile = Effect.fn('share.reconcile.preview')(function* (
  config: ShareRuntime,
  uri: string,
) {
  return (yield* inspect(config, uri)).plan;
});

export const applyShareReconcile = Effect.fn('share.reconcile.apply')(function* (
  config: ShareRuntime,
  uri: string,
  input: unknown,
  approvalDigest: string,
) {
  const plan = yield* Effect.try(() => parseShareReconcilePlan(input, uri, approvalDigest));
  const fs = yield* FileSystem.FileSystem;
  return yield* withSharedRepositoryLock(
    config,
    withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri, memoryIdentityLockKey(plan.memoryId)],
      Effect.gen(function* () {
        const current = yield* inspect(config, uri);
        if (current.plan.approvalDigest !== plan.approvalDigest)
          return yield* fail('Reconciliation preimages changed; create and review a fresh preview.');
        if (current.native === current.inbound) return {uri, status: 'already-current' as const};
        const store = yield* ResourceStore;
        // Recheck BOTH systems inside ResourceStore's account mutation lock immediately before replacement.
        // Cooperative locks cannot fence a noncooperating external Git writer after this guard.
        yield* store.writeChecked(
          resourceStoreLocation(config),
          uri,
          current.inbound,
          {mode: 'replace'},
          Effect.gen(function* () {
            if ((yield* inspect(config, uri)).plan.approvalDigest !== plan.approvalDigest)
              return yield* fail('Reconciliation preimages changed before the checked write.');
          }),
        );
        if ((yield* readExistingNativeContent(config, uri)) !== current.inbound)
          return yield* fail('Reconciliation native readback differs from the approved projection.');
        return {uri, status: 'reconciled' as const};
      }),
    ),
  );
});

export const runShareReconcile = Effect.fn('share.reconcile.command')(function* (
  config: ShareRuntime,
  uri: string,
  options: ShareReconcileOptions = {},
) {
  if (options.apply !== true) {
    if (options.plan !== undefined || options.approvalDigest !== undefined)
      return yield* fail('Saved plans and approval digests require explicit --apply.');
    yield* Console.log(JSON.stringify(yield* previewShareReconcile(config, uri), undefined, 2));
    return;
  }
  if (!options.plan || !options.approvalDigest)
    return yield* fail('Apply requires --plan <saved-preview.json> and --approval-digest <digest>.');
  const fs = yield* FileSystem.FileSystem;
  const input: unknown = yield* fs
    .readFileString(options.plan)
    .pipe(Effect.flatMap(text => Effect.try(() => JSON.parse(text))));
  yield* Console.log(
    JSON.stringify(yield* applyShareReconcile(config, uri, input, options.approvalDigest), undefined, 2),
  );
});
