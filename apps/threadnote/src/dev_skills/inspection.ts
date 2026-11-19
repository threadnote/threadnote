import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import type {DevSkillsBundle, DevSkillsIssue, DevSkillsManifest, DevSkillsTarget} from './contract.js';
import {AGENT_SKILLS} from '../agent_integration/skills.js';
import type {PhysicalReceipt} from './registry.js';
import {entrypointPath, physicalDirectory} from './registry.js';
import {
  assertSafePath,
  enumerateFiles,
  fail,
  hash,
  hasSymlinkAncestor,
  isSymbolicLink,
  readOptional,
  statOptional,
  stableJson,
} from './files.js';
import {hasHistoricalDevSkillsMembers} from './manifest.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export const generationRoot = (path: Path.Path, skillRoot: string, digest: string) =>
  path.join(physicalDirectory(path, skillRoot), 'generations', digest);
/**
 * Renders root placeholders with `/` separators: a Windows backslash is a CommonMark escape in a link destination.
 * Pass `path.sep` to reproduce the native rendering that receipts written before this rule still hold.
 */
export function renderEntrypoints(path: Path.Path, target: DevSkillsTarget, bundle: DevSkillsBundle, separator = '/') {
  const root = EffectString.replaceAll(
    path.sep,
    separator,
  )(generationRoot(path, target.skillRoot, bundle.manifest.digest));
  const entries: Record<string, string> = {};
  for (const skill of bundle.manifest.skills) {
    const content = Buffer.from(bundle.files[`${skill.id}/SKILL.md`], 'base64').toString('utf8');
    entries[entrypointPath(target.layout, skill.id)] = Effect2.pipe(content, __effectPipeInput => {
      const __effectPipeStage0 = Effect2.pipe(
        __effectPipeInput,
        EffectString.replaceAll('{{THREADNOTE_SKILL_ROOT}}', `${root}${separator}${skill.id}`),
      );
      const __effectPipeStage1 = Effect2.pipe(
        __effectPipeStage0,
        EffectString.replaceAll('{{THREADNOTE_BUNDLE_ROOT}}', root),
      );
      return __effectPipeStage1;
    });
  }
  return entries;
}
/** Every rendering an owned receipt may hold for a generation; POSIX has only one. */
export const ownedRenderings = (path: Path.Path, target: DevSkillsTarget, bundle: DevSkillsBundle) =>
  EffectArray.map([...new Set(['/', path.sep])], separator => renderEntrypoints(path, target, bundle, separator));
export const isOwnedRendering = (
  path: Path.Path,
  target: DevSkillsTarget,
  bundle: DevSkillsBundle,
  entrypoints: Readonly<Record<string, string>>,
) =>
  EffectArray.some(ownedRenderings(path, target, bundle), rendered => stableJson(rendered) === stableJson(entrypoints));
