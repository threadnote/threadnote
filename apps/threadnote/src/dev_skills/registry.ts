import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {SystemInfo} from '@threadnote/platform/system';
import {installationRoot} from '../process/standalone_lease.js';
import type {DevSkillsConsumer, DevSkillsManifest, DevSkillsTarget} from './contract.js';
import {decode, fail, hash, isRecord, readOptional, requireValue, statOptional} from './files.js';
import {parseHistoricalDevSkillsManifest} from './manifest.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function reject(code: string, message: string): never {
  throw fail(code, message);
}

export interface Enrollment extends DevSkillsConsumer {
  readonly state: 'enrolled' | 'removed';
  readonly enabled: boolean;
  readonly createdBy?: string;
}
export interface HomeIndex {
  readonly schemaVersion: 2;
  readonly home: string;
  readonly installationRoot: string;
  readonly targets: Readonly<Record<string, Enrollment>>;
}
export interface RuntimeIndex {
  readonly schemaVersion: 2;
  readonly installationRoot: string;
  readonly enrollments: Readonly<Record<string, Enrollment>>;
}
export interface PhysicalReceipt {
  readonly schemaVersion: 1;
  readonly skillRoot: string;
  readonly layout: 'directory' | 'flat';
  readonly manifest: DevSkillsManifest;
  readonly generations: Readonly<Record<string, DevSkillsManifest>>;
  readonly entrypoints: Readonly<Record<string, string>>;
  readonly consumers: Readonly<Record<string, DevSkillsConsumer>>;
}
const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value) &&
  !Effect2.pipe(value, EffectString.includes('\0'));
export const consumerId = (consumer: DevSkillsConsumer) =>
  hash(
    JSON.stringify({
      home: consumer.home,
      surfaceId: consumer.target.surfaceId,
      profile: consumer.target.profile,
      scope: consumer.target.scope,
      cwd: consumer.target.cwd ?? null,
    }),
  );
