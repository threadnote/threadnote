// Bun has no atomic file-rename API. Content I/O and locking use Bun APIs below.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {renameSync} from 'node:fs';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Build bootstrap uses Bun's path utilities without an Effect service layer.
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database} from 'bun:sqlite';
import {buildGenerationModel} from './generation-model.mjs';

const stateDirectory = '.context/bazel-generated';
export const generationReceiptPath = `${stateDirectory}/receipt.json`;
export const generationDigest = content => new Bun.CryptoHasher('sha256').update(content).digest('hex');

// SQLite's process-safe writer lock is released by the OS on crash. There is no
// stale PID file to delete, or lease whose recovery could race another preparer.
const acquireLock = async root => {
  await Bun.write(join(root, stateDirectory, '.directory'), '');
  const db = new Database(join(root, stateDirectory, 'prepare.sqlite'));
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      try {
        db.exec('BEGIN IMMEDIATE');
        return () => {
          try {
            db.exec('ROLLBACK');
          } finally {
            db.close();
          }
        };
      } catch (error) {
        if (error.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        await Bun.sleep(25);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
};

let temporarySequence = 0;
const atomicWrite = async (root, absolute, content) => {
  // A killed process may leave this file behind. Staging must stay outside
  // authored source discovery, even for broad repository-contract targets.
  const temporary = join(root, stateDirectory, 'staging', `${process.pid}-${temporarySequence++}.tmp`);
  try {
    await Bun.write(temporary, content);
    renameSync(temporary, absolute);
  } finally {
    if (await Bun.file(temporary).exists()) await Bun.file(temporary).delete();
  }
};

/** Materialize one complete flat graph before any consumer reads its inventory. */
export const prepareBazelWorkspace = async ({
  root: inputRoot = fileURLToPath(new URL('../..', import.meta.url)),
  modelOptions = {},
  produceMetadata = true,
} = {}) => {
  const root = resolve(inputRoot);
  const release = await acquireLock(root);
  try {
    try {
      for (const name of new Bun.Glob('*.tmp').scanSync({cwd: join(root, stateDirectory, 'staging')})) {
        if (/^\d+-\d+\.tmp$/u.test(name)) await Bun.file(join(root, stateDirectory, 'staging', name)).delete();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (produceMetadata) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          'apps/website/tools/site-prepared-metadata.ts',
          '--output',
          'apps/website/.bazel-inputs/metadata.json',
        ],
        {cwd: root, stdout: 'inherit', stderr: 'inherit'},
      );
      if (child.exitCode !== 0) throw new Error(`Website metadata preparation failed (${child.exitCode})`);
    }
    const model = await buildGenerationModel({root, ...modelOptions});
    const receiptPath = join(root, generationReceiptPath);
    const ownershipPath = join(root, stateDirectory, 'ownership.json');
    let previous;
    for (const path of [ownershipPath, receiptPath]) {
      try {
        previous = await Bun.file(path).json();
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    const receipt = {
      version: 1,
      outputs: [...model.output].map(([path, content]) => ({path, sha256: generationDigest(content)})),
    };
    // Retain ownership across a failed publication, including newly created
    // outputs. The completion receipt alone is intentionally invalidated below.
    const owned = new Map((previous?.outputs ?? []).map(entry => [entry.path, entry]));
    for (const entry of receipt.outputs) owned.set(entry.path, entry);
    await atomicWrite(root, ownershipPath, JSON.stringify({version: 1, outputs: [...owned.values()]}));
    if (await Bun.file(receiptPath).exists()) await Bun.file(receiptPath).delete();
    for (const [path, content] of model.output) {
      const absolute = join(root, path);
      const file = Bun.file(absolute);
      if ((await file.exists()) && (await file.text()) === content) continue;
      await atomicWrite(root, absolute, content);
    }
    for (const prior of previous?.outputs ?? []) {
      if (
        model.output.has(prior.path) ||
        !/^(?:[^/]+\/)*BUILD\.bazel$/u.test(prior.path) ||
        prior.path.split('/').includes('..')
      )
        continue;
      const file = Bun.file(join(root, prior.path));
      if ((await file.exists()) && (await file.text()).startsWith(model.generatedHeader)) await file.delete();
    }
    await atomicWrite(root, receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await atomicWrite(root, ownershipPath, JSON.stringify(receipt));
    return {receiptPath, outputCount: receipt.outputs.length, inventoryCount: model.inventory.length};
  } finally {
    release();
  }
};

if (import.meta.main) await prepareBazelWorkspace();
