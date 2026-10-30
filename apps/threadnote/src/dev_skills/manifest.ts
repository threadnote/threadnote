import {Array as EffectArray} from 'effect';
import {nativeWorkflowFeatureVersions} from '../workflow_automation/features.js';
import {Context, Effect, FileSystem, Option, Path} from 'effect';
import {toolRoot} from '@threadnote/workspace/installation';
import {getThreadnoteVersion, isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import {compareVersions} from '../release/version/compare.js';
import type {
  DevSkillMember,
  DevSkillsBundle,
  DevSkillsIssue,
  DevSkillsManifest,
  NativeWorkflowRequirements,
} from './contract.js';
import {decode, enumerateFiles, fail, hash, isRecord, readOptional, requireValue} from './files.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const historicalPrerequisites = {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']};
export const nativeRequirements = nativeWorkflowFeatureVersions;
/** Watch v2 retains v1 commands/generations; no other feature or future version is implicitly compatible. */
export const supportsNativeRequirements = (
  required: NativeWorkflowRequirements,
  supported: NativeWorkflowRequirements,
): boolean =>
  EffectArray.every(EffectRecord.toEntries(nativeRequirements), ([key, current]) =>
    key === 'watchVersion'
      ? (required[key] === 1 && (supported[key] === 1 || supported[key] === 2)) ||
        (required[key] === 2 && supported[key] === 2)
      : required[key] === current && supported[key] === current,
  );
const prerequisites = {commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']};
export function parseNativeRequirements(value: unknown) {
  requireValue(
    isRecord(value) &&
      EffectRecord.keys(value).length === EffectRecord.keys(nativeRequirements).length &&
      EffectArray.every(EffectRecord.keys(value), key => key in nativeRequirements) &&
      EffectArray.every(
        EffectRecord.values(value),
        item => Number.isSafeInteger(item) && typeof item === 'number' && item > 0,
      ),
    'Invalid native workflow requirements.',
  );
  const {executorVersion, authoringVersion, cycleVersion, watchVersion, closeoutVersion} = value;
  requireValue(
    typeof executorVersion === 'number' &&
      typeof authoringVersion === 'number' &&
      typeof cycleVersion === 'number' &&
      typeof watchVersion === 'number' &&
      typeof closeoutVersion === 'number',
    'Missing native workflow requirements.',
  );
  return {executorVersion, authoringVersion, cycleVersion, watchVersion, closeoutVersion};
}
export function validDevSkillPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_./-]+$/u.test(value) &&
    EffectArray.every(
      Effect2.pipe(value, EffectString.split('/')),
      part =>
        !['', '.', '..'].includes(part) &&
        !Effect2.pipe(part, EffectString.endsWith('.')) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) &&
        !['__pycache__', '.DS_Store', '.context', '.git'].includes(part),
    ) &&
    !Effect2.pipe(value, EffectString.endsWith('.pyc'))
  );
}
const primaryIds = ['dev-cycle', 'dev-plan', 'dev-spec'];
export const DEV_SKILLS_MAX_HISTORICAL_SUPPORT_MEMBERS = 16;
export const hasHistoricalDevSkillsMembers = (manifest: DevSkillsManifest) =>
  EffectArray.join(
    EffectArray.map(manifest.skills, skill => skill.id),
    ',',
  ) !== 'dev-cycle,dev-plan,dev-spec,watch-pr';
