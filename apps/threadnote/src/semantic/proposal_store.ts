import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  runtimeDirectoryNamePage,
  runtimeLstat,
  runtimeReadBoundedStableRegularFile,
  SystemInfo,
} from '@threadnote/platform/system';
import {createSemanticProposal, type SemanticProposal} from '@threadnote/semantic/proposals';
import {LspFault} from './lsp_transport.js';

export const semanticProposalStoreLimits = {
  maxBlobBytes: 8 * 1024 * 1024,
  maxRetainedBytes: 16 * 1024 * 1024,
  maxProposals: 32,
  ttlMilliseconds: 600000,
} as const;
export interface SemanticProposalHandle {
  readonly id: string;
  readonly capability: string;
  readonly digest: string;
}
const hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const handleSchema = Schema.Struct({id: hex, capability: hex, digest: hex});
const timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - semanticProposalStoreLimits.ttlMilliseconds),
);
const blobSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: hex,
  proposalDigest: hex,
  capabilityHash: hex,
  binding: hex,
  namespace: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  createdAt: timestamp,
  expiresAt: timestamp,
  proposal: Schema.Unknown,
});
const imagesSchema = Schema.Struct({
  digest: hex,
  targets: Schema.Array(Schema.Struct({afterText: Schema.String})).check(Schema.isMaxLength(1000)),
});
const clockSchema = Schema.Struct({version: Schema.Literal(1), now: timestamp});
const reject = () => LspFault.make({code: 'rejected'});
const capacity = () => LspFault.make({code: 'capacity'});
const native = <A>(run: () => Promise<A>) => fromPromiseInterruptibleAwaiting(run, reject);
const validate = <A>(run: () => A) => Effect.try({try: run, catch: reject});
const decodeText = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const tokenText = (bytes: Uint8Array): string =>
  EffectArray.join(
    EffectArray.map(Array.from(bytes), byte => EffectString.padStart(2, '0')(byte.toString(16))),
    '',
  );
