import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {
  declaredVirtualModules,
  moduleSpecifiers,
  validateRelocatedTestPaths,
  validateSourceVisibility,
  validateWorkspaceBoundaries,
  type SourceModule,
  type WorkspacePackage,
} from './boundaries.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const Manifest = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  exports: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const packages: WorkspacePackage[] = [];
for (const path of new Bun.Glob('{apps,packages}/*/package.json').scanSync('.')) {
  const manifest = Schema.decodeSync(Manifest)(await Bun.file(path).json());
  packages.push({
    ...manifest,
    directory: Effect.pipe(path, EffectString.slice(0, -'/package.json'.length)),
    exports: manifest.exports ?? {},
    dependencies: manifest.dependencies ?? {},
  });
}
const sources: SourceModule[] = [];
const sourceFiles: {content: string; path: string}[] = [];
for (const path of new Bun.Glob('{scripts,tools,infra,apps,packages}/**/*.{ts,tsx,mts}').scanSync('.')) {
  if (
    Effect.pipe(path, EffectString.includes('/node_modules/')) ||
    Effect.pipe(path, EffectString.includes('/fixtures/')) ||
    Effect.pipe(path, EffectString.includes('/dist/')) ||
    Effect.pipe(path, EffectString.startsWith('tools/bazel/spike/'))
  )
    continue;
  const content = await Bun.file(path).text();
  sourceFiles.push({content, path});
  sources.push({path, imports: moduleSpecifiers(path, content), virtualModules: declaredVirtualModules(path, content)});
}
const errors = [...validateWorkspaceBoundaries(packages, sources), ...validateRelocatedTestPaths(sourceFiles)];
const gitFiles = Bun.spawnSync({
  cmd: [
    'git',
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'apps',
    'packages',
    'scripts',
    'tools',
    'infra',
  ],
  stderr: 'pipe',
  stdout: 'pipe',
});
if (gitFiles.exitCode !== 0) {
  errors.push(
    `Could not inspect Git-visible workspace files: ${Effect.pipe(gitFiles.stderr.toString(), EffectString.trim)}`,
  );
} else {
  const gitVisiblePaths = new Set(
    EffectArray.filter(Effect.pipe(gitFiles.stdout.toString(), EffectString.split('\0')), Boolean),
  );
  errors.push(...validateSourceVisibility(sources, gitVisiblePaths));
}
for (const retiredRoot of ['manager', 'public', 'src', 'test', 'website']) {
  const migratedFiles = [...new Bun.Glob(`${retiredRoot}/**/*`).scanSync('.')];
  if (migratedFiles.length > 0)
    errors.push(`${retiredRoot}/: retired root must be owned by apps/, packages/, or another declared Bazel package`);
}
for (const pkg of packages) {
  for (const entry of EffectRecord.values(pkg.exports)) {
    if (!(await Bun.file(`${pkg.directory}/${entry}`).exists()))
      errors.push(`${pkg.name}: missing exported file ${entry}`);
  }
}
if (errors.length) {
  process.stderr.write(`${EffectArray.join(errors, '\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${packages.length} private workspaces and ${sources.length} source modules.\n`);
}
