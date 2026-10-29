import assert from 'node:assert/strict';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This fixture verifies native compiler files and processes.
import {readFileSync} from 'node:fs';

const execute = (args: string[]) => Bun.spawnSync([process.execPath, ...args], {stdout: 'pipe', stderr: 'pipe'});
const typescript = execute(['check', '-p', 'tools/bazel/spike/tsconfig.json']);
assert.equal(typescript.exitCode, 0, typescript.stderr.toString() + typescript.stdout.toString());

const diagnostics = execute([
  'node_modules/@effect/tsgo/dist/effect-tsgo.cjs',
  'diagnostics',
  '--project',
  'tools/bazel/spike/tsconfig.json',
]);
const output = diagnostics.stdout.toString() + diagnostics.stderr.toString();
assert.match(output, /floatingEffect|not used|not assigned|not yielded/i);

const platform = `${process.platform}-${process.arch}`;
const artifact = `node_modules/@effect/tsgo-${platform}/artifacts`;
const oxlintPackage = JSON.parse(readFileSync('node_modules/oxlint/package.json', 'utf8'));
const upstream = await Bun.file(`node_modules/@effect/tsgo-${platform}/lib/upstream.json`).json();
assert.ok(upstream.components.oxlint[oxlintPackage.version]);
const lint = execute(['node_modules/oxlint/bin/oxlint', '--version']);
assert.equal(lint.exitCode, 0, lint.stderr.toString());
const nativePlatform = process.platform === 'linux' ? `${platform}-gnu` : platform;
const nativeFile = `oxlint.${nativePlatform}.node`;
assert.deepEqual(
  readFileSync(`node_modules/@oxlint/binding-${nativePlatform}/${nativeFile}`),
  readFileSync(`${artifact}/oxlint/${oxlintPackage.version}/${nativeFile}`),
);
const tsgolintPackage = JSON.parse(readFileSync('node_modules/oxlint-tsgolint/package.json', 'utf8'));
assert.deepEqual(
  readFileSync(`node_modules/@oxlint-tsgolint/${platform}/tsgolint`),
  readFileSync(`${artifact}/oxlint-tsgolint/${tsgolintPackage.version}/tsgolint`),
);
process.stdout.write('Bun check, Effect diagnostics, and patched Oxlint execute under Bazel.\n');