interface CapabilityBinding {
  readonly id: string;
  readonly proposalDigest: string;
  readonly binding: string;
  readonly namespace: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
// Fixed-schema, domain-separated capability verifier also seals metadata that affects read eligibility.
// The secret stays out of persisted bytes; the accepted message language cannot append hash-extension data.
const capabilityVerifier = (capability: string, entry: CapabilityBinding) =>
  sha256HexSync(
    JSON.stringify([
      'threadnote-semantic-preview-v1',
      capability,
      entry.id,
      entry.proposalDigest,
      entry.binding,
      entry.namespace,
      entry.createdAt,
      entry.expiresAt,
    ]),
  );
const verifyProposal = (raw: unknown): SemanticProposal => {
  const images = Schema.decodeUnknownSync(imagesSchema)(raw);
  const rebuilt = createSemanticProposal(raw, sha256HexSync);
  if (
    images.digest !== rebuilt.digest ||
    images.targets.length !== rebuilt.targets.length ||
    !EffectArray.every(images.targets, (target, index) => target.afterText === rebuilt.targets[index].afterText)
  )
    throw reject();
  return rebuilt;
};

/** Private preview retention only. A read capability never grants observation or writer authority. */
const buildSemanticProposalStore = Effect.fn('semantic.makeProposalStore')(function* (options: {
  readonly directory: string;
  readonly namespace: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const system = yield* SystemInfo;
  const directory = path.resolve(options.directory);
  const namespace = options.namespace;
  if (
    directory !== options.directory ||
    directory === path.dirname(directory) ||
    system.userId === undefined ||
    namespace.length < 1 ||
    namespace.length > 512
  )
    return yield* reject();
  // Check existing ancestors before creating missing private components; never canonicalize a link into authority.
  const ancestors: string[] = [];
  for (let parent = directory; parent !== path.dirname(parent); parent = path.dirname(parent))
    ancestors.unshift(parent);
  for (const folder of ancestors) {
    if (!(yield* fs.exists(folder))) yield* fs.makeDirectory(folder, {mode: 0o700});
    const info = yield* native(() => runtimeLstat(folder));
    if (!info.isDirectory() || info.isSymbolicLink() || (yield* fs.realPath(folder)) !== folder) return yield* reject();
  }
  const directoryIdentity = yield* native(() => runtimeLstat(directory));
  const verifyDirectory = Effect.gen(function* () {
    const info = yield* native(() => runtimeLstat(directory));
    const stat = yield* fs.stat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== directoryIdentity.dev ||
      info.ino !== directoryIdentity.ino ||
      (stat.mode & 0o7777) !== 0o700 ||
      Option.getOrUndefined(stat.uid) !== system.userId ||
      (yield* fs.realPath(directory)) !== directory
    )
      return yield* reject();
  });
  yield* verifyDirectory;
  const inspectFile = Effect.fn('semantic.proposalInspectFile')(function* (file: string, maximum: number, links = 1n) {
    const info = yield* native(() => runtimeLstat(file));
    const stat = yield* fs.stat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (stat.mode & 0o7777) !== 0o600 ||
      Option.getOrUndefined(stat.uid) !== system.userId ||
      Option.getOrUndefined(stat.nlink) !== links ||
      Number(info.size) > maximum ||
      (yield* fs.realPath(file)) !== file
    )
      return yield* reject();
    return info;
  });
  const read = Effect.fn('semantic.proposalRead')(function* (file: string, maximum: number) {
    yield* verifyDirectory;
    const before = yield* inspectFile(file, maximum);
    const bytes = yield* native(() => runtimeReadBoundedStableRegularFile(file, maximum, before));
    const after = yield* inspectFile(file, maximum);
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs)
      return yield* reject();
    yield* verifyDirectory;
    return yield* validate(() => decodeText(bytes));
  });
  const clockFile = path.join(directory, 'clock.json');
  let lastNow = 0;
  const readBlob = Effect.fn('semantic.proposalReadBlob')(function* (id: string) {
    const raw = yield* read(path.join(directory, id + '.json'), semanticProposalStoreLimits.maxBlobBytes);
    const entry = yield* validate(() => Schema.decodeUnknownSync(blobSchema)(raw));
    if (entry.id !== id || entry.expiresAt !== entry.createdAt + semanticProposalStoreLimits.ttlMilliseconds)
      return yield* reject();
    return entry;
  });
  const removeFile = (name: string) => fs.remove(path.join(directory, name));
  const names = Effect.gen(function* () {
    yield* verifyDirectory;
    const page = yield* native(() => runtimeDirectoryNamePage(directory, 72));
    if (page.overflow) return yield* capacity();
    return yield* validate(() =>
      EffectArray.map(page.names, bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes)),
    );
  });
  const pruneAt = Effect.fn('semantic.proposalPrune')(function* (now: number) {
    let bytes = 0;
    let count = 0;
    const entries = yield* names;
    // A crash between exclusive link publication and temporary unlink leaves two names for one owned inode.
    for (const name of entries) {
      if (!/^[a-f0-9]{64}\.tmp$/u.test(name)) continue;
      const file = path.join(directory, name);
      const stat = yield* fs.stat(file);
      const links = Option.getOrUndefined(stat.nlink);
      if (links !== 1n && links !== 2n) return yield* reject();
      const info = yield* inspectFile(file, semanticProposalStoreLimits.maxBlobBytes, links);
      if (links === 2n) {
        const published = yield* inspectFile(
          path.join(directory, EffectString.slice(0, -4)(name) + '.json'),
          semanticProposalStoreLimits.maxBlobBytes,
          2n,
        );
        if (info.dev !== published.dev || info.ino !== published.ino) return yield* reject();
      }
      yield* removeFile(name);
    }
    for (const name of entries) {
      if (name === 'store.lock' || name === 'clock.json' || /^[a-f0-9]{64}\.tmp$/u.test(name)) continue;
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) return yield* reject();
      const entry = yield* readBlob(EffectString.slice(0, -5)(name));
      if (now >= entry.expiresAt || now < entry.createdAt) yield* removeFile(name);
      else {
        bytes += Number(
          (yield* inspectFile(path.join(directory, name), semanticProposalStoreLimits.maxBlobBytes)).size,
        );
        count++;
      }
    }
    if (count > semanticProposalStoreLimits.maxProposals || bytes > semanticProposalStoreLimits.maxRetainedBytes)
      return yield* capacity();
    return {bytes, count};
  });
  const writeTemporary = Effect.fn('semantic.proposalWriteTemporary')(function* (temporary: string, text: string) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
        yield* file.writeAll(new TextEncoder().encode(text));
        yield* file.sync;
      }),
    );
  });
  const nowChecked = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (!Schema.is(timestamp)(now)) return yield* reject();
    let recorded = 0;
    if (yield* fs.exists(clockFile)) {
      const raw = yield* read(clockFile, 128);
      recorded = (yield* validate(() => Schema.decodeUnknownSync(clockSchema)(raw))).now;
    } else if (EffectArray.some(yield* names, name => /^[a-f0-9]{64}\.json$/u.test(name))) {
      // Existing retained capabilities must never acquire a fresh clock history after metadata loss.
      return yield* reject();
    }
    if (now < lastNow || now < recorded) return yield* reject();
    lastNow = now;
    const temporary = path.join(directory, tokenText(yield* random.randomBytes(32)) + '.tmp');
    yield* writeTemporary(temporary, JSON.stringify({version: 1, now})).pipe(
      Effect.andThen(fs.rename(temporary, clockFile)),
      Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
    );
    yield* verifyDirectory;
    return now;
  });
  const locked = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    verifyDirectory.pipe(
      Effect.andThen(
        withExclusiveFileLock(
          fs,
          path.join(directory, 'store.lock'),
          {
            createParentDirectory: false,
            retryIntervalMilliseconds: 10,
            waitTimeoutMilliseconds: 2000,
            staleAfterMilliseconds: 60000,
            useCanonicalProcessStartIdentity: true,
          },
          Effect.uninterruptible(operation),
        ),
      ),
      Effect.mapError(error => (Schema.is(LspFault)(error) ? error : reject())),
    );
  const retain = (proposal: SemanticProposal, binding: string) =>
    locked(
      Effect.gen(function* () {
        if (!Schema.is(hex)(binding)) return yield* reject();
        const verified = yield* validate(() => verifyProposal(proposal));
        const now = yield* nowChecked;
        const quota = yield* pruneAt(now);
        const id = tokenText(yield* random.randomBytes(32));
        const capability = tokenText(yield* random.randomBytes(32));
        const expiresAt = now + semanticProposalStoreLimits.ttlMilliseconds;
        const envelope = {
          id,
          proposalDigest: verified.digest,
          binding,
          namespace,
          createdAt: now,
          expiresAt,
        };
        const text = JSON.stringify({
          version: 1,
          ...envelope,
          capabilityHash: capabilityVerifier(capability, envelope),
          proposal: verified,
        });
        const bytes = new TextEncoder().encode(text).byteLength;
        if (
          bytes > semanticProposalStoreLimits.maxBlobBytes ||
          quota.bytes + bytes > semanticProposalStoreLimits.maxRetainedBytes ||
          quota.count >= semanticProposalStoreLimits.maxProposals
        )
          return yield* capacity();
        const temporary = path.join(directory, id + '.tmp');
        yield* writeTemporary(temporary, text).pipe(
          Effect.andThen(verifyDirectory),
          // link is exclusive publication; rename would replace an existing immutable ID.
          Effect.andThen(fs.link(temporary, path.join(directory, id + '.json'))),
          Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
        );
        yield* inspectFile(path.join(directory, id + '.json'), semanticProposalStoreLimits.maxBlobBytes);
        yield* verifyDirectory;
        return {handle: {id, capability, digest: verified.digest}, createdAt: now, expiresAt};
      }),
    );
  const get = (handle: SemanticProposalHandle, binding: string) =>
    locked(
      Effect.gen(function* () {
        if (!Schema.is(handleSchema)(handle) || !Schema.is(hex)(binding)) return yield* reject();
        const now = yield* nowChecked;
        yield* pruneAt(now);
        const entry = yield* readBlob(handle.id);
        if (
          entry.binding !== binding ||
          entry.proposalDigest !== handle.digest ||
          entry.capabilityHash !== capabilityVerifier(handle.capability, entry) ||
          now < entry.createdAt ||
          now >= entry.expiresAt
        )
          return yield* reject();
        const proposal = yield* validate(() => verifyProposal(entry.proposal));
        if (proposal.digest !== handle.digest) return yield* reject();
        yield* verifyDirectory;
        const finishedAt = yield* nowChecked;
        if (finishedAt >= entry.expiresAt) return yield* reject();
        return {
          proposal,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          stale: entry.namespace !== namespace,
        };
      }),
    );
  return {
    retain,
    get,
    discard: (handle: SemanticProposalHandle, binding: string) =>
      locked(
        Effect.gen(function* () {
          if (!Schema.is(handleSchema)(handle)) return yield* reject();
          const entry = yield* readBlob(handle.id);
          if (
            entry.binding !== binding ||
            entry.proposalDigest !== handle.digest ||
            entry.namespace !== namespace ||
            entry.capabilityHash !== capabilityVerifier(handle.capability, entry)
          )
            return yield* reject();
          yield* removeFile(handle.id + '.json');
        }),
      ),
    prune: () =>
      locked(
        Effect.gen(function* () {
          yield* pruneAt(yield* nowChecked);
        }),
      ),
  };
});

export const makeSemanticProposalStore = (options: {readonly directory: string; readonly namespace: string}) =>
  buildSemanticProposalStore(options).pipe(Effect.mapError(() => reject()));
