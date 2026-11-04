import {Array as EffectArray, Effect, FileSystem, Path, String as EffectString} from 'effect';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {loadMemoryRelocationIdentityWitnesses} from '@threadnote/memory/relocation';
import {classifyMemoryIdentityCandidates, MemoryIdentityResolutionError} from '@threadnote/recall/memory/identity';
import {canonicalResourceUri} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';

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
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of yield* fs.readDirectory(directory)) {
      if (++count > 100_000)
        return yield* MemoryIdentityResolutionError.make({
          memoryId,
          reason: 'ambiguous',
          message: 'Local memory identity scan exceeded its limit.',
        });
      const file = path.join(directory, name);
      const stat = yield* fs.lstat(file);
      if (stat.type === 'Directory') {
        if (!['archived', 'expired', 'superseded'].includes(name)) pending.push(file);
      } else if (
        stat.type === 'File' &&
        /\.(?:json|md|mdx|txt|yaml|yml)$/iu.test(name) &&
        !/^\.(?:abstract|overview)\.md$/u.test(name)
      ) {
        if (Number(stat.size) > 512 * 1024)
          return yield* MemoryIdentityResolutionError.make({
            memoryId,
            reason: 'ambiguous',
            message: 'Local memory identity scan encountered an oversized file.',
          });
        const segments = EffectArray.map(
          EffectString.split(path.sep)(path.relative(root, file)),
          EffectString.normalize('NFC'),
        );
        const candidateUri = canonicalResourceUri('user', [config.user, 'memories', ...segments]);
        const record = parseMemoryDocument(candidateUri, yield* fs.readFileString(file));
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
