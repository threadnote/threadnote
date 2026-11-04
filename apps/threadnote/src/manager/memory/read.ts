import {Array as EffectArray, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {memoryHeaderValue, parseMemoryDocument} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {loadMemoryRelocationIdentityWitnesses} from '@threadnote/memory/relocation';
import {classifyMemoryIdentityCandidates, MemoryIdentityResolutionError} from '@threadnote/recall/memory/identity';
import {canonicalResourceUri} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';

export const MAX_PREVIEW_IDENTITY_FILE_BYTES = 512 * 1024;
/** A header may span the entire allowed file. Never truncate it to infer absence. */
const readIdentityHeader = (fs: FileSystem.FileSystem, file: string, expectedSize: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, {flag: 'r'});
      const before = yield* handle.stat;
      if (before.type !== 'File' || Number(before.size) !== expectedSize) return undefined;
      const decoder = new TextDecoder();
      let text = '';
      let length = 0;
      let header: string | undefined;
      while (length <= expectedSize) {
        const chunk = yield* handle.readAlloc(Math.min(16 * 1024, expectedSize + 1 - length));
        if (Option.isNone(chunk)) {
          if (length !== expectedSize) return undefined;
          text += decoder.decode();
          break;
        }
        length += chunk.value.length;
        if (length > expectedSize) return undefined;
        text += decoder.decode(chunk.value, {stream: true});
        const normalized = EffectString.replace(/\r\n?/gu, '\n')(EffectString.trimStart(text));
        const separator = Option.getOrElse(EffectString.indexOf('\n\n')(normalized), () => -1);
        if (separator !== -1) {
          header = EffectString.slice(0, separator)(normalized);
          break;
        }
      }
      const after = yield* handle.stat;
      if (
        Number(after.size) !== expectedSize ||
        Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime()
      )
        return undefined;
      return header ?? EffectString.replace(/\r\n?/gu, '\n')(EffectString.trim(text));
    }),
  );
const readBoundedIdentityFile = (fs: FileSystem.FileSystem, file: string, expectedSize: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, {flag: 'r'});
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length <= expectedSize) {
        const chunk = yield* handle.readAlloc(Math.min(64 * 1024, expectedSize + 1 - length));
        if (Option.isNone(chunk)) break;
        length += chunk.value.length;
        if (length > expectedSize) return undefined;
        chunks.push(chunk.value);
      }
      if (length !== expectedSize) return undefined;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(bytes);
    }),
  );
class PreviewMemoryPathError extends Schema.TaggedError<PreviewMemoryPathError, {readonly brand: unique symbol}>()(
  'PreviewMemoryPathError',
  {message: Schema.String},
) {}

/** Reject symlinks in the managed path before reading a preview. */
export const validatePreviewMemoryPath = Effect.fn('preview.validateMemoryPath')(function* (
  root: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relative = path.relative(root, target);
  const segments = EffectString.split(path.sep)(relative);
  if (!relative || path.isAbsolute(relative))
    return yield* PreviewMemoryPathError.make({message: 'Memory preview path is outside the local corpus.'});
  let current = root;
  const rootStat = yield* fs.lstat(root);
  if (rootStat.type !== 'Directory')
    return yield* PreviewMemoryPathError.make({message: 'Memory preview path is unavailable.'});
  for (const [index, segment] of segments.entries()) {
    if (segment === '..' || segment === '.')
      return yield* PreviewMemoryPathError.make({message: 'Memory preview path is outside the local corpus.'});
    current = path.join(current, segment);
    const stat = yield* fs.lstat(current);
    if (stat.type !== (index === segments.length - 1 ? 'File' : 'Directory'))
      return yield* PreviewMemoryPathError.make({message: 'Memory preview path is unavailable.'});
  }
});

/** Resolve directly from the local corpus without opening or refreshing the recall index. */
export const resolvePreviewMemoryIdentity = Effect.fn('preview.resolveMemoryIdentity')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const memoryId = memoryIdFromIdentityAlias(uri);
  if (memoryId === undefined) return {canonicalUri: uri, requestedUri: uri};
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const user = uriSegment(config.user);
  const scope = `threadnote://user/${user}/memories`;
  const root = path.join(config.agentContextHome, 'data', config.account, 'user', user, 'memories');
  const pending = [root];
  const candidates: {uri: string; memoryId: string; status: string}[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of yield* fs.readDirectory(directory)) {
      const file = path.join(directory, name);
      const stat = yield* fs.lstat(file);
      if (stat.type === 'Directory') {
        const segments = EffectString.split(path.sep)(path.relative(root, file));
        if (
          !['archived', 'expired', 'superseded'].includes(name) &&
          !EffectArray.some(
            segments,
            (segment, index) => segment === 'packs' && segments[index - 1] === 'agent-artifacts',
          )
        )
          pending.push(file);
      } else if (
        stat.type === 'File' &&
        /\.(?:json|md|mdx|txt|yaml|yml)$/iu.test(name) &&
        !/^\.(?:abstract|overview)\.md$/u.test(name)
      ) {
        if (Number(stat.size) > MAX_PREVIEW_IDENTITY_FILE_BYTES) continue;
        const header = yield* readIdentityHeader(fs, file, Number(stat.size));
        if (header === undefined)
          return yield* MemoryIdentityResolutionError.make({
            memoryId,
            reason: 'ambiguous',
            message: 'Local memory identity scan changed during reading.',
          });
        if (memoryHeaderValue(header, 'memory_id') !== memoryId) continue;
        const segments = EffectArray.map(
          EffectString.split(path.sep)(path.relative(root, file)),
          EffectString.normalize('NFC'),
        );
        const candidateUri = canonicalResourceUri('user', [config.user, 'memories', ...segments]);
        const content = yield* readBoundedIdentityFile(fs, file, Number(stat.size));
        if (content === undefined)
          return yield* MemoryIdentityResolutionError.make({
            memoryId,
            reason: 'ambiguous',
            message: 'Local memory identity scan changed during reading.',
          });
        const record = parseMemoryDocument(candidateUri, content);
        if (record?.metadata.memoryId === memoryId)
          candidates.push({uri: candidateUri, memoryId, status: record.metadata.status});
      }
    }
  }
  if (candidates.length > 1)
    return yield* MemoryIdentityResolutionError.make({
      memoryId,
      reason: 'ambiguous',
      message: 'Stable memory identity is ambiguous.',
    });
  const found = classifyMemoryIdentityCandidates(candidates, memoryId, [scope]);
  if (found.state === 'resolved') return {canonicalUri: found.uri, expectedMemoryId: memoryId, requestedUri: uri};
  if (found.state === 'not-found') {
    const witnesses = yield* loadMemoryRelocationIdentityWitnesses(config, [memoryId], [scope]);
    const witnessed = classifyMemoryIdentityCandidates(witnesses, memoryId, [scope]);
    if (witnessed.state === 'resolved')
      return {
        canonicalUri: witnessed.uri,
        expectedMemoryId: memoryId,
        identityWitness: 'private-relocation-receipt' as const,
        requestedUri: uri,
      };
    if (witnessed.state === 'ambiguous')
      return yield* MemoryIdentityResolutionError.make({
        memoryId,
        reason: 'ambiguous',
        message: 'Stable memory identity is ambiguous.',
      });
  }
  return yield* MemoryIdentityResolutionError.make({
    memoryId,
    reason: found.state,
    message: 'Stable memory identity is unavailable or ambiguous.',
  });
});
