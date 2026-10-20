import {Effect, FileSystem, Path} from 'effect';
import type {DevSkillsBundle, DevSkillsIssue, DevSkillsManifest, DevSkillsTarget} from './contract.js';
import {AGENT_SKILLS} from '../agent_integration/skills.js';
import type {PhysicalReceipt} from './registry.js';
import {entrypointPath, physicalDirectory} from './registry.js';
import {assertSafePath, enumerateFiles, fail, hash, readOptional, statOptional, stableJson} from './files.js';
import {hasHistoricalDevSkillsMembers} from './manifest.js';

export const generationRoot = (path: Path.Path, skillRoot: string, digest: string) =>
  path.join(physicalDirectory(path, skillRoot), 'generations', digest);
export function renderEntrypoints(path: Path.Path, target: DevSkillsTarget, bundle: DevSkillsBundle) {
  const root = generationRoot(path, target.skillRoot, bundle.manifest.digest);
  const entries: Record<string, string> = {};
  for (const skill of bundle.manifest.skills) {
    const content = Buffer.from(bundle.files[`${skill.id}/SKILL.md`], 'base64').toString('utf8');
    entries[entrypointPath(target.layout, skill.id)] = content
      .replaceAll('{{THREADNOTE_SKILL_ROOT}}', path.join(root, skill.id))
      .replaceAll('{{THREADNOTE_BUNDLE_ROOT}}', root);
  }
  return entries;
}
export const verifyGeneration = Effect.fn('devSkills.verifyGeneration')(function* (
  root: string,
  manifest: DevSkillsManifest,
  partial = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actual = yield* enumerateFiles(root);
  const expected = Object.keys(manifest.hashes).sort();
  if (
    actual.some(file => !(file in manifest.hashes)) ||
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
export const verifyHistoricalProjection = Effect.fn('devSkills.verifyHistoricalProjection')(function* (
  target: DevSkillsTarget,
  receipt: PhysicalReceipt,
) {
  if (!hasHistoricalDevSkillsMembers(receipt.manifest) || !Object.keys(receipt.consumers).length) return;
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
  if (
    stableJson(renderEntrypoints(path, target, {manifest: receipt.manifest, files})) !== stableJson(receipt.entrypoints)
  )
    return yield* fail(
      'historical-ownership-conflict',
      'Historical entrypoint ownership differs from its verified rendering.',
    );
});
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
    ...(receipt?.manifest.skills.map(skill => skill.id) ?? []),
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
      for (const extra of files.filter(member => member !== 'SKILL.md'))
        issues.push({
          code: 'extra-file',
          message: 'Unowned files in a workflow directory are preserved.',
          path: path.join(path.dirname(file), extra),
        });
    }
  }
  if (receipt)
    for (const manifest of Object.values(receipt.generations)) {
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
  const inspect = Effect.fn('devSkills.inspectDuplicate')(function* (file: string, directoryName?: string) {
    if (++visited > 1024)
      return yield* fail(
        'discovery-limit',
        'Legacy skill discovery exceeded its bound; narrow the host directory before installation.',
      );
    const content = yield* readOptional(file, 300_000);
    if (content === null) return;
    const name = /^---\r?\n[\s\S]*?^name:\s*["']?([a-z-]+)["']?\s*$/mu.exec(content)?.[1] ?? directoryName;
    if (!name || !ids.has(name)) return;
    if (file === path.join(target.skillRoot, entrypointPath(target.layout, name))) return;
    issues.push({
      code: 'duplicate',
      message: `A manual or legacy ${name} is also discoverable. Migrate it explicitly.`,
      path: file,
    });
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
  for (const root of target.discoveryRoots) {
    for (const name of yield* directories(root)) {
      if (
        name.startsWith('.') ||
        ['threadnote', 'threadnote-packs'].includes(name) ||
        AGENT_SKILLS.some(core => name === core || name === `${core}.md`)
      )
        continue;
      const file = path.join(root, name);
      const info = yield* statOptional(file);
      if (info?.type === 'Directory') yield* inspect(path.join(file, 'SKILL.md'), name);
      else if (name.endsWith('.md')) yield* inspect(file, name.slice(0, -3));
    }
    for (const namespace of ['threadnote', 'threadnote-packs']) {
      const base = path.join(root, namespace);
      for (const team of yield* directories(base)) {
        const teamRoot = path.join(base, team);
        if ((yield* statOptional(teamRoot))?.type !== 'Directory') continue;
        for (const pack of yield* directories(teamRoot)) {
          const packRoot = path.join(teamRoot, pack);
          if ((yield* statOptional(packRoot))?.type !== 'Directory') continue;
          yield* inspect(path.join(packRoot, 'SKILL.md'), pack);
          if (namespace === 'threadnote-packs')
            for (const id of ids) yield* inspect(path.join(packRoot, id, 'SKILL.md'), id);
        }
      }
    }
  }
  return issues;
});
