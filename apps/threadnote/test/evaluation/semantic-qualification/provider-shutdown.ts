/* oxlint-disable effecttsgo/node-builtin-import -- Only disposable coordinator bootstrap files are removed; ledger PIDs are observed and never signalled. */
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Array as EffectArray, Schema, String as EffectString} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';

const instance = Schema.Struct({
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  identity: Schema.String,
});
const ledger = Schema.Struct({
  version: Schema.Literal(1),
  slots: Schema.Array(
    Schema.Struct({owner: instance, provider: Schema.NullOr(instance), quarantined: Schema.Boolean}),
  ).check(Schema.isMaxLength(8)),
  tickets: Schema.Array(Schema.Struct({owner: instance})).check(Schema.isMaxLength(32)),
});
const readAdmission = async (home: string) => {
  try {
    const file = join(home, 'semantic/admission-v1/admission-v1.json');
    const info = await lstat(file);
    if (info.size > 128 * 1024 || !info.isFile() || info.isSymbolicLink()) throw new Error('Unknown fixture admission');
    const bytes = await readFile(file);
    if (bytes.length > 128 * 1024) throw new Error('Unknown fixture admission');
    return Schema.decodeUnknownSync(ledger)(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (isJsonObject(error) && error.code === 'ENOENT') return undefined;
    // The candidate report projects only this static message; private ledger details stay in the in-memory cause.
    throw new Error('Unknown fixture admission', {cause: error});
  }
};
const absent = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isJsonObject(error) && error.code === 'ESRCH';
  }
};
const groupAbsent = (pid: number) => {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return isJsonObject(error) && error.code === 'ESRCH';
  }
};

/** Deleting our exact private bootstrap is the existing worker's cooperative shutdown contract. */
export async function shutdownFixtureProviders(home: string, project: string) {
  const started = Date.now();
  const providers = new Set<number>(),
    workers = new Set<number>();
  const removed: string[] = [];
  let observedCoordinator = false;
  const initial = await readAdmission(home);
  if (initial) {
    for (const slot of initial.slots) {
      workers.add(slot.owner.pid);
      if (slot.provider) providers.add(slot.provider.pid);
    }
    for (const ticket of initial.tickets) workers.add(ticket.owner.pid);
  }
  try {
    for (const entry of await readdir(join(home, 'semantic'), {withFileTypes: true})) {
      if (!/^[a-f0-9]{20}$/u.test(entry.name)) continue;
      observedCoordinator = true;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unknown fixture coordinator directory');
      const file = join(home, 'semantic', entry.name, 'host.json');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024)
        throw new Error('Unknown fixture bootstrap');
      const bootstrap = Schema.decodeUnknownSync(
        Schema.Struct({dataHome: Schema.String, worktree: Schema.String, runtimeIdentity: Schema.String}),
      )(JSON.parse(await readFile(file, 'utf8')));
      const key = EffectString.slice(
        0,
        20,
      )(
        createHash('sha256')
          .update(JSON.stringify([home, pathToFileURL(project).href, bootstrap.runtimeIdentity]))
          .digest('hex'),
      );
      if (bootstrap.dataHome !== home || bootstrap.worktree !== pathToFileURL(project).href || key !== entry.name)
        throw new Error('Foreign bootstrap in fixture home');
      await rm(file);
      removed.push(entry.name);
    }
  } catch (error) {
    if (observedCoordinator || !isJsonObject(error) || error.code !== 'ENOENT')
      throw new Error('Unknown fixture coordinator proof', {cause: error});
  }
  const processesGone = () =>
    EffectArray.every([...workers], absent) &&
    EffectArray.every([...providers], pid => absent(pid) && groupAbsent(pid));
  while (!processesGone() && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 25));
  const final = await readAdmission(home);
  // A verifier is owned by its admission slot before a provider PID exists. Dead coordinator
  // PIDs cannot replace the native owner's missing group-drain proof or erase a retained slot.
  const unknownObserved =
    EffectArray.some(initial?.slots ?? [], slot => slot.quarantined) ||
    EffectArray.some(final?.slots ?? [], slot => slot.quarantined);
  const admissionResolved =
    !unknownObserved &&
    (initial === undefined
      ? final === undefined && removed.length === 0
      : final !== undefined && final.slots.length === 0 && final.tickets.length === 0);
  const coordinatorObserved = !observedCoordinator || workers.size > 0;
  return {
    drained: processesGone() && admissionResolved && coordinatorObserved,
    admission: {
      initial: initial ? 'observed' : 'absent',
      final: final ? 'observed' : 'absent',
      resolved: admissionResolved,
      unknownObserved,
      retainedSlots: final?.slots.length ?? null,
      quarantinedSlots: final ? EffectArray.filter(final.slots, slot => slot.quarantined).length : null,
      preProviderSlots: final ? EffectArray.filter(final.slots, slot => slot.provider === null).length : null,
      retainedTickets: final?.tickets.length ?? null,
    },
    coordinatorObserved,
    bootstrapFilesRemoved: removed,
    workers: EffectArray.map([...workers], pid => ({pid, absent: absent(pid)})),
    providers: EffectArray.map([...providers], pid => ({pid, absent: absent(pid), groupAbsent: groupAbsent(pid)})),
    signalledLedgerPids: false,
  };
}
