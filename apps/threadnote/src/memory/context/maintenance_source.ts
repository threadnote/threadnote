import {Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {assertSafeRelativePath} from '@threadnote/platform/paths';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readContextMaintenanceCitationAssociation} from './maintenance_evidence.js';

export type MaintenanceCitationAssociation = Effect.Success<
  ReturnType<typeof readContextMaintenanceCitationAssociation>
>;

const readRecordSourceAssociation = Effect.fn('contextMaintenance.recordAssociation')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  cwd: string,
) {
  const citations = [
    ...new Map(
      (record.metadata.codeCitations ?? []).map(citation => [
        `${citation.repositoryId}:${citation.sourceCommit}`,
        citation,
      ]),
    ).values(),
  ];
  const parts: MaintenanceCitationAssociation[] = [];
  for (let offset = 0; offset < Math.max(1, citations.length); offset += 32)
    parts.push(yield* readContextMaintenanceCitationAssociation(config, cwd, citations.slice(offset, offset + 32)));
  const bySelector = Object.fromEntries(
    parts.flatMap(part => Object.entries(part.bySelector)).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    epoch: sha256HexSync(JSON.stringify([citations.length, bySelector])),
    bySelector,
    roots: [...new Set(parts.flatMap(part => part.roots))],
    sourceEpochs: Object.assign({}, ...parts.map(part => part.sourceEpochs)),
  } satisfies MaintenanceCitationAssociation;
});

export function projectMaintenanceCitationAssociation(
  record: MemoryRecord,
  association: MaintenanceCitationAssociation,
) {
  const selectors = [
    ...new Set(
      (record.metadata.codeCitations ?? []).map(citation => `${citation.repositoryId}:${citation.sourceCommit}`),
    ),
  ].sort();
  return sha256HexSync(
    JSON.stringify([
      selectors.length,
      Object.fromEntries(
        selectors.flatMap(selector => {
          const epoch = association.bySelector[selector];
          return epoch === undefined ? [] : [[selector, epoch]];
        }),
      ),
    ]),
  );
}

export const recordSourceRevision = Effect.fn('contextMaintenance.recordSourceRevision')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  cwd: string,
  observed?: MaintenanceCitationAssociation,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const association = observed ?? (yield* readRecordSourceAssociation(config, record, cwd));
  return sha256HexSync(
    projectMaintenanceCitationAssociation(record, association) +
      (yield* Effect.forEach(
        [...new Set((record.metadata.codeCitations ?? []).map(citation => citation.path))],
        relative =>
          Effect.gen(function* () {
            const safe = yield* Effect.try(() => assertSafeRelativePath(relative));
            const root = yield* fs.realPath(cwd);
            const file = yield* fs.realPath(path.join(root, safe));
            const contained = path.relative(root, file);
            if (contained.startsWith('..') || path.isAbsolute(contained)) return `${relative}:outside-root`;
            const info = yield* fs.stat(file);
            return `${relative}:${Number(info.size)}:${JSON.stringify(info.mtime)}`;
          }).pipe(Effect.orElseSucceed(() => `${relative}:unavailable`)),
        {concurrency: 16},
      )).join('\n'),
  );
});
