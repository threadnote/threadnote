import {Clock, Effect, Random, Redacted, Result} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSourceConfiguration, requireLinearSource, sourceConfigurationFingerprint} from './config.js';
import {LINEAR_MAX_COLLECTION_ITEMS} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {createLinearClient, LinearClientError, type LinearClientOptions} from './client.js';
import {resolveLinearCredential} from './credentials.js';
import {linearDocumentId, renderLinearIssue, renderLinearProject} from './render.js';
import {clearLinearSyncState, readLinearSyncState, writeLinearSyncState, type LinearSyncState} from './state.js';
import {
  configFence,
  listLocalDocuments,
  quarantineObject,
  receipt,
  removeObject,
  saveReceipt,
  sourceError,
  writeObject,
} from './storage.js';
export interface LinearSyncResult {
  readonly sourceId: string;
  readonly syncedDocuments: readonly string[];
  readonly warnings: readonly string[];
  readonly progress?: {readonly completed: number; readonly total: number};
}
export const call = <A>(f: () => Promise<A>) =>
  fromPromiseInterruptible(f, error =>
    error instanceof LinearClientError ? error : new LinearClientError({code: 'transport-rejected'}),
  );
export const syncLinearSource = Effect.fn('linear.syncSource')(function* (
  config: RuntimeConfig,
  id: string,
  options: LinearClientOptions = {},
  onlyDue = false,
) {
  return yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const source = requireLinearSource(yield* readSourceConfiguration(config), id);
      if (!source.enabled) return yield* sourceError('Linear source is disabled.');
      const fingerprint = sourceConfigurationFingerprint(source);
      const now = yield* Clock.currentTimeMillis;
      let access = yield* receipt(config, id);
      if (access === null) return yield* sourceError('Linear source access receipt is invalid.');
      if (access?.status === 'cleanup')
        return yield* sourceError('Linear source cleanup must complete before refresh.');
      if (access?.nextAttemptAt !== undefined && access.nextAttemptAt > now)
        return {
          sourceId: id,
          syncedDocuments: [],
          warnings: ['Linear provider retry is deferred.'],
        } satisfies LinearSyncResult;
      let state = yield* readLinearSyncState(config, id);
      if (state === null) return yield* sourceError('Linear sync state is invalid.');
      if (state && (state.fingerprint !== fingerprint || state.accessEpoch !== access?.accessEpoch)) {
        yield* clearLinearSyncState(config, id);
        state = undefined;
      }
      const token = yield* resolveLinearCredential(config, source).pipe(Effect.result);
      if (Result.isFailure(token)) {
        const denied = access ?? {
          version: 1 as const,
          provider: 'linear' as const,
          sourceId: id,
          accessEpoch: sha256HexSync(`${now}:${yield* Random.next}`),
          status: 'authentication-rejected' as const,
        };
        yield* saveReceipt(config, source, {...denied, status: 'authentication-rejected'});
        return {
          sourceId: id,
          syncedDocuments: [],
          warnings: ['Linear credential is unavailable.'],
        } satisfies LinearSyncResult;
      }
      const credentialFingerprint = sha256HexSync(Redacted.value(token.success));
      if (
        onlyDue &&
        !state &&
        access?.status === 'active' &&
        access.credentialFingerprint === credentialFingerprint &&
        access.completedAt !== undefined &&
        now - access.completedAt < source.refreshIntervalMinutes * 60000
      )
        return {sourceId: id, syncedDocuments: [], warnings: []} satisfies LinearSyncResult;
      if (!access || access.status !== 'active' || access.credentialFingerprint !== credentialFingerprint) {
        if (state) {
          yield* clearLinearSyncState(config, id);
          state = undefined;
        }
        access = {
          version: 1,
          provider: 'linear',
          sourceId: id,
          status: 'active',
          credentialFingerprint,
          accessEpoch: sha256HexSync(`${now}:${yield* Random.next}`),
        };
      }
      const client = createLinearClient(token.success, options);
      const syncedDocuments: string[] = [];
      const warnings: string[] = [];
      const fence = configFence(config, id, fingerprint);
      let current: LinearSyncState = state ?? {
        version: 1,
        fingerprint,
        accessEpoch: access.accessEpoch,
        projectIndex: 0,
        issueIds: [...source.issueIds],
        enumerated: false,
        offset: 0,
        retained: [],
        incomplete: false,
      };
      if (
        current.offset > current.issueIds.length + source.projectIds.length ||
        current.projectIndex > source.projectIds.length
      )
        return yield* sourceError('Linear sync progress is invalid.');
      const checkpoint = Effect.fn('linear.checkpoint')(function* () {
        yield* writeLinearSyncState(config, id, current, fence);
        return {
          sourceId: id,
          syncedDocuments,
          warnings,
          progress: {completed: current.offset, total: current.issueIds.length + source.projectIds.length},
        } satisfies LinearSyncResult;
      });
      const reject = Effect.fn('linear.reject')(function* () {
        yield* saveReceipt(config, source, {...access, status: 'authentication-rejected'});
        yield* clearLinearSyncState(config, id);
        return {sourceId: id, syncedDocuments, warnings} satisfies LinearSyncResult;
      });
      const failure = Effect.fn('linear.handleFailure')(function* (error: LinearClientError) {
        warnings.push(`Linear refresh: ${error.code}.`);
        if (
          [
            'authentication-rejected',
            'access-rejected',
            'scope-rejected',
            'credential-reflected',
            'not-found',
          ].includes(error.code)
        )
          return yield* reject();
        if (error.code === 'quota-rejected')
          yield* saveReceipt(config, source, {
            ...access,
            nextAttemptAt: Math.min(
              8640000000000000 - 1,
              (yield* Clock.currentTimeMillis) + Math.max(60000, error.retryAfterMilliseconds ?? 60000),
            ),
          });
        return yield* checkpoint();
      });
      return yield* Effect.gen(function* () {
        const identity = yield* call(() => client.identity()).pipe(Effect.result);
        if (Result.isFailure(identity)) return yield* failure(identity.failure);
        if (
          identity.success.organizationId !== source.organizationId ||
          identity.success.principalId !== source.principalId
        )
          return yield* failure(new LinearClientError({code: 'scope-rejected'}));
        for (const teamId of source.teamIds) {
          const team = yield* call(() => client.team(teamId)).pipe(Effect.result);
          if (Result.isFailure(team)) return yield* failure(team.failure);
          if (team.success.organizationId !== source.organizationId)
            return yield* failure(new LinearClientError({code: 'scope-rejected'}));
        }
        yield* saveReceipt(config, source, {...access, status: 'active', nextAttemptAt: undefined});
        while (!current.enumerated && current.projectIndex < source.projectIds.length) {
          const listed = yield* call(() =>
            client.listProjectIssues(source, source.projectIds[current.projectIndex]),
          ).pipe(Effect.result);
          if (Result.isFailure(listed)) return yield* failure(listed.failure);
          const issueIds = [...new Set([...current.issueIds, ...listed.success.map(i => i.id)])].sort();
          if (issueIds.length > LINEAR_MAX_COLLECTION_ITEMS)
            return yield* failure(new LinearClientError({code: 'contract-incomplete'}));
          current = {...current, issueIds, projectIndex: current.projectIndex + 1};
          yield* writeLinearSyncState(config, id, current, fence);
        }
        current = {...current, enumerated: true};
        yield* writeLinearSyncState(config, id, current, fence);
        const total = current.issueIds.length + source.projectIds.length;
        while (current.offset < total) {
          const issueId = current.issueIds[current.offset];
          const projectId = source.projectIds[current.offset - current.issueIds.length];
          const hydrated = yield* (
            issueId
              ? call(() => client.issueSnapshot(source, issueId)).pipe(
                  Effect.map(snapshot => renderLinearIssue(source, snapshot)),
                  Effect.map(object => [object]),
                )
              : call(() => client.projectSnapshot(source, projectId)).pipe(
                  Effect.map(snapshot => renderLinearProject(source, snapshot)),
                )
          ).pipe(Effect.result);
          if (Result.isFailure(hydrated)) {
            const error = hydrated.failure;
            const failureCode = error instanceof LinearClientError ? error.code : 'contract-invalid';
            if (issueId && ['scope-rejected', 'not-found', 'access-rejected'].includes(failureCode)) {
              yield* quarantineObject(config, source, linearDocumentId(source.organizationId, 'issue', issueId));
              warnings.push(`Linear issue ${issueId}: ${failureCode}.`);
              current = {...current, incomplete: true, offset: current.offset + 1};
              yield* writeLinearSyncState(config, id, current, fence);
              continue;
            }
            return yield* failure(
              error instanceof LinearClientError ? error : new LinearClientError({code: 'contract-invalid'}),
            );
          }
          for (const object of hydrated.success) {
            yield* writeObject(config, source, object, access);
            syncedDocuments.push(object.documentId);
          }
          current = {
            ...current,
            offset: current.offset + 1,
            retained: [...new Set([...current.retained, ...hydrated.success.map(o => o.documentId)])].sort(),
          };
          yield* writeLinearSyncState(config, id, current, fence);
        }
        if (current.incomplete) {
          yield* clearLinearSyncState(config, id);
          yield* saveReceipt(config, source, {
            ...access,
            completedAt: access.completedAt,
            nextAttemptAt: (yield* Clock.currentTimeMillis) + source.refreshIntervalMinutes * 60000,
          });
          return {sourceId: id, syncedDocuments, warnings} satisfies LinearSyncResult;
        }
        for (const doc of yield* listLocalDocuments(config, id))
          if (!current.retained.includes(doc)) yield* removeObject(config, source, doc);
        yield* saveReceipt(config, source, {
          ...access,
          completedAt: yield* Clock.currentTimeMillis,
          nextAttemptAt: undefined,
        });
        yield* clearLinearSyncState(config, id);
        return {sourceId: id, syncedDocuments, warnings} satisfies LinearSyncResult;
      }).pipe(Effect.ensuring(Effect.sync(() => client.close())));
    }),
  );
});
