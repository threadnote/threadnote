// Companion provenance only; the existing benchmark and its raw JSON stay unchanged.
import * as EffectString from 'effect/String';
const args = process.argv.slice(2);
if (args[0] !== '--checkout' || args[2] !== '--backend' || !['typescript', 'rust'].includes(args[3])) {
  throw new Error(
    'Expected --checkout <absolute path> --backend <typescript|rust> followed by existing benchmark arguments.',
  );
}
const checkout = args[1];
const backend = args[3];
const benchmarkArgs = args.slice(4);
const output = benchmarkArgs[benchmarkArgs.indexOf('--output') + 1];
if (
  !checkout ||
  !EffectString.startsWith('/')(checkout) ||
  !benchmarkArgs.includes('--output') ||
  !output ||
  !EffectString.startsWith('/')(output)
)
  throw new Error('Absolute checkout and output paths are required.');
if (await Bun.file(output).exists()) throw new Error('Refusing to overwrite a capture.');

async function git(...arguments_: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...arguments_], {cwd: checkout, stdout: 'pipe', stderr: 'pipe'});
  const value = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error('Unable to read capture source identity.');
  return EffectString.trim(value);
}
async function digest(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
}
async function identity() {
  return {
    commit: await git('rev-parse', 'HEAD'),
    status: await git('status', '--porcelain=v1'),
    librarySha256:
      backend === 'rust' ? await digest(`${checkout}/packages/inference/native-vector/vector-search.node`) : null,
  };
}
const opening = await identity();
if (opening.status) throw new Error('Capture requires a clean source checkout.');
const child = Bun.spawn(['bun', 'scripts/benchmark-recall-vectors.ts', ...benchmarkArgs], {
  cwd: checkout,
  env: {...process.env, THREADNOTE_NATIVE_VECTOR_EXPERIMENT: backend === 'rust' ? '1' : '0'},
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await child.exited;
const closing = await identity();
const raw = Bun.file(output);
const sourceStable = JSON.stringify(opening) === JSON.stringify(closing);
const record = {
  version: 1,
  backend,
  selector: {THREADNOTE_NATIVE_VECTOR_EXPERIMENT: backend === 'rust' ? '1' : '0'},
  opening,
  closing,
  sourceStable,
  exitCode,
  qualification: false,
  cargoLockSha256: backend === 'rust' ? await digest(`${checkout}/packages/inference/native-vector/Cargo.lock`) : null,
  rawArtifactSha256: (await raw.exists()) ? await digest(output) : null,
  runtime: {bun: Bun.version, platform: process.platform, architecture: process.arch},
};
await Bun.write(`${output}.provenance.json`, `${JSON.stringify(record, null, 2)}\n`);
if (exitCode !== 0 || !sourceStable)
  throw new Error('Capture failed or source/library changed; inspect companion provenance.');
