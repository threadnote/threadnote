import * as OverlayArray from 'effect/Array';
import * as OverlayString from 'effect/String';
import * as OverlayRecord from 'effect/Record';
import * as OverlayOption from 'effect/Option';
/* oxlint-disable effecttsgo/node-builtin-import, threadnote/no-node-runtime -- Offline compiler/archive construction is a Node/CLI boundary. */
import {createHash} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {unzipSync, zipSync, type Zippable} from 'fflate';
export const gradleOverlayPins = {
  providerCommit: '8de7bcf76e785507ad92f0741ab9235a430c95e6',
  consumerCommit: '92f0512e7f06d84621afba191f75e265363890cf',
  gradleArchive: '21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607',
  gradleTree: '7f71bf5a48e8e152f2287e88cf37190a308bcbfa24e96e53abc455e9deff21aa',
  gradleSdkDigest: '6da4ff86101bec03978e03b6acdb2d8ae958759c1da1dc69aa8e1d83f78ff9bc',
  compilerArchive: '36dc14d797aaff6d89aab302cd053fdba6207dfdcf772052fa7b023a94b0e857',
  compilerTree: '68f98f71472d6184f929b3034fb0e7702444f4440481442ab06b385e39406a59',
  zipLibrary: 'fflate@0.8.3',
  patch: 'afe7700707cb4aa8041d4c7eadcaa9786229e53fdae4c62189b6c705613205c5',
} as const;
const sourcePins = [
  [
    'platforms/core-runtime/launcher/src/main/java/org/gradle/launcher/daemon/bootstrap/ForegroundDaemonAction.java',
    '9e17fb33bb6027878fc77c764b9e3cffbcdc119630a6ceeff2fc855c4c090ed1',
  ],
  [
    'platforms/core-runtime/launcher/src/main/java/org/gradle/tooling/internal/provider/ProviderConnection.java',
    'e5dc0639851232c9422a779039a545e87b6d70e55cc5a12c5602919b2b794723',
  ],
  [
    'platforms/core-runtime/client-services/src/main/java/org/gradle/launcher/daemon/client/DaemonClientFactory.java',
    'ec23a7cfaacf3e0b06b27f35ff6297806efec54d46160b6a31db77cb59a9739b',
  ],
  [
    'platforms/core-runtime/client-services/src/main/java/org/gradle/launcher/daemon/client/DaemonClientServices.java',
    '5dc96cd232084944f9068c31750fefee8b9292be832b7cb2e75f66a2f19a9ab7',
  ],
] as const;
const familyJars = {
  'org/gradle/launcher/daemon/bootstrap/ForegroundDaemonAction': 'lib/gradle-launcher-9.8.2.jar',
  'org/gradle/tooling/internal/provider/ProviderConnection': 'lib/gradle-launcher-9.8.2.jar',
  'org/gradle/launcher/daemon/client/DaemonClientFactory': 'lib/gradle-client-services-9.8.2.jar',
  'org/gradle/launcher/daemon/client/DaemonClientServices': 'lib/gradle-client-services-9.8.2.jar',
  'org/gradle/launcher/daemon/client/OwnedBuildControl': 'lib/gradle-client-services-9.8.2.jar',
};
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export const overlayHash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !OverlayArray.isArray(item)
      ? OverlayRecord.fromEntries(OverlayRecord.toEntries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
export function validArchivePath(name: string): boolean {
  return (
    name.length > 0 &&
    !OverlayString.includes('\\')(name) &&
    !OverlayString.includes('\0')(name) &&
    !OverlayString.startsWith('/')(name) &&
    OverlayArray.every(OverlayString.split(name, '/'), part => part !== '..' && part !== '.' && part !== '')
  );
}
const family = (name: string, parent: string): boolean =>
  name === parent + '.class' ||
  (OverlayString.startsWith(parent + '$')(name) && OverlayString.endsWith('.class')(name));

/** Inspect central-directory identities before decompression; do not silently accept duplicate entries. */
export function zipModes(bytes: Uint8Array): Map<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  requireThat(end >= 0, 'Missing ZIP end record.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const modes = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    requireThat(view.getUint32(at, true) === 0x02014b50, 'Invalid/ZIP64 central directory.');
    const length = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true);
    const name = new TextDecoder('utf8', {
      fatal: true,
    }).decode(bytes.subarray(at + 46, at + 46 + length));
    requireThat(
      validArchivePath(OverlayString.endsWith('/')(name) ? OverlayString.slice(0, -1)(name) : name) && !modes.has(name),
      'Unsafe/duplicate ZIP path.',
    );
    requireThat((view.getUint16(at + 8, true) & 1) === 0, 'Encrypted ZIP input.');
    modes.set(name, view.getUint32(at + 38, true) >>> 16);
    at += 46 + length + extra + comment;
  }
  requireThat(at === end, 'Unsupported ZIP central-directory extension.');
  return modes;
}
/** Fixed UTC epoch, ordering, permissions and compression; never mutate input buffers. */
export function deterministicZip(
  entries: ReadonlyMap<string, Uint8Array>,
  modes: ReadonlyMap<string, number>,
): Uint8Array {
  const input: Zippable = {};
  for (const name of [...entries.keys()].sort()) {
    requireThat(
      validArchivePath(OverlayString.endsWith('/')(name) ? OverlayString.slice(0, -1)(name) : name),
      'Unsafe output ZIP path.',
    );
    input[name] = [
      entries.get(name)!,
      {
        mtime: new Date(1980, 0, 1, 0, 0, 0),
        os: 3,
        attrs: (modes.get(name) ?? (OverlayString.endsWith('/')(name) ? 0o40755 : 0o100644)) << 16,
      },
    ];
  }
  return zipSync(input, {
    level: 6,
  });
}
export function rewriteOwnedJar(
  original: Uint8Array,
  replacements: ReadonlyMap<string, Uint8Array>,
  families: readonly string[],
): Uint8Array {
  const modes = zipModes(original),
    before = unzipSync(original),
    entries = new Map<string, Uint8Array>(OverlayRecord.toEntries(before));
  for (const [name, bytes] of entries) {
    requireThat(!/^META-INF\/.*\.(?:SF|RSA|DSA|EC)$/iu.test(name), 'Signed target JAR is not supported.');
    if (name === 'META-INF/MANIFEST.MF')
      requireThat(
        !/(?:^|\r?\n)[^\r\n]*-Digest:/iu.test(new TextDecoder().decode(bytes)),
        'Digest-protected target JAR.',
      );
    if (OverlayArray.some(families, parent => family(name, parent))) entries.delete(name);
  }
  for (const [name, bytes] of replacements) {
    requireThat(
      OverlayArray.some(families, parent => family(name, parent)),
      'Unowned replacement class.',
    );
    entries.set(name, bytes);
    modes.set(name, 0o100644);
  }
  for (const parent of families) requireThat(entries.has(parent + '.class'), 'Missing top-level replacement.');
  const result = deterministicZip(entries, modes),
    after = unzipSync(result),
    afterModes = zipModes(result);
  for (const [name, bytes] of OverlayRecord.toEntries(before)) {
    if (!OverlayArray.some(families, parent => family(name, parent))) {
      requireThat(
        overlayHash(bytes) === overlayHash(after[name]) && modes.get(name) === afterModes.get(name),
        'Unchanged JAR entry or mode changed.',
      );
    }
  }
  return result;
}
type Member = {
  access: number;
  name: string;
  descriptor: string;
  attributes: Record<string, unknown>;
};
type ClassInfo = {
  name: string;
  access: number;
  parent: string;
  interfaces: string[];
  fields: Member[];
  methods: Member[];
  attributes: Record<string, unknown>;
  references: {
    owner: string;
    name: string;
    descriptor: string;
    field: boolean;
  }[];
};
/** Read symbolic ABI, rather than comparing pool indices or javap presentation. Reject unknown ABI annotations. */
export function classInfo(bytes: Uint8Array, requireJava8 = true): ClassInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u1 = () => view.getUint8(at++),
    u2 = () => {
      const n = view.getUint16(at);
      at += 2;
      return n;
    },
    u4 = () => {
      const n = view.getUint32(at);
      at += 4;
      return n;
    };
  requireThat(u4() === 0xcafebabe, 'Invalid class.');
  u2();
  const major = u2();
  requireThat(!requireJava8 || major === 52, 'Expected Java8 major52 class.');
  const pool: unknown[] = [undefined];
  const tags: number[] = [0];
  const count = u2();
  for (let i = 1; i < count; i++) {
    const tag = u1();
    tags[i] = tag;
    if (tag === 1) {
      const size = u2();
      pool[i] = new TextDecoder().decode(bytes.subarray(at, at + size));
      at += size;
    } else if (OverlayArray.contains([3, 4], tag)) pool[i] = u4();
    else if (OverlayArray.contains([5, 6], tag)) {
      pool[i] = [u4(), u4()];
      i++;
      pool[i] = undefined;
    } else if (OverlayArray.contains([7, 8, 16, 19, 20], tag)) pool[i] = u2();
    else if (OverlayArray.contains([9, 10, 11, 12, 17, 18], tag)) pool[i] = [u2(), u2()];
    else if (tag === 15) pool[i] = [u1(), u2()];
    else throw new Error('Unsupported constant pool tag.');
  }
  const utf = (i: number): string => {
    const value = pool[i];
    requireThat(typeof value === 'string', 'Expected constant UTF8.');
    return value;
  };
  const cls = (i: number): string => (i === 0 ? '' : utf(Number(pool[i])));
  const value = (): unknown => {
    const tag = String.fromCharCode(u1());
    if (OverlayString.includes(tag)('BCDFIJSZs')) {
      const i = u2();
      return [tag, pool[i]];
    }
    if (tag === 'e') return [tag, utf(u2()), utf(u2())];
    if (tag === 'c') return [tag, utf(u2())];
    if (tag === '@') return annotation();
    if (tag === '[')
      return Array.from(
        {
          length: u2(),
        },
        value,
      );
    throw new Error('Unsupported annotation value.');
  };
  const annotation = (): unknown => {
    const type = utf(u2());
    return [
      type,
      Array.from(
        {
          length: u2(),
        },
        () => [utf(u2()), value()],
      ),
    ];
  };
  const attrs = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (let n = u2(); n > 0; n--) {
      const name = utf(u2()),
        length = u4(),
        end = at + length;
      if (name === 'Signature') result[name] = utf(u2());
      else if (name === 'Exceptions')
        result[name] = Array.from(
          {
            length: u2(),
          },
          () => cls(u2()),
        );
      else if (name === 'RuntimeVisibleAnnotations' || name === 'RuntimeInvisibleAnnotations')
        result[name] = Array.from(
          {
            length: u2(),
          },
          annotation,
        );
      else if (name === 'RuntimeVisibleParameterAnnotations' || name === 'RuntimeInvisibleParameterAnnotations')
        result[name] = Array.from(
          {
            length: u1(),
          },
          () =>
            Array.from(
              {
                length: u2(),
              },
              annotation,
            ),
        );
      else if (name === 'MethodParameters')
        result[name] = Array.from(
          {
            length: u1(),
          },
          () => {
            const i = u2();
            return [i ? utf(i) : '', u2()];
          },
        );
      else if (name === 'AnnotationDefault') result[name] = value();
      else if (requireJava8 && OverlayString.includes('TypeAnnotations')(name))
        throw new Error('Type annotation ABI requires an explicit checker before construction.');
      else if (name === 'InnerClasses')
        result[name] = Array.from(
          {
            length: u2(),
          },
          () => {
            const inner = cls(u2()),
              outer = cls(u2()),
              i = u2();
            return [inner, outer, i ? utf(i) : '', u2()];
          },
        );
      else if (name === 'EnclosingMethod') {
        const owner = cls(u2()),
          i = u2();
        const pair = i ? pool[i] : undefined;
        requireThat(!i || OverlayArray.isArray(pair), 'Invalid enclosing method.');
        result[name] = [owner, OverlayArray.isArray(pair) ? [utf(Number(pair[0])), utf(Number(pair[1]))] : ''];
      }
      at = end;
    }
    return result;
  };
  const access = u2(),
    name = cls(u2()),
    parent = cls(u2()),
    interfaces = Array.from(
      {
        length: u2(),
      },
      () => cls(u2()),
    );
  const members = (): Member[] =>
    Array.from(
      {
        length: u2(),
      },
      () => ({
        access: u2(),
        name: utf(u2()),
        descriptor: utf(u2()),
        attributes: attrs(),
      }),
    );
  const fields = members(),
    methods = members(),
    attributes = attrs();
  const references = OverlayArray.flatMap(tags, (tag, i) => {
    if (!OverlayArray.contains([9, 10, 11], tag)) return [];
    const pair = pool[i];
    requireThat(OverlayArray.isArray(pair), 'Invalid member reference.');
    const tuple = pool[Number(pair[1])];
    requireThat(OverlayArray.isArray(tuple), 'Invalid name/type.');
    return [
      {
        owner: cls(Number(pair[0])),
        name: utf(Number(tuple[0])),
        descriptor: utf(Number(tuple[1])),
        field: tag === 9,
      },
    ];
  });
  return {
    access,
    name,
    parent,
    interfaces,
    fields,
    methods,
    attributes,
    references,
  };
}
function preserveAbi(original: ClassInfo, changed: ClassInfo): void {
  requireThat(
    original.name === changed.name &&
      original.access === changed.access &&
      original.parent === changed.parent &&
      canonical(original.interfaces) === canonical(changed.interfaces),
    'Class hierarchy/access ABI changed: ' + original.name,
  );
  for (const kind of ['fields', 'methods'] as const)
    for (const member of original[kind]) {
      if (member.access & 2) continue;
      const actual = OverlayOption.getOrUndefined(
        OverlayArray.findFirst(
          changed[kind],
          item => item.name === member.name && item.descriptor === member.descriptor,
        ),
      );
      requireThat(
        actual && canonical(actual) === canonical(member),
        'Nonprivate member ABI changed: ' + original.name + '.' + member.name,
      );
    }
  for (const [key, value] of OverlayRecord.toEntries(original.attributes)) {
    if (key === 'InnerClasses') {
      requireThat(
        OverlayArray.isArray(value) && OverlayArray.isArray(changed.attributes[key]),
        'Missing inner metadata.',
      );
      for (const entry of value)
        requireThat(
          OverlayArray.some(changed.attributes[key], item => canonical(item) === canonical(entry)),
          'Inner class ABI changed.',
        );
    } else
      requireThat(
        canonical(changed.attributes[key]) === canonical(value),
        'Class reflection ABI changed: ' + original.name + ':' + key,
      );
  }
}
export function overlayInventory(root: string): {
  path: string;
  bytes: number;
  mode: string;
  sha256: string;
}[] {
  const entries: {
    path: string;
    bytes: number;
    mode: string;
    sha256: string;
  }[] = [];
  const visit = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name),
        info = lstatSync(path);
      requireThat(!info.isSymbolicLink(), 'Symlink input/output requires a separate pin policy.');
      if (info.isDirectory()) visit(path);
      else {
        requireThat(info.isFile(), 'Nonregular build input.');
        const bytes = readFileSync(path);
        entries.push({
          path: OverlayArray.join(OverlayString.split(relative(root, path), '\\'), '/'),
          bytes: bytes.length,
          mode: '0o' + (info.mode & 0o777).toString(8),
          sha256: overlayHash(bytes),
        });
      }
    }
  };
  visit(root);
  return entries.sort((a, b) => {
    const aa = OverlayString.split(a.path, '/'),
      bb = OverlayString.split(b.path, '/');
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
      if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
    }
    return aa.length - bb.length;
  });
}
function directories(root: string): {path: string; mode: number}[] {
  const result: {path: string; mode: number}[] = [];
  const visit = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name),
        info = lstatSync(path);
      requireThat(!info.isSymbolicLink(), 'Symlink directory refused.');
      if (info.isDirectory()) {
        result.push({path: relative(root, path), mode: info.mode & 0o777});
        visit(path);
      }
    }
  };
  visit(root);
  return result;
}
/** Same file/directory image contract as semanticSdkDigest; modes are pinned separately above. */
function sdkDigest(root: string): string {
  const entries: [string, string][] = [
    ...OverlayArray.map(overlayInventory(root), file => [file.path, file.sha256] as [string, string]),
    ...OverlayArray.map(directories(root), directory => [directory.path, 'directory'] as [string, string]),
  ];
  return overlayHash(JSON.stringify(entries.sort(([a], [b]) => OverlayString.localeCompare(b)(a))));
}
export interface OverlayBuildOptions {
  base: string;
  baseArchive: string;
  compiler: string;
  compilerArchive: string;
  sources: string;
  output: string;
}
/** Offline construction only. This does not activate Gradle, JDT, a model, or a native owner. */
export async function buildGradleOverlay(options: OverlayBuildOptions): Promise<unknown> {
  requireThat(Bun.version === '1.4.4', 'Pinned Bun1.4.4 construction runtime required.');
  const rootManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  requireThat(
    rootManifest.devDependencies?.fflate === '0.8.3' || rootManifest.dependencies?.fflate === '0.8.3',
    'Pinned fflate0.8.3 required.',
  );
  const paths = OverlayRecord.fromEntries(
    OverlayArray.map(OverlayRecord.toEntries(options), ([key, path]) => [key, resolve(path)]),
  );
  for (const key of ['base', 'compiler', 'sources'])
    requireThat(realpathSync(paths[key]) === paths[key], 'Canonical input roots required.');
  requireThat(!existsSync(paths.output), 'Output must be a fresh independently owned directory.');
  requireThat(
    realpathSync(dirname(paths.output)) === dirname(paths.output),
    'Output parent must be canonical, without an input-overlap symlink.',
  );
  for (const key of ['base', 'compiler', 'sources'])
    requireThat(
      !OverlayString.startsWith(paths[key] + '/')(paths.output) &&
        !OverlayString.startsWith(paths.output + '/')(paths[key]),
      'Input/output overlap refused.',
    );
  requireThat(
    overlayHash(readFileSync(paths.baseArchive)) === gradleOverlayPins.gradleArchive &&
      overlayHash(readFileSync(paths.compilerArchive)) === gradleOverlayPins.compilerArchive,
    'Official archive pin mismatch.',
  );
  const base = overlayInventory(paths.base),
    compiler = overlayInventory(paths.compiler);
  requireThat(
    overlayHash(canonical(base)) === gradleOverlayPins.gradleTree &&
      overlayHash(canonical(compiler)) === gradleOverlayPins.compilerTree,
    'Complete SDK/compiler file/mode pin mismatch.',
  );
  requireThat(
    sdkDigest(paths.base) === gradleOverlayPins.gradleSdkDigest,
    'Existing complete Gradle semantic SDK pin mismatch.',
  );
  const originals = unzipSync(readFileSync(paths.baseArchive));
  for (const file of base)
    requireThat(overlayHash(originals['gradle-9.8.2/' + file.path]) === file.sha256, 'Base archive/tree mismatch.');
  const pinnedSources = new Map<string, Uint8Array>();
  for (const [path, digest] of sourcePins) {
    const bytes = readFileSync(join(paths.sources, path));
    requireThat(overlayHash(bytes) === digest, 'Original source pin mismatch.');
    pinnedSources.set(path, bytes);
  }
  const patchPath = new URL('./gradle-owned-import.patch', import.meta.url),
    patch = readFileSync(patchPath);
  requireThat(overlayHash(patch) === gradleOverlayPins.patch, 'Reviewed source patch pin mismatch.');
  // No writes or compiler execution occur before all original/compiler/source/patch pins pass.
  mkdirSync(paths.output, {recursive: false});
  const sources = join(paths.output, 'sources');
  mkdirSync(sources);
  for (const [path, bytes] of pinnedSources) {
    const target = join(sources, path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, bytes);
  }
  const execute = async (name: string, command: string[]) => {
    const started = performance.now();
    const process = Bun.spawn(command, {
      timeout: 120_000,
      cwd: sources,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: paths.output,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    writeFileSync(
      join(paths.output, name + '.json'),
      JSON.stringify(
        {
          command,
          exitCode,
          elapsedMs: Math.round(performance.now() - started),
          stdout,
          stderr,
        },
        null,
        2,
      ),
    );
    requireThat(exitCode === 0, name + ' failed; preserved numeric receipt in owned output.');
  };
  await execute('patch-check', ['/usr/bin/git', 'apply', '--check', patchPath.pathname]);
  // Exact source pins and a zero-context-free patch check precede every compiler invocation.
  await execute('patch', ['/usr/bin/git', 'apply', patchPath.pathname]);
  const javaFiles: string[] = [];
  const collect = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const p = join(folder, name);
      if (lstatSync(p).isDirectory()) collect(p);
      else if (OverlayString.endsWith('.java')(p)) javaFiles.push(p);
    }
  };
  collect(sources);
  requireThat(javaFiles.length === 5, 'Expected exact four upstream sources plus one cohesive helper.');
  const expectedSources = new Set([
    ...OverlayArray.map(sourcePins, ([path]) => path),
    'platforms/core-runtime/client-services/src/main/java/org/gradle/launcher/daemon/client/OwnedBuildControl.java',
  ]);
  requireThat(
    OverlayArray.every(overlayInventory(sources), file => expectedSources.has(file.path)) &&
      expectedSources.size === javaFiles.length,
    'Patch wrote an unowned upstream path.',
  );
  const jars = OverlayArray.filter(
    base,
    file =>
      OverlayString.endsWith('.jar')(file.path) &&
      OverlayString.startsWith('lib/')(file.path) &&
      !OverlayString.startsWith('lib/api/')(file.path),
  );
  requireThat(
    jars.length === 347,
    'Bundled implementation classpath inventory changed (API stubs must stay excluded).',
  );
  const empty = join(paths.output, 'empty-sourcepath');
  mkdirSync(empty);
  const classes = join(paths.output, 'classes');
  await execute('javac', [
    join(paths.compiler, 'bin/javac'),
    '-proc:none',
    '--release',
    '8',
    '-parameters',
    '-g:none',
    '-encoding',
    'UTF-8',
    '-classpath',
    OverlayArray.join(
      OverlayArray.map(jars, file => join(paths.base, file.path)),
      ':',
    ),
    '-sourcepath',
    empty,
    '-d',
    classes,
    ...javaFiles,
  ]);
  const compiled = new Map(
    OverlayArray.map(overlayInventory(classes), file => [
      file.path,
      new Uint8Array(readFileSync(join(classes, file.path))),
    ]),
  );
  const infos = new Map(
    OverlayArray.map([...compiled], ([name, bytes]) => [OverlayString.slice(0, -6)(name), classInfo(bytes)]),
  );
  for (const name of compiled.keys())
    requireThat(
      OverlayArray.some(OverlayRecord.keys(familyJars), parent => family(name, parent)),
      'Unexpected emitted class family.',
    );
  const abi: string[] = [];
  let inboundLinks = 0;
  const oldInfos = new Map<string, ClassInfo>();
  const callers: ClassInfo[] = [];
  const bundledInfos = new Map<string, ClassInfo>();
  for (const jar of jars) {
    const entries = unzipSync(readFileSync(join(paths.base, jar.path)));
    for (const [name, bytes] of OverlayRecord.toEntries(entries)) {
      if (
        !OverlayString.endsWith('.class')(name) ||
        name === 'module-info.class' ||
        OverlayString.endsWith('/module-info.class')(name)
      )
        continue;
      const target = OverlayOption.getOrUndefined(
        OverlayArray.findFirst(OverlayRecord.keys(familyJars), parent => family(name, parent)),
      );
      if (target) {
        requireThat(
          infos.has(OverlayString.slice(0, -6)(name)),
          'Old nested class family disappeared; explicit ABI analysis required.',
        );
        const original = classInfo(bytes);
        oldInfos.set(original.name, original);
        preserveAbi(original, infos.get(OverlayString.slice(0, -6)(name))!);
        abi.push(name);
      }
      // Unchanged callers can target package-private/synthetic family members too.
      if (!target) {
        const info = classInfo(bytes, false);
        callers.push(info);
        if (!bundledInfos.has(info.name)) bundledInfos.set(info.name, info);
      }
    }
  }
  for (const caller of callers)
    for (const ref of caller.references) {
      const original = oldInfos.get(ref.owner);
      if (!original) continue;
      const member = OverlayOption.getOrUndefined(
        OverlayArray.findFirst(
          ref.field ? original.fields : original.methods,
          item => item.name === ref.name && item.descriptor === ref.descriptor,
        ),
      );
      if (member) {
        const replacement = infos.get(ref.owner)!;
        requireThat(
          OverlayArray.some(
            ref.field ? replacement.fields : replacement.methods,
            item => canonical(item) === canonical(member),
          ),
          'Broken unchanged bundled inbound member link.',
        );
      }
      // Inherited members retain the checked original superclass/interface ABI.
      inboundLinks++;
    }
  // A symbolic owner may name a subclass while the member is declared by its
  // unchanged bundled superclass (e.g. DaemonClientServices.getBuildStandardInput).
  const resolveMember = (
    owner: string,
    ref: ClassInfo['references'][number],
    seen = new Set<string>(),
  ): Member | undefined => {
    if (seen.has(owner)) return undefined;
    seen.add(owner);
    const declaration = infos.get(owner) ?? bundledInfos.get(owner);
    if (!declaration) return undefined;
    const direct = OverlayOption.getOrUndefined(
      OverlayArray.findFirst(
        ref.field ? declaration.fields : declaration.methods,
        item => item.name === ref.name && item.descriptor === ref.descriptor,
      ),
    );
    if (direct) return direct;
    if (ref.name === '<init>') return undefined;
    for (const parent of [declaration.parent, ...declaration.interfaces]) {
      const inherited = resolveMember(parent, ref, seen);
      if (inherited && !(inherited.access & 2)) return inherited;
    }
    return undefined;
  };
  for (const info of infos.values())
    for (const ref of info.references)
      if (infos.has(ref.owner)) {
        requireThat(resolveMember(ref.owner, ref), 'Broken replacement member link: ' + ref.owner + '.' + ref.name);
        inboundLinks++;
      }
  const derivative = join(
    paths.output,
    'gradle-9.8.2-threadnote-owned-import-' + OverlayString.slice(0, 16)(overlayHash(patch)),
  );
  mkdirSync(derivative);
  chmodSync(derivative, 0o755);
  const baseDirectories = directories(paths.base);
  for (const directory of baseDirectories) {
    mkdirSync(join(derivative, directory.path), {recursive: true});
    chmodSync(join(derivative, directory.path), directory.mode);
  }
  for (const file of base) {
    const target = join(derivative, file.path);
    mkdirSync(dirname(target), {
      recursive: true,
    });
    copyFileSync(join(paths.base, file.path), target);
    chmodSync(target, parseInt(OverlayString.slice(2)(file.mode), 8));
  }
  for (const jar of new Set(OverlayRecord.values(familyJars))) {
    const families = OverlayArray.map(
      OverlayArray.filter(OverlayRecord.toEntries(familyJars), ([, owner]) => owner === jar),
      ([parent]) => parent,
    );
    const replacements = new Map(
      OverlayArray.filter([...compiled], ([name]) => OverlayArray.some(families, parent => family(name, parent))),
    );
    writeFileSync(join(derivative, jar), rewriteOwnedJar(readFileSync(join(paths.base, jar)), replacements, families));
  }
  const provenance = {
    kind: 'source-overlay-derivative',
    official: false,
    fullSourceBuild: false,
    pins: gradleOverlayPins,
    patchSha256: overlayHash(patch),
    recipeSha256: overlayHash(readFileSync(new URL(import.meta.url))),
    sources: OverlayArray.map(javaFiles, path => ({
      path: relative(sources, path),
      sha256: overlayHash(readFileSync(path)),
    })),
    compilerFlags: ['-proc:none', '--release', '8', '-parameters', '-g:none', '-encoding', 'UTF-8'],
    classpath: jars,
    classes: overlayInventory(classes),
    abiPreservedFamilies: abi.sort(),
    checkedReplacementLinks: inboundLinks,
    notice:
      'Modified Gradle source families. Original LICENSE/NOTICE and build-receipt remain exact BASE provenance, not certification of this derivative. No runtime qualification or license approval is claimed.',
  };
  writeFileSync(join(derivative, 'THREADNOTE-SOURCE-OVERLAY.json'), canonical(provenance) + '\n');
  chmodSync(join(derivative, 'THREADNOTE-SOURCE-OVERLAY.json'), 0o644);
  writeFileSync(join(derivative, 'THREADNOTE-CHANGES.patch'), patch);
  chmodSync(join(derivative, 'THREADNOTE-CHANGES.patch'), 0o644);
  const final = overlayInventory(derivative);
  const archiveEntries = new Map(
    OverlayArray.map(final, file => [file.path, new Uint8Array(readFileSync(join(derivative, file.path)))]),
  );
  const archiveModes = new Map(
    OverlayArray.map(final, file => [file.path, 0o100000 | parseInt(OverlayString.slice(2)(file.mode), 8)]),
  );
  for (const directory of baseDirectories) {
    archiveEntries.set(directory.path + '/', new Uint8Array());
    archiveModes.set(directory.path + '/', 0o40000 | directory.mode);
  }
  const archive = deterministicZip(archiveEntries, archiveModes);
  const archiveName = 'gradle-9.8.2-threadnote-owned-import-' + OverlayString.slice(0, 16)(overlayHash(patch)) + '.zip';
  writeFileSync(join(paths.output, archiveName), archive);

  requireThat(
    overlayHash(canonical(overlayInventory(paths.base))) === gradleOverlayPins.gradleTree &&
      overlayHash(canonical(overlayInventory(paths.compiler))) === gradleOverlayPins.compilerTree,
    'Original input changed during construction.',
  );
  const result = {
    kind: 'source-overlay-derivative',
    archiveName,
    semanticSdkDigest: sdkDigest(derivative),
    treeSha256: overlayHash(canonical(final)),
    archiveSha256: overlayHash(archive),
    files: final,
    provenance,
  };
  writeFileSync(join(paths.output, 'result.json'), canonical(result) + '\n');
  return result;
}
if (import.meta.main) {
  const args = OverlayArray.drop(process.argv, 2);
  requireThat(
    args.length === 12,
    'Usage: --base DIR --baseArchive ZIP --compiler DIR --compilerArchive TAR --sources DIR --output FRESH_DIR',
  );
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = OverlayString.slice(2)(args[i]);
    requireThat(
      OverlayString.startsWith('--')(args[i]) &&
        OverlayArray.contains(['base', 'baseArchive', 'compiler', 'compilerArchive', 'sources', 'output'], key) &&
        !values[key] &&
        isAbsolute(args[i + 1]),
      'Invalid or duplicate argument.',
    );
    values[key] = args[i + 1];
  }
  await buildGradleOverlay({
    base: values.base,
    baseArchive: values.baseArchive,
    compiler: values.compiler,
    compilerArchive: values.compilerArchive,
    sources: values.sources,
    output: values.output,
  });
}
