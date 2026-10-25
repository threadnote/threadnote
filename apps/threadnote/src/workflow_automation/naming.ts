import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ResourceStore} from '@threadnote/store/resource-store';
import {uriSegment} from '@threadnote/store/resource-segment';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {workflowFamilyStem, workflowTitleSlug, type WorkflowNameFamily} from '@threadnote/workflow-automations/naming';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {stableJson, WorkflowNameFamilySchema, type WorkflowBinding} from '../workflow_memory/protocol.js';

interface Reservation {
  readonly owner: string;
  readonly title: string;
  readonly family: WorkflowNameFamily;
}
interface Registry {
  readonly format: 'threadnote-workflow-names';
  readonly version: 1;
  readonly project: string;
  readonly reservations: readonly Reservation[];
}
const RegistrySchema = Schema.Struct({
  format: Schema.Literal('threadnote-workflow-names'),
  version: Schema.Literal(1),
  project: Schema.String,
  reservations: Schema.Array(
    Schema.Struct({
      owner: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      title: Schema.String,
      family: WorkflowNameFamilySchema,
    }),
  ).check(Schema.isMaxLength(4_096)),
});
const issue = (message: string) => WorkflowAutomationError.make({code: 'name-allocation-conflict', message});
const MAX_BYTES = 2 * 1024 * 1024;

/** Reservations survive interruption before bind/state save. Never recycle a name. */
export const reserveWorkflowNameFamily = Effect.fn('workflowAutomation.reserveNameFamily')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  title: string,
) {
  const slug = yield* Effect.try({
    try: () => workflowTitleSlug(title),
    catch: error => error as WorkflowAutomationError,
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = yield* fs.realPath(config.agentContextHome);
  for (const segment of ['workflow-automations', 'names-v1', binding.project]) {
    directory = path.join(directory, segment);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
      return yield* issue('Name allocation directories cannot be symbolic links.');
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    if ((yield* fs.stat(directory)).type !== 'Directory' || (yield* fs.realPath(directory)) !== directory)
      return yield* issue('Name allocation must remain in its canonical private directory.');
  }
  const file = path.join(directory, 'workflow-names.json');
  const read = Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
      return yield* issue('Name allocation state cannot be a symbolic link.');
    if (!(yield* fs.exists(file))) return undefined;
    const stat = yield* fs.stat(file);
    if (stat.type !== 'File' || Number(stat.size) > MAX_BYTES)
      return yield* issue('Name allocation state must be a bounded regular file.');
    const text = yield* fs.readFileString(file);
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
      return yield* issue('Name allocation state exceeds its byte limit.');
    return text;
  });
  return yield* withExclusiveFileLock(
    fs,
    file + '.lock',
    {
      createParentDirectory: false,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 300_000,
      waitTimeoutMilliseconds: 2_000,
    },
    Effect.gen(function* () {
      const before = yield* read;
      const parsed: unknown =
        before === undefined
          ? {format: 'threadnote-workflow-names', version: 1, project: binding.project, reservations: []}
          : yield* Effect.try({
              try: () => JSON.parse(before),
              catch: () =>
                issue('Name allocation state is invalid. Restore its original bytes; no names were reassigned.'),
            });
      const decoded = yield* Schema.decodeUnknownEffect(RegistrySchema)(parsed, {onExcessProperty: 'error'}).pipe(
        Effect.mapError(() =>
          issue('Name allocation state is invalid. Restore its original bytes; no names were reassigned.'),
        ),
      );
      const registry = yield* Effect.try({
        try: (): Registry => {
          const value = decoded;
          if (
            value.format !== 'threadnote-workflow-names' ||
            value.version !== 1 ||
            value.project !== binding.project ||
            !Array.isArray(value.reservations) ||
            value.reservations.length > 4_096
          )
            throw issue('Name allocation state is unsupported. Restore its original state; no names were reassigned.');
          const owners = new Set<string>();
          const stems = new Set<string>();
          for (const reservation of value.reservations) {
            const stem = workflowFamilyStem(reservation.family);
            if (
              !/^[a-f0-9]{64}$/u.test(reservation.owner) ||
              owners.has(reservation.owner) ||
              stems.has(stem) ||
              workflowTitleSlug(reservation.title) !== reservation.family.slug
            )
              throw issue('Name allocation state contains conflicting identities.');
            owners.add(reservation.owner);
            stems.add(stem);
          }
          return value;
        },
        catch: () => issue('Name allocation state is invalid. Restore its original bytes; no names were reassigned.'),
      });
      const existing = registry.reservations.find(item => item.owner === binding.bindingId);
      if (existing) {
        if (existing.title !== title) return yield* issue('This native run already reserved another title.');
        return existing.family;
      }
      if (registry.reservations.length >= 4_096)
        return yield* issue('The project name registry is full. Existing names and receipts remain unchanged.');
      const store = yield* ResourceStore;
      const root = `threadnote://user/${uriSegment(binding.user)}/memories`;
      const project = uriSegment(binding.project);
      const roots = [
        `${root}/handoffs/active/${project}`,
        `${root}/handoffs/archived/${project}`,
        `${root}/durable/projects/${project}`,
        `${root}/durable/archived/${project}`,
      ];
      const entries: string[] = [];
      for (const uri of roots) {
        const found = yield* store
          .list({account: config.account, home: config.agentContextHome, user: config.user}, uri)
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
        for (const entry of found) entries.push(entry.uri.toLowerCase());
        if (entries.length > 8_192)
          return yield* issue(
            'The project destination inventory exceeds the bounded allocation limit. No names were changed.',
          );
      }
      let family: WorkflowNameFamily | undefined;
      const used = new Set(registry.reservations.map(item => workflowFamilyStem(item.family)));
      for (let ordinal = 1; ordinal <= 1_000_000; ordinal++) {
        const candidate = {policyVersion: 1 as const, slug, ordinal};
        const stem = workflowFamilyStem(candidate);
        const prefixes = roots.map(uri => `${uri}/${uriSegment(stem)}-`.toLowerCase());
        if (!used.has(stem) && !entries.some(uri => prefixes.some(prefix => uri.startsWith(prefix)))) {
          family = candidate;
          break;
        }
      }
      if (!family) return yield* issue('No bounded unused name family is available.');
      const next = {...registry, reservations: [...registry.reservations, {owner: binding.bindingId, title, family}]};
      const serialized = stableJson(next) + '\n';
      if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES)
        return yield* issue('Name registry reached its byte limit. No existing receipt was changed.');
      const temporary = file + '.' + (yield* (yield* Crypto.Crypto).randomUUIDv4()) + '.tmp';
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
        if ((yield* read) !== before || (yield* fs.realPath(directory)) !== directory)
          return yield* issue('Name allocation state changed before commit. Retry the same native run.');
        yield* fs.rename(temporary, file);
      }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
      return family;
    }),
  );
});