export function parseDevSkillsInventory(value: unknown, historical = false) {
  requireValue(
    isRecord(value) &&
      (value.schemaVersion === 2 || (historical && value.schemaVersion === 1)) &&
      value.workflowProtocol === 1 &&
      value.stateSchema === 1 &&
      typeof value.minimumRuntime === 'string' &&
      version.test(value.minimumRuntime) &&
      EffectArray.isArray(value.skills) &&
      value.skills.length <= (historical ? 3 + DEV_SKILLS_MAX_HISTORICAL_SUPPORT_MEMBERS : 4),
    'Unsupported development workflow manifest contract.',
  );
  requireValue(
    EffectArray.every(EffectRecord.keys(value), key =>
      [
        'schemaVersion',
        ...(value.schemaVersion === 2 ? ['nativeRequirements'] : []),
        'workflowProtocol',
        'stateSchema',
        'minimumRuntime',
        'skills',
        'releaseVersion',
        'prerequisites',
        'hashes',
        'digest',
      ].includes(key),
    ),
    'Unknown bundle manifest fields.',
  );
  if ('prerequisites' in value)
    requireValue(
      JSON.stringify(value.prerequisites) ===
        JSON.stringify(value.schemaVersion === 1 ? historicalPrerequisites : prerequisites),
      'Invalid development workflow prerequisites.',
    );
  const native = value.schemaVersion === 2 ? parseNativeRequirements(value.nativeRequirements) : undefined;
  const skills: DevSkillMember[] = EffectArray.map(value.skills, (skill: unknown): DevSkillMember => {
    requireValue(
      isRecord(skill) &&
        typeof skill.id === 'string' &&
        /^[a-z][a-z-]+$/u.test(skill.id) &&
        (skill.role === 'primary' || skill.role === 'support') &&
        EffectArray.isArray(skill.files) &&
        skill.files.length <= 256 &&
        EffectArray.every(skill.files, validDevSkillPath) &&
        skill.files.includes('SKILL.md') &&
        new Set(EffectArray.map(skill.files, file => Effect2.pipe(file, EffectString.toLowerCase))).size ===
          skill.files.length,
      'Invalid development skill member or payload path.',
    );
    requireValue(
      EffectArray.every(EffectRecord.keys(skill), key => ['id', 'role', 'files'].includes(key)),
      'Unknown skill manifest fields.',
    );
    return {id: skill.id, role: skill.role, files: [...skill.files].sort()};
  }).sort((a, b) => Effect2.pipe(a.id, EffectString.localeCompare(b.id)));
  if (historical) {
    requireValue(
      EffectArray.join(
        EffectArray.map(
          EffectArray.filter(skills, skill => skill.role === 'primary'),
          skill => skill.id,
        ),
        ',',
      ) === EffectArray.join(primaryIds, ',') &&
        EffectArray.filter(skills, skill => skill.role === 'support').length <=
          DEV_SKILLS_MAX_HISTORICAL_SUPPORT_MEMBERS &&
        new Set(EffectArray.map(skills, skill => Effect2.pipe(skill.id, EffectString.toLowerCase))).size ===
          skills.length &&
        EffectArray.every(skills, skill =>
          primaryIds.includes(skill.id)
            ? skill.role === 'primary'
            : skill.role === 'support' &&
              /^(?:watch-pr|dev-[a-z][a-z-]{0,47})$/u.test(skill.id) &&
              validDevSkillPath(skill.id),
        ),
      'Historical ownership requires fixed primary workflows and bounded development support members.',
    );
  } else
    requireValue(
      EffectArray.join(
        EffectArray.map(skills, skill => skill.id),
        ',',
      ) === 'dev-cycle,dev-plan,dev-spec,watch-pr' &&
        EffectArray.every(skills, skill => skill.role === (skill.id === 'watch-pr' ? 'support' : 'primary')),
      'The complete development bundle must contain all four workflows.',
    );
  return {value, skills, minimumRuntime: value.minimumRuntime, native};
}
/** Mirrors the release builder's canonical digest without importing its executable entrypoint. */
export function parseDevSkillsManifest(value: unknown): DevSkillsManifest {
  return parseManifest(value, false);
}
/** Stored ownership only; never admits a release payload or an arbitrary destination. */
export function parseHistoricalDevSkillsManifest(value: unknown): DevSkillsManifest {
  return parseManifest(value, true);
}
function parseManifest(value: unknown, historical: boolean): DevSkillsManifest {
  const inventory = parseDevSkillsInventory(value, historical);
  const v = inventory.value;
  requireValue(
    typeof v.releaseVersion === 'string' &&
      version.test(v.releaseVersion) &&
      isRecord(v.hashes) &&
      JSON.stringify(v.prerequisites) ===
        JSON.stringify(v.schemaVersion === 1 ? historicalPrerequisites : prerequisites),
    'Invalid enriched bundle manifest.',
  );
  const hashes: Record<string, string> = {};
  for (const skill of inventory.skills)
    for (const file of skill.files) {
      const key = `${skill.id}/${file}`;
      const digest = v.hashes[key];
      requireValue(typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest), 'Invalid bundle file digest.');
      hashes[key] = digest;
    }
  requireValue(EffectRecord.keys(v.hashes).length === EffectRecord.keys(hashes).length, 'Unexpected bundle hashes.');
  const manifest = {
    schemaVersion: v.schemaVersion === 1 ? (1 as const) : (2 as const),
    ...(inventory.native ? {nativeRequirements: inventory.native} : {}),
    workflowProtocol: 1 as const,
    stateSchema: 1 as const,
    minimumRuntime: inventory.minimumRuntime,
    releaseVersion: v.releaseVersion,
    prerequisites: v.schemaVersion === 1 ? historicalPrerequisites : prerequisites,
    skills: inventory.skills,
    hashes,
  };
  requireValue(v.digest === hash(JSON.stringify(manifest)), 'Bundle digest does not match its canonical manifest.');
  return {...manifest, digest: v.digest};
}
export const loadDevSkillsBundleAt = Effect.fn('devSkills.loadBundleAt')(function* (
  root: string,
  runtimeVersion: string,
  requireEnriched = isStandaloneThreadnoteBuild(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = yield* fs.realPath(root);
  const content = yield* readOptional(path.join(canonical, 'config', 'dev-skills.json'));
  if (content === null)
    return yield* fail('missing-bundle', 'This Threadnote installation has no development skills manifest.');
  const inventory = yield* decode(content, parseDevSkillsInventory);
  const files: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  let size = 0;
  for (const skill of inventory.skills) {
    const directory = path.join(canonical, 'config', 'agent-skills', skill.id);
    if (JSON.stringify(yield* enumerateFiles(directory)) !== JSON.stringify(skill.files))
      return yield* fail('invalid-bundle', `The shipped inventory differs for ${skill.id}.`);
    for (const file of skill.files) {
      const absolute = path.join(directory, file);
      const info = yield* fs.stat(absolute);
      if (Number(info.size) > 2_000_000)
        return yield* fail('invalid-bundle', 'A development payload file exceeds its size limit.');
      const bytes = yield* fs.readFile(absolute);
      size += bytes.length;
      if (size > 2_000_000) return yield* fail('invalid-bundle', 'Development bundle exceeds its size limit.');
      const key = `${skill.id}/${file}`;
      files[key] = Buffer.from(bytes).toString('base64');
      hashes[key] = hash(bytes);
    }
  }
  let manifest: DevSkillsManifest;
  if ('digest' in inventory.value || 'releaseVersion' in inventory.value || 'hashes' in inventory.value) {
    manifest = yield* decode(content, parseDevSkillsManifest);
    if (JSON.stringify(manifest.hashes) !== JSON.stringify(hashes))
      return yield* fail('invalid-bundle', 'Shipped bundle bytes differ from their release hashes.');
  } else {
    if (requireEnriched)
      return yield* fail('invalid-bundle', 'Installed releases require their enriched release inventory fields.');
    if (!version.test(runtimeVersion))
      return yield* fail('incompatible', 'Cannot identify the executing Threadnote version.');
    const enriched = {
      schemaVersion: 2 as const,
      nativeRequirements: inventory.native!,
      workflowProtocol: 1 as const,
      stateSchema: 1 as const,
      minimumRuntime: inventory.minimumRuntime,
      releaseVersion: runtimeVersion,
      prerequisites,
      skills: inventory.skills,
      hashes,
    };
    manifest = {...enriched, digest: hash(JSON.stringify(enriched))};
  }
  if (!version.test(runtimeVersion) || compareVersions(runtimeVersion, manifest.minimumRuntime) < 0)
    return yield* fail('incompatible', `Development workflows require Threadnote ${manifest.minimumRuntime} or newer.`);
  const incompatibility = devSkillsCompatibility(manifest, runtimeVersion);
  if (incompatibility.length) return yield* fail('incompatible', incompatibility[0].message);
  return {manifest, files} satisfies DevSkillsBundle;
});
export class DevSkillsSource extends Context.Service<
  DevSkillsSource,
  {readonly root: string; readonly runtimeVersion: string}
>()('@threadnote/threadnote/dev_skills/manifest/DevSkillsSource') {}
export const devSkillsRuntimeVersion = Effect.fn('devSkills.runtimeVersion')(function* () {
  const source = yield* Effect.serviceOption(DevSkillsSource);
  return Option.isSome(source) ? source.value.runtimeVersion : yield* getThreadnoteVersion();
});
export function devSkillsCompatibility(manifest: DevSkillsManifest, runtimeVersion: string): DevSkillsIssue[] {
  if (manifest.schemaVersion === 1)
    return [
      {
        code: 'legacy-workflow-update-required',
        message:
          'Retained Python workflow ownership is recognized. Explicitly update or repair these workflows before running them.',
      },
    ];
  if (manifest.schemaVersion !== 2 || manifest.workflowProtocol !== 1 || manifest.stateSchema !== 1)
    return [
      {code: 'incompatible', message: 'Installed development workflows require an unsupported runtime protocol.'},
    ];
  if (!manifest.nativeRequirements || !supportsNativeRequirements(manifest.nativeRequirements, nativeRequirements))
    return [
      {code: 'incompatible', message: 'Installed development workflows require unsupported native workflow features.'},
    ];
  return !version.test(runtimeVersion) || compareVersions(runtimeVersion, manifest.minimumRuntime) < 0
    ? [
        {
          code: 'incompatible',
          message: `Installed development workflows require Threadnote ${manifest.minimumRuntime} or newer; executing runtime is ${runtimeVersion}. Update Threadnote before using these workflows.`,
        },
      ]
    : [];
}
export const loadDevSkillsBundle = Effect.fn('devSkills.loadBundle')(function* () {
  const source = yield* Effect.serviceOption(DevSkillsSource);
  return Option.isSome(source)
    ? yield* loadDevSkillsBundleAt(source.value.root, source.value.runtimeVersion)
    : yield* loadDevSkillsBundleAt(yield* toolRoot(), yield* getThreadnoteVersion());
});
