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
  slots: Schema.Array(Schema.Struct({owner: instance, provider: Schema.NullOr(instance)})),
});
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
  try {
    const file = join(home, 'semantic/admission-v1/admission-v1.json');
    const info = await lstat(file);
    if (info.size > 128 * 1024 || !info.isFile() || info.isSymbolicLink()) throw new Error('Unknown fixture admission');
    const state = Schema.decodeUnknownSync(ledger)(JSON.parse(await readFile(file, 'utf8')));
    for (const slot of state.slots) {
      workers.add(slot.owner.pid);
      if (slot.provider) providers.add(slot.provider.pid);
    }
  } catch (error) {
    if (!isJsonObject(error) || error.code !== 'ENOENT') throw error;
  }
  try {
    for (const entry of await readdir(join(home, 'semantic'), {withFileTypes: true})) {
      if (!/^[a-f0-9]{20}$/u.test(entry.name)) continue;
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
    if (!isJsonObject(error) || error.code !== 'ENOENT') throw error;
  }
  const drained = () =>
    EffectArray.every([...workers], absent) &&
    EffectArray.every([...providers], pid => absent(pid) && groupAbsent(pid));
  while (!drained() && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 25));
  return {
    drained: drained(),
    bootstrapFilesRemoved: removed,
    workers: EffectArray.map([...workers], pid => ({pid, absent: absent(pid)})),
    providers: EffectArray.map([...providers], pid => ({pid, absent: absent(pid), groupAbsent: groupAbsent(pid)})),
    signalledLedgerPids: false,
  };
}