export function parseTarget(value: unknown): DevSkillsTarget {
  requireValue(
    isRecord(value) &&
      typeof value.surfaceId === 'string' &&
      typeof value.agentId === 'string' &&
      ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'].includes(String(value.profile)) &&
      ['user', 'project', 'local'].includes(String(value.scope)) &&
      absolute(value.skillRoot) &&
      ['directory', 'flat'].includes(String(value.layout)) &&
      EffectArray.isArray(value.discoveryRoots) &&
      value.discoveryRoots.length <= 8 &&
      EffectArray.every(value.discoveryRoots, absolute) &&
      (value.cwd === undefined || absolute(value.cwd)),
    'Invalid pinned development skills target.',
  );
  const profile =
    value.profile === 'desktop' || value.profile === 'codex-cloud-personal' || value.profile === 'cursor-cloud-personal'
      ? value.profile
      : reject('invalid-index', 'Invalid pinned development skills target.');
  const scope =
    value.scope === 'user' || value.scope === 'project' || value.scope === 'local'
      ? value.scope
      : reject('invalid-index', 'Invalid pinned development skills target.');
  const layout =
    value.layout === 'directory' || value.layout === 'flat'
      ? value.layout
      : reject('invalid-index', 'Invalid pinned development skills target.');
  const skillRoot = absolute(value.skillRoot)
    ? value.skillRoot
    : reject('invalid-index', 'Invalid pinned development skills target.');
  const discoveryRoots = EffectArray.map(value.discoveryRoots, root =>
    absolute(root) ? root : reject('invalid-index', 'Invalid pinned development skills target.'),
  );
  const cwd = value.cwd;
  if (cwd !== undefined && !absolute(cwd)) reject('invalid-index', 'Invalid pinned development skills target.');
  return {
    surfaceId: value.surfaceId,
    agentId: value.agentId,
    profile,
    scope,
    skillRoot,
    layout,
    discoveryRoots,
    ...(cwd === undefined ? {} : {cwd}),
  };
}
function parseConsumer(value: unknown): DevSkillsConsumer {
  requireValue(
    isRecord(value) && absolute(value.home) && absolute(value.installationRoot),
    'Invalid development skills consumer.',
  );
  return {home: value.home, installationRoot: value.installationRoot, target: parseTarget(value.target)};
}
function parseEnrollments(value: unknown, version: 1 | 2): Record<string, Enrollment> {
  requireValue(isRecord(value) && EffectRecord.keys(value).length <= 1024, 'Invalid enrollment index.');
  const result: Record<string, Enrollment> = {};
  for (const [key, entry] of EffectRecord.toEntries(value)) {
    const consumer = parseConsumer(entry);
    requireValue(
      isRecord(entry) && ['enrolled', 'removed'].includes(String(entry.state)) && key === consumerId(consumer),
      'Invalid enrollment identity.',
    );
    requireValue(
      (version === 1 && entry.enabled === undefined) ||
        (version === 2 && typeof entry.enabled === 'boolean' && (entry.state !== 'removed' || !entry.enabled)),
      'Invalid enrollment enablement.',
    );
    requireValue(
      entry.createdBy === undefined ||
        (version === 2 &&
          typeof entry.createdBy === 'string' &&
          /^[a-f0-9]{64}$/u.test(entry.createdBy) &&
          entry.state === 'enrolled'),
      'Invalid setup ownership checkpoint.',
    );
    const state =
      entry.state === 'enrolled' || entry.state === 'removed'
        ? entry.state
        : reject('invalid-index', 'Invalid enrollment identity.');
    result[key] = {
      ...consumer,
      state,
      enabled: version === 1 ? state === 'enrolled' : entry.enabled === true,
      ...(entry.createdBy ? {createdBy: entry.createdBy} : {}),
    };
  }
  return result;
}
export function parseHomeIndex(value: unknown): HomeIndex {
  requireValue(
    isRecord(value) &&
      (value.schemaVersion === 1 || value.schemaVersion === 2) &&
      absolute(value.home) &&
      absolute(value.installationRoot),
    'Invalid home enrollment index.',
  );
  const targets = parseEnrollments(value.targets, value.schemaVersion);
  requireValue(
    EffectArray.every(
      EffectRecord.values(targets),
      entry => entry.home === value.home && entry.installationRoot === value.installationRoot,
    ),
    'Enrollment home/runtime identity differs.',
  );
  return {schemaVersion: 2, home: value.home, installationRoot: value.installationRoot, targets};
}
export function parseRuntimeIndex(value: unknown): RuntimeIndex {
  requireValue(
    isRecord(value) && (value.schemaVersion === 1 || value.schemaVersion === 2) && absolute(value.installationRoot),
    'Invalid runtime enrollment index.',
  );
  const enrollments = parseEnrollments(value.enrollments, value.schemaVersion);
  requireValue(
    EffectArray.every(EffectRecord.values(enrollments), entry => entry.installationRoot === value.installationRoot),
    'Enrollment runtime identity differs.',
  );
  return {schemaVersion: 2, installationRoot: value.installationRoot, enrollments};
}
export function entrypointPath(layout: DevSkillsTarget['layout'], id: string) {
  return layout === 'flat' ? `${id}.md` : `${id}/SKILL.md`;
}
export function parseReceipt(value: unknown): PhysicalReceipt {
  requireValue(
    isRecord(value) &&
      value.schemaVersion === 1 &&
      absolute(value.skillRoot) &&
      ['directory', 'flat'].includes(String(value.layout)) &&
      isRecord(value.entrypoints) &&
      isRecord(value.generations) &&
      EffectRecord.keys(value.generations).length <= 1024 &&
      isRecord(value.consumers) &&
      EffectRecord.keys(value.consumers).length <= 1024,
    'Invalid physical skills receipt.',
  );
  const manifest = parseHistoricalDevSkillsManifest(value.manifest);
  const generations: Record<string, DevSkillsManifest> = {};
  for (const [key, generation] of EffectRecord.toEntries(value.generations)) {
    const decoded = parseHistoricalDevSkillsManifest(generation);
    requireValue(key === decoded.digest, 'Invalid retained generation identity.');
    generations[key] = decoded;
  }
  requireValue(manifest.digest in generations, 'Current generation is not owned.');
  const layout =
    value.layout === 'directory' || value.layout === 'flat'
      ? value.layout
      : reject('invalid-index', 'Invalid physical skills receipt.');
  const allowed = new Set(EffectArray.map(manifest.skills, member => entrypointPath(layout, member.id)));
  const entrypoints: Record<string, string> = {};
  for (const [key, content] of EffectRecord.toEntries(value.entrypoints)) {
    requireValue(
      allowed.has(key) && typeof content === 'string' && content.length <= 300_000,
      'Invalid discovery entrypoint receipt.',
    );
    entrypoints[key] = content;
  }
  const consumers: Record<string, DevSkillsConsumer> = {};
  for (const [key, entry] of EffectRecord.toEntries(value.consumers)) {
    const consumer = parseConsumer(entry);
    requireValue(
      key === consumerId(consumer) &&
        consumer.target.skillRoot === value.skillRoot &&
        consumer.target.layout === layout,
      'Physical consumer identity differs.',
    );
    consumers[key] = consumer;
  }
  requireValue(
    EffectRecord.keys(consumers).length === 0
      ? EffectRecord.keys(entrypoints).length === 0
      : EffectRecord.keys(entrypoints).length === allowed.size,
    'Incomplete discovery entrypoint ownership.',
  );
  return {schemaVersion: 1, skillRoot: value.skillRoot, layout, manifest, generations, entrypoints, consumers};
}
export const homeIndexPath = (path: Path.Path, home: string) => path.join(home, 'dev-skills', 'index.json');
export const runtimeIndexPath = (path: Path.Path, root: string) => path.join(root, 'dev-skills-enrollment.json');
export const physicalDirectory = (path: Path.Path, root: string) => path.join(root, '.threadnote-dev-skills');
export const receiptPath = (path: Path.Path, root: string) => path.join(physicalDirectory(path, root), 'receipt.json');
export const journalPath = (path: Path.Path, root: string) => path.join(physicalDirectory(path, root), 'journal.json');
/** Only genuine absence permits legacy uninstall; even dangling or empty state requires normal ownership checks. */
export const hasDevSkillsHomeState = Effect.fn('devSkills.hasHomeState')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(homeIndexPath(path, path.resolve(config.agentContextHome)));
  const link = yield* fs.readLink(directory).pipe(Effect.result);
  if (link._tag === 'Success') return true;
  if (!['NotFound', 'InvalidArgument', 'Unknown'].includes(link.failure.reason._tag)) return yield* link.failure;
  if (yield* statOptional(directory)) return true;
  if (link.failure.reason._tag !== 'NotFound') return yield* link.failure;
  return false;
});
export const readHomeIndex = Effect.fn('devSkills.homeIndex')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  const home = path.resolve(config.agentContextHome);
  const content = yield* readOptional(homeIndexPath(path, home));
  const index = content === null ? undefined : yield* decode(content, parseHomeIndex);
  if (index && index.home !== home) return yield* fail('invalid-state', 'Pinned home identity differs.');
  return {content, index};
});
export const enrollmentContext = Effect.fn('devSkills.enrollmentContext')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = path.resolve(config.agentContextHome);
  const homeRead = yield* readHomeIndex(config);
  const root = homeRead.index?.installationRoot ?? installationRoot(path, system);
  const runtimeContent = yield* readOptional(runtimeIndexPath(path, root));
  const runtime =
    runtimeContent === null
      ? {schemaVersion: 2 as const, installationRoot: root, enrollments: {}}
      : yield* decode(runtimeContent, parseRuntimeIndex);
  if (runtime.installationRoot !== root) return yield* fail('invalid-state', 'Pinned runtime identity differs.');
  return {
    home,
    root,
    homeContent: homeRead.content,
    runtimeContent,
    homeIndex: homeRead.index ?? {schemaVersion: 2 as const, home, installationRoot: root, targets: {}},
    runtimeIndex: runtime,
  };
});
export const readReceipt = Effect.fn('devSkills.receipt')(function* (target: DevSkillsTarget) {
  const path = yield* Path.Path;
  const content = yield* readOptional(receiptPath(path, target.skillRoot));
  const receipt = content === null ? undefined : yield* decode(content, parseReceipt);
  if (receipt && (receipt.skillRoot !== target.skillRoot || receipt.layout !== target.layout))
    return yield* fail('invalid-state', 'Pinned physical root differs.');
  return {content, receipt};
});
