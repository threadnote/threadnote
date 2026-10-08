/* oxlint-disable effecttsgo/node-builtin-import -- The sandbox runner executes before npm inputs are staged. */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import {delimiter, dirname, join, relative, resolve} from 'node:path';

const [manifestPath, destination, ...testArgs] = process.argv.slice(2);
const manifest = await Bun.file(manifestPath).json();
const inputRoot = process.cwd();
const testing = destination === '--test';
const workspaceTesting = destination === '--workspace-test';
if (workspaceTesting) {
  const workspaceRoot = dirname(realpathSync(join(inputRoot, 'package.json')));
  const temporaryRoot = process.env.TEST_TMPDIR ?? workspaceRoot;
  const bin = join(temporaryRoot, '.bun-workspace-bin');
  const home = join(temporaryRoot, '.bun-workspace-home');
  const temp = join(temporaryRoot, '.bun-workspace-tmp');
  for (const directory of [bin, home, temp]) mkdirSync(directory, {recursive: true});
  symlinkSync(process.execPath, join(bin, 'bun'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const result = Bun.spawnSync([process.execPath, ...manifest.args, ...testArgs], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}${delimiter}/usr/sbin${delimiter}/sbin`,
      TZ: 'UTC',
      NO_COLOR: '1',
      BUN_INSTALL_NO_TRACK: '1',
      BUN_CONFIG_NO_CLEAR_TERMINAL: '1',
      ...manifest.env,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(result.exitCode);
}
const output = testing ? undefined : resolve(destination);
const temporaryRoot = testing ? process.env.TEST_TMPDIR : dirname(output);
mkdirSync(temporaryRoot, {recursive: true});
const stage = mkdtempSync(join(temporaryRoot, '.bun-stage-'));
try {
  for (const file of manifest.files) {
    const target = resolve(stage, file.destination);
    if (!target.startsWith(stage + '/')) throw new Error(`Input escapes stage: ${file.destination}`);
    mkdirSync(dirname(target), {recursive: true});
    const source = resolve(inputRoot, file.source);
    if (statSync(source).isDirectory()) cpSync(source, target, {recursive: true, dereference: true});
    else {
      copyFileSync(source, target);
      chmodSync(target, statSync(source).mode);
    }
  }
  for (const file of manifest.files) {
    if (!file.destination.endsWith('/package.json') || file.destination.startsWith('node_modules/')) continue;
    const packagePath = resolve(stage, file.destination);
    const pkg = await Bun.file(packagePath).json();
    if (!pkg.private || !pkg.name) continue;
    const link = resolve(stage, 'node_modules', pkg.name);
    if (!link.startsWith(join(stage, 'node_modules') + '/')) throw new Error(`Invalid workspace name: ${pkg.name}`);
    mkdirSync(dirname(link), {recursive: true});
    symlinkSync(relative(dirname(link), dirname(packagePath)), link);
  }
  const bin = join(stage, '.bin');
  const home = join(stage, '.home');
  const temp = join(stage, '.tmp');
  for (const directory of [bin, home, temp]) mkdirSync(directory, {recursive: true});
  symlinkSync(process.execPath, join(bin, 'bun'));
  symlinkSync(process.execPath, join(bin, 'node'));
  if (output) mkdirSync(output, {recursive: true});
  const args = testing ? [...manifest.args, ...testArgs] : manifest.args;
  const result = Bun.spawnSync([process.execPath, ...args.map(arg => arg.replaceAll('{output}', output ?? ''))], {
    cwd: stage,
    env: {
      HOME: home,
      TMPDIR: temp,
      PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin${delimiter}/usr/sbin${delimiter}/sbin`,
      TZ: 'UTC',
      NO_COLOR: '1',
      BUN_INSTALL_NO_TRACK: '1',
      BUN_CONFIG_NO_CLEAR_TERMINAL: '1',
      ...manifest.env,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exitCode = result.exitCode;
} finally {
  rmSync(stage, {recursive: true, force: true});
}