export const verifyGeneration = Effect.fn('devSkills.verifyGeneration')(function* (
  root: string,
  manifest: DevSkillsManifest,
  partial = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const discovered = yield* enumerateFiles(root);
  const actual: string[] = [];
  for (const file of discovered) {
    if (path.basename(file) !== '.DS_Store') {
      actual.push(file);
      continue;
    }
    const absolute = path.join(root, file);
    const link = yield* fs.readLink(absolute).pipe(Effect.result);
    if (link._tag === 'Success') {
      actual.push(file);
      continue;
    }
    if (!['NotFound', 'InvalidArgument', 'Unknown'].includes(link.failure.reason._tag)) return yield* link.failure;
    if ((yield* fs.stat(absolute)).type !== 'File') actual.push(file);
  }
  const expected = EffectRecord.keys(manifest.hashes).sort();
  if (
    EffectArray.some(actual, file => !(file in manifest.hashes)) ||
    (!partial && JSON.stringify(actual) !== JSON.stringify(expected))
  )
    return yield* fail('generation-conflict', `Immutable generation inventory changed: ${root}`);
  let size = 0;
  for (const file of actual) {
    size += Number((yield* fs.stat(path.join(root, file))).size);
    if (size > 2_000_000) return yield* fail('generation-conflict', 'Immutable generation exceeds its size bound.');
  }
  for (const file of actual)
    if (hash(yield* fs.readFile(path.join(root, file))) !== manifest.hashes[file])
      return yield* fail('generation-conflict', `Immutable generation bytes changed: ${path.join(root, file)}`);
});
export const verifyReceiptProjection = Effect.fn('devSkills.verifyReceiptProjection')(function* (
  target: DevSkillsTarget,
  receipt: PhysicalReceipt,
) {
  if (!EffectRecord.keys(receipt.consumers).length) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = generationRoot(path, target.skillRoot, receipt.manifest.digest);
  yield* verifyGeneration(root, receipt.manifest);
  const files: Record<string, string> = {};
  for (const skill of receipt.manifest.skills) {
    const relative = `${skill.id}/SKILL.md`;
    const bytes = yield* fs.readFile(path.join(root, relative));
    if (hash(bytes) !== receipt.manifest.hashes[relative])
      return yield* fail('historical-ownership-conflict', 'Historical skill bytes changed during verification.');
    const name = /^---\r?\n[\s\S]*?^name:\s*["']?([a-z-]+)["']?\s*$/mu.exec(Buffer.from(bytes).toString('utf8'))?.[1];
    if (name !== skill.id)
      return yield* fail('historical-ownership-conflict', 'Historical skill discovery aliases are not owned.');
    files[relative] = Buffer.from(bytes).toString('base64');
  }
  if (!isOwnedRendering(path, target, {manifest: receipt.manifest, files}, receipt.entrypoints))
    return yield* fail(
      'historical-ownership-conflict',
      'Historical entrypoint ownership differs from its verified rendering.',
    );
});
export const verifyHistoricalProjection = (target: DevSkillsTarget, receipt: PhysicalReceipt) =>
  hasHistoricalDevSkillsMembers(receipt.manifest) ? verifyReceiptProjection(target, receipt) : Effect.void;
export const inspectOwned = Effect.fn('devSkills.inspectOwned')(function* (
  target: DevSkillsTarget,
  receipt?: PhysicalReceipt,
) {
  const path = yield* Path.Path;
  const issues: DevSkillsIssue[] = [];
  const contents: Record<string, string | null> = {};
  for (const id of new Set([
    'dev-cycle',
    'dev-plan',
    'dev-spec',
    'watch-pr',
    ...(EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(receipt?.manifest.skills), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, skill => skill.id),
      ),
    ) ?? []),
  ])) {
    const relative = entrypointPath(target.layout, id);
    const file = path.join(target.skillRoot, relative);
    const content = yield* readOptional(file);
    contents[relative] = content;
    const owned = receipt?.entrypoints[relative];
    if (owned !== undefined && content !== owned)
      issues.push({code: 'modified', message: 'Owned discovery entrypoint changed or is missing.', path: file});
    else if (owned === undefined && content !== null)
      issues.push({code: 'unmanaged', message: 'Existing skills are never adopted or overwritten.', path: file});
    if (target.layout === 'directory') {
      const files = yield* enumerateFiles(path.dirname(file));
      for (const extra of EffectArray.filter(files, member => member !== 'SKILL.md'))
        issues.push({
          code: 'extra-file',
          message: 'Unowned files in a workflow directory are preserved.',
          path: path.join(path.dirname(file), extra),
        });
    }
  }
  if (receipt)
    for (const manifest of EffectRecord.values(receipt.generations)) {
      const verified = yield* verifyGeneration(generationRoot(path, target.skillRoot, manifest.digest), manifest).pipe(
        Effect.result,
      );
      if (verified._tag === 'Failure')
        issues.push({
          code: 'generation-conflict',
          message: 'An owned immutable generation is missing or changed.',
          path: generationRoot(path, target.skillRoot, manifest.digest),
        });
    }
  if (receipt && (yield* verifyHistoricalProjection(target, receipt).pipe(Effect.result))._tag === 'Failure')
    issues.push({
      code: 'historical-ownership-conflict',
      message: 'Historical copied generation or rendered ownership is invalid; preserve it for explicit recovery.',
      path: generationRoot(path, target.skillRoot, receipt.manifest.digest),
    });
  return {issues, contents};
});
/** Scan only native discovery entries and the two recognized legacy pack namespaces. */
export const inspectDuplicates = Effect.fn('devSkills.inspectDuplicates')(function* (target: DevSkillsTarget) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const issues: DevSkillsIssue[] = [];
  const ids = new Set(['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr']);
  let visited = 0;
  /**
   * Every walk level below a discovery root calls this before it descends or reads. A foreign link is never
   * followed; a link named with a bundled id still blocks installation.
   */
  const follow = Effect.fn('devSkills.followDiscoveryEntry')(function* (file: string, name: string) {
    if (!(yield* isSymbolicLink(file))) return true;
    const id = Effect2.pipe(name, EffectString.replace(/\.md$/u, ''));
    if (ids.has(id))
      issues.push({
        code: 'duplicate',
        message: `A discoverable ${id} is a symbolic link. Migrate it explicitly.`,
        path: file,
      });
    return false;
  });
  const read = Effect.fn('devSkills.inspectDuplicate')(function* (file: string, directoryName: string) {
    if (++visited > 1024)
      return yield* fail(
        'discovery-limit',
        'Legacy skill discovery exceeded its bound; narrow the host directory before installation.',
      );
    const content = yield* readOptional(file, 300_000);
    if (content === null) return;
    const name = /^---\r?\n[\s\S]*?^name:\s*["']?([a-z-]+)["']?\s*$/mu.exec(content)?.[1] ?? directoryName;
    if (!ids.has(name)) return;
    if (file === path.join(target.skillRoot, entrypointPath(target.layout, name))) return;
    issues.push({
      code: 'duplicate',
      message: `A manual or legacy ${name} is also discoverable. Migrate it explicitly.`,
      path: file,
    });
  });
  const skill = Effect.fn('devSkills.inspectSkillDirectory')(function* (directory: string, name: string) {
    const file = path.join(directory, 'SKILL.md');
    if (yield* follow(file, name)) yield* read(file, name);
  });
  const directories = Effect.fn('devSkills.discoveryDirectories')(function* (root: string) {
    yield* assertSafePath(root);
    const info = yield* statOptional(root);
    if (!info) return [];
    if (info.type !== 'Directory') return yield* fail('unsafe-path', `Expected a skill discovery directory: ${root}`);
    const names = yield* fs.readDirectory(root);
    if (names.length > 256) return yield* fail('discovery-limit', `Too many native skill entries: ${root}`);
    return names;
  });
  const isDirectory = (file: string) => Effect.map(statOptional(file), info => info?.type === 'Directory');
  for (const root of target.discoveryRoots) {
    // A foreign root behind any link is skipped; the owned root reaches `assertSafePath` and is refused.
    if (path.resolve(root) !== path.resolve(target.skillRoot) && (yield* hasSymlinkAncestor(root))) continue;
    for (const name of yield* directories(root)) {
      if (
        Effect2.pipe(name, EffectString.startsWith('.')) ||
        ['threadnote', 'threadnote-packs'].includes(name) ||
        EffectArray.some(AGENT_SKILLS, core => name === core || name === `${core}.md`)
      )
        continue;
      const file = path.join(root, name);
      if (!(yield* follow(file, name))) continue;
      if (yield* isDirectory(file)) yield* skill(file, name);
      else if (Effect2.pipe(name, EffectString.endsWith('.md')))
        yield* read(file, Effect2.pipe(name, EffectString.slice(0, -3)));
    }
    for (const namespace of ['threadnote', 'threadnote-packs']) {
      const base = path.join(root, namespace);
      if (!(yield* follow(base, namespace))) continue;
      for (const team of yield* directories(base)) {
        const teamRoot = path.join(base, team);
        if (!(yield* follow(teamRoot, team)) || !(yield* isDirectory(teamRoot))) continue;
        for (const pack of yield* directories(teamRoot)) {
          const packRoot = path.join(teamRoot, pack);
          if (!(yield* follow(packRoot, pack)) || !(yield* isDirectory(packRoot))) continue;
          yield* skill(packRoot, pack);
          if (namespace === 'threadnote-packs')
            for (const id of ids)
              if (yield* follow(path.join(packRoot, id), id)) yield* skill(path.join(packRoot, id), id);
        }
      }
    }
  }
  return issues;
});
