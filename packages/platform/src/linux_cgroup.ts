import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface LinuxCgroupMemoryFile {
  readonly path: string;
  readonly version: 1 | 2;
}

interface LinuxCgroupMembership {
  readonly path: string;
  readonly version: 1 | 2;
}

interface LinuxCgroupMount {
  readonly mountPoint: string;
  readonly root: string;
  readonly version: 1 | 2;
}

const CGROUP_UNLIMITED_BYTES_MINIMUM = 9_223_372_036_854_771_712n;

/**
 * Resolves every visible memory-controller limit from the process's current
 * cgroup through the mounted hierarchy root. Parent limits matter when a child
 * reports `max`, and mount roots matter inside cgroup namespaces.
 */
export function linuxCgroupMemoryFiles(
  processCgroup: string,
  processMountInfo: string,
): readonly LinuxCgroupMemoryFile[] {
  const memberships = parseLinuxCgroupMemberships(processCgroup);
  const mounts = parseLinuxCgroupMounts(processMountInfo);
  const files: LinuxCgroupMemoryFile[] = [];
  for (const membership of memberships) {
    const mount = matchingLinuxCgroupMount(membership, mounts);
    if (mount === undefined) continue;
    const relative = membership.path === '/' ? '' : relativeToRoot(membership.path, mount.root);
    const filename = membership.version === 2 ? 'memory.max' : 'memory.limit_in_bytes';
    for (const ancestor of visibleAncestorPaths(relative)) {
      files.push({path: joinLinuxPath(mount.mountPoint, ancestor, filename), version: membership.version});
    }
  }
  return [...new Map(EffectArray.map(files, file => [`${file.version}:${file.path}`, file])).values()];
}

/** Parses a positive finite cgroup byte limit exactly. Unlimited and malformed values are absent. */
export function parseLinuxCgroupMemoryLimitBytes(value: string): bigint | undefined {
  const normalized = Effect.pipe(value, EffectString.trim);
  if (!/^\d+$/.test(normalized)) return undefined;
  try {
    const bytes = BigInt(normalized);
    return bytes > 0n && bytes < CGROUP_UNLIMITED_BYTES_MINIMUM ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Physical RAM remains provenance; only a lower visible cgroup limit constrains capacity. */
export function effectiveLinuxMemoryBytes(
  physicalMemoryBytes: number,
  cgroupMemoryLimits: readonly (string | undefined)[],
): number {
  if (!Number.isSafeInteger(physicalMemoryBytes) || physicalMemoryBytes <= 0) return physicalMemoryBytes;
  const physical = BigInt(physicalMemoryBytes);
  let effective = physical;
  for (const value of cgroupMemoryLimits) {
    if (value === undefined) continue;
    const limit = parseLinuxCgroupMemoryLimitBytes(value);
    if (limit !== undefined && limit < effective) effective = limit;
  }
  return Number(effective);
}

function parseLinuxCgroupMemberships(input: string): readonly LinuxCgroupMembership[] {
  const memberships: LinuxCgroupMembership[] = [];
  for (const line of Effect.pipe(input, EffectString.split(/\r?\n/))) {
    // The path may itself contain colons, so only the first two separators are structural.
    const match = /^(\d+):([^:]*):(.*)$/.exec(Effect.pipe(line, EffectString.trim));
    if (!match) continue;
    const controllers = new Set(EffectArray.filter(Effect.pipe(match[2] ?? '', EffectString.split(',')), Boolean));
    const path = normalizeLinuxPath(match[3] ?? '/');
    if (path === undefined) continue;
    if (match[1] === '0' && controllers.size === 0) memberships.push({path, version: 2});
    if (controllers.has('memory')) memberships.push({path, version: 1});
  }
  return memberships;
}

function parseLinuxCgroupMounts(input: string): readonly LinuxCgroupMount[] {
  const mounts: LinuxCgroupMount[] = [];
  for (const line of Effect.pipe(input, EffectString.split(/\r?\n/))) {
    const fields = Effect.pipe(line, EffectString.trim, EffectString.split(/\s+/));
    const separator = fields.indexOf('-');
    if (separator < 6 || separator + 3 >= fields.length) continue;
    const filesystem = fields[separator + 1];
    const source = fields[separator + 2] ?? '';
    const superOptions = EffectArray.join(fields.slice(separator + 3), ',');
    const version =
      filesystem === 'cgroup2'
        ? 2
        : filesystem === 'cgroup' && hasMemoryController(source, superOptions)
          ? 1
          : undefined;
    if (version === undefined) continue;
    const mountPoint = normalizeLinuxPath(decodeMountInfoPath(fields[4] ?? '/'));
    const root = normalizeLinuxPath(decodeMountInfoPath(fields[3] ?? '/'));
    if (mountPoint === undefined || root === undefined) continue;
    mounts.push({mountPoint, root, version});
  }
  return mounts;
}

function matchingLinuxCgroupMount(
  membership: LinuxCgroupMembership,
  mounts: readonly LinuxCgroupMount[],
): LinuxCgroupMount | undefined {
  return EffectArray.filter(
    mounts,
    __effectArrayValue =>
      !!(candidate =>
        candidate.version === membership.version &&
        (membership.path === '/' || pathWithinRoot(membership.path, candidate.root)))(__effectArrayValue),
  ).sort((left, right) => right.root.length - left.root.length)[0];
}

function hasMemoryController(source: string, superOptions: string): boolean {
  return Effect.pipe(`${source},${superOptions}`, EffectString.split(',')).includes('memory');
}

function decodeMountInfoPath(value: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function normalizeLinuxPath(value: string): string | undefined {
  if (
    !Effect.pipe(value, EffectString.startsWith('/')) ||
    EffectArray.some([...value], character => isControlCharacter(character))
  )
    return undefined;
  const segments: string[] = [];
  for (const segment of Effect.pipe(value, EffectString.split('/'))) {
    if (!segment) continue;
    if (segment === '.' || segment === '..') return undefined;
    segments.push(segment);
  }
  return `/${EffectArray.join(segments, '/')}`;
}

function isControlCharacter(value: string): boolean {
  const code = Effect.pipe(
    value,
    EffectString.charCodeAt(0),
    Effect.Option.getOrElse(() => NaN),
  );
  return code <= 31 || code === 127;
}

function pathWithinRoot(path: string, root: string): boolean {
  return root === '/' || path === root || Effect.pipe(path, EffectString.startsWith(`${root}/`));
}

function relativeToRoot(path: string, root: string): string {
  if (root === '/') return Effect.pipe(path, EffectString.slice(1));
  return path === root ? '' : Effect.pipe(path, EffectString.slice(root.length + 1));
}

function visibleAncestorPaths(relative: string): readonly string[] {
  if (!relative) return [''];
  const segments = Effect.pipe(relative, EffectString.split('/'));
  return Array.from({length: segments.length + 1}, (_, index) =>
    EffectArray.join(segments.slice(0, segments.length - index), '/'),
  );
}

function joinLinuxPath(...parts: readonly string[]): string {
  return `/${EffectArray.join(
    EffectArray.filter(
      EffectArray.flatMap(parts, part => Effect.pipe(part, EffectString.split('/'))),
      Boolean,
    ),
    '/',
  )}`;
}
