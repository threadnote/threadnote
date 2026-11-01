import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {Digest, Identifier} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {boundedFileDigest, readBounded, semanticSdkDigest, semanticTreeDigest} from '../fingerprint.js';
import {LspFault} from '../lsp_transport.js';
import {wellFormed} from '../provider.js';
import {makeJavaWorkspace} from './java_runtime.js';
import {JavaCompilerOptions, JavaProjectionImage, javaProjectionDigest, javaFileUri} from './java_snapshot.js';
import {
  JavaPreparedModel,
  javaPreparedEntryJson,
  javaPreparedModelJson,
  loadJavaPreparedModel,
} from './java_preparation.js';

export const JavaEnvironment = Schema.Struct({id: Identifier, metadataFile: Schema.String, metadataDigest: Digest});
export type JavaEnvironment = typeof JavaEnvironment.Type;

/** Host-pinned output of explicit build preparation; attachment never runs a build or imports repository metadata. */
export const JavaProjectModel = Schema.Struct({
  format: Schema.Literal('threadnote-prepared-java-project-v1'),
  build: Schema.Literals(['maven', 'gradle']),
  importer: Schema.Literals(['org.eclipse.m2e.core.maven2Nature', 'org.eclipse.buildship.core.gradleprojectnature']),
  provider: Schema.Literal('jdtls-1.63.0-202610191322'),
  worktree: Schema.String,
  project: Schema.String,
  sourceDigest: Digest,
  javaHome: Schema.String,
  javaSdkDigest: Digest,
  release: Schema.Literal(21),
  sourceRoots: Schema.Array(Schema.Struct({directory: Schema.String, required: Schema.Boolean})).check(
    Schema.isBetweenLength(1, 32),
  ),
  libraries: Schema.Array(Schema.Struct({file: Schema.String, digest: Digest})).check(Schema.isMaxLength(128)),
});
export type JavaProjectModel = typeof JavaProjectModel.Type;

const fail = () => LspFault.make({code: 'prerequisite'});
const inside = (root: string, file: string, separator: string) =>
  root === file || EffectString.startsWith(root + separator)(file);
const xml = (value: string) =>
  EffectString.replaceAll(
    "'",
    '&apos;',
  )(
    EffectString.replaceAll(
      '"',
      '&quot;',
    )(
      EffectString.replaceAll(
        '>',
        '&gt;',
      )(EffectString.replaceAll('<', '&lt;')(EffectString.replaceAll('&', '&amp;')(value))),
    ),
  );

/** ASCII Java Properties preserve validated compiler strings independently of the preference reader's charset. */
export function javaCompilerPreferences(options: Readonly<Record<string, string>>) {
  const property = (value: string) => {
    let encoded = '';
    // Properties Unicode escapes represent UTF-16 units, including both halves of supplementary characters.
    for (let index = 0; index < value.length; index++) {
      const unit = Option.getOrThrow(EffectString.charCodeAt(index)(value));
      const character = value[index];
      if (unit < 0x20 || unit > 0x7e) encoded += '\\u' + EffectString.padStart(4, '0')(unit.toString(16));
      else encoded += /[\\ =:#!]/u.test(character) ? '\\' + character : character;
    }
    return encoded;
  };
  const entries = EffectRecord.toEntries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    'eclipse.preferences.version=1\n' +
    EffectArray.join(
      EffectArray.map(entries, ([key, value]) => property(key) + '=' + property(value) + '\n'),
      '',
    )
  );
}

/** Deterministic Eclipse serialization preserves the prepared classpath order. */
export function javaProjectMetadata(sourceUris: readonly string[], libraries: readonly string[]) {
  const links: string[] = [];
  const classpath: string[] = [];
  for (const [index, root] of sourceUris.entries()) {
    const name = `source-${index}`;
    links.push(`<link><name>${name}</name><type>2</type><locationURI>${xml(root)}</locationURI></link>`);
    classpath.push(`<classpathentry kind="src" path="${name}"/>`);
  }
  for (const library of libraries) classpath.push(`<classpathentry kind="lib" path="${xml(library)}"/>`);
  classpath.push(
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21"/>',
  );
  classpath.push('<classpathentry kind="output" path="bin"/>');
  return {
    '.project': `<projectDescription><name>threadnote-java</name><comment/><projects/><buildSpec/><natures><nature>org.eclipse.jdt.core.javanature</nature></natures><linkedResources>${EffectArray.join(links, '')}</linkedResources></projectDescription>`,
    '.classpath': `<classpath>${EffectArray.join(classpath, '')}</classpath>`,
    '.settings/org.eclipse.jdt.core.prefs': javaCompilerPreferences({
      'org.eclipse.jdt.core.compiler.compliance': '21',
      'org.eclipse.jdt.core.compiler.source': '21',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
      'org.eclipse.jdt.core.compiler.release': 'enabled',
      'org.eclipse.jdt.core.compiler.processAnnotations': 'disabled',
    }),
  };
}

/** Serialize an already transformed passive image. Filesystem ownership and reconstructed metadata need separate proofs. */
export function javaProjectionMetadata(
  image: typeof JavaProjectionImage.Type,
  compilerOptions: Readonly<Record<string, string>>,
  documentationUri?: string,
) {
  let fixed: typeof JavaProjectionImage.Type;
  let compiler: typeof JavaCompilerOptions.Type;
  try {
    fixed = Schema.decodeSync(JavaProjectionImage, {onExcessProperty: 'error'})(image);
    compiler = Schema.decodeSync(JavaCompilerOptions, {onExcessProperty: 'error'})(compilerOptions);
    javaProjectionDigest(fixed);
  } catch {
    throw fail();
  }
  if (compiler['org.eclipse.jdt.core.compiler.processAnnotations'] !== 'disabled') throw fail();
  const localUri = (value: string) => {
    // URL getters merge absent and empty components; the native URI contract requires both absent.
    if (/[?#]/u.test(value)) throw fail();
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.host || url.href !== value) throw fail();
      if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]*$/u.test(url.pathname)) throw fail();
      const decodedPath = decodeURIComponent(url.pathname);
      if (!wellFormed(decodedPath) || /[\p{Cc}\uFFFE\uFFFF]/u.test(decodedPath)) throw fail();
    } catch {
      throw fail();
    }
  };
  if (documentationUri !== undefined) localUri(documentationUri);
  const alias = (value: string, kind: 'source' | 'output') => {
    const match = EffectString.match(new RegExp('^/threadnote-java/' + kind + '-(0|[1-9][0-9]?)$', 'u'))(value);
    if (Option.isNone(match) || Number(match.value[1]) > (kind === 'source' ? 31 : 32)) throw fail();
    return EffectString.slice('/threadnote-java/'.length)(value);
  };
  const portable = (value: string, absolute: boolean) => {
    if (
      !value ||
      /[:\\]/u.test(value) ||
      EffectString.includes('//')(value) ||
      EffectArray.some(EffectString.split('/')(value), part => part === '.' || part === '..') ||
      (absolute && (!EffectString.startsWith('/')(value) || EffectString.endsWith('/')(value)))
    )
      throw fail();
    return value;
  };
  const patterns = (values: readonly string[]) => {
    for (const value of values) {
      portable(value, false);
      if (EffectString.includes('|')(value)) throw fail();
    }
    return EffectArray.join(values, '|');
  };
  const sources = new Set<string>();
  const paths = new Set<string>();
  let containers = 0;
  const entries = EffectArray.map(fixed.rawClasspath, entry => {
    if (paths.has(entry.path)) throw fail();
    paths.add(entry.path);
    let kind: string;
    let entryPath: string;
    if (entry.kind === 3) {
      if (
        entry.contentKind !== 1 ||
        entry.combineAccessRules ||
        entry.exported ||
        entry.accessRules.length ||
        entry.sourceAttachmentPath !== undefined ||
        entry.sourceAttachmentRoot !== undefined
      )
        throw fail();
      kind = 'src';
      entryPath = alias(entry.path, 'source');
      sources.add(entryPath);
    } else {
      if (entry.inclusions.length || entry.exclusions.length || entry.outputPath !== undefined) throw fail();
      if (entry.kind === 5) {
        if (
          entry.path !==
            'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21' ||
          entry.contentKind !== 1 ||
          !entry.combineAccessRules ||
          entry.sourceAttachmentPath !== undefined ||
          entry.sourceAttachmentRoot !== undefined
        )
          throw fail();
        containers++;
        kind = 'con';
        entryPath = entry.path;
      } else {
        if (entry.contentKind !== 2 || entry.combineAccessRules) throw fail();
        kind = 'lib';
        entryPath = portable(entry.path, true);
        if (EffectString.startsWith('/threadnote-java/')(entryPath)) throw fail();
      }
    }
    let attributes = ` kind="${kind}" path="${xml(entryPath)}"`;
    if (entry.exported) attributes += ' exported="true"';
    if (entry.outputPath !== undefined) attributes += ` output="${alias(entry.outputPath, 'output')}"`;
    if (entry.sourceAttachmentPath !== undefined)
      attributes += ` sourcepath="${xml(portable(entry.sourceAttachmentPath, true))}"`;
    if (entry.sourceAttachmentRoot !== undefined) {
      if (entry.sourceAttachmentPath === undefined) throw fail();
      if (entry.sourceAttachmentRoot) portable(entry.sourceAttachmentRoot, false);
      attributes += ` rootpath="${xml(entry.sourceAttachmentRoot)}"`;
    }
    if (entry.inclusions.length) attributes += ` including="${xml(patterns(entry.inclusions))}"`;
    if (entry.exclusions.length) attributes += ` excluding="${xml(patterns(entry.exclusions))}"`;
    const names = new Set<string>();
    const extras = EffectArray.map(entry.attributes, attribute => {
      if (!attribute.name || names.has(attribute.name)) throw fail();
      names.add(attribute.name);
      let value: string;
      if (attribute.name === 'javadoc_location') {
        if (
          !('valueSha256' in attribute) ||
          documentationUri === undefined ||
          sha256HexSync(documentationUri) !== attribute.valueSha256
        )
          throw fail();
        value = documentationUri;
      } else {
        if (!('value' in attribute)) throw fail();
        value = attribute.value;
      }
      return `<attribute name="${xml(attribute.name)}" value="${xml(value)}"/>`;
    });
    const rules = EffectArray.map(entry.accessRules, rule => {
      portable(rule.pattern, false);
      return `<accessrule kind="${['accessible', 'nonaccessible', 'discouraged'][rule.kind]}" pattern="${xml(rule.pattern)}"${rule.ignoreIfBetter ? ' ignoreifbetter="true"' : ''}/>`;
    });
    return `<classpathentry${attributes}><accessrules>${EffectArray.join(rules, '')}</accessrules><attributes>${EffectArray.join(extras, '')}</attributes></classpathentry>`;
  });
  if (containers !== 1 || sources.size !== fixed.links.length) throw fail();
  const linked = new Set<string>();
  const links = EffectArray.map(fixed.links, link => {
    if (!sources.has(link.path) || linked.has(link.path)) throw fail();
    linked.add(link.path);
    localUri(link.uri);
    return `<link><name>${link.path}</name><type>2</type><locationURI>${xml(link.uri)}</locationURI></link>`;
  });
  const filters = EffectArray.map(fixed.resourceFilters, filter => {
    if (!/^[1-9][0-9]{0,18}$/u.test(filter.id) || BigInt(filter.id) > 9223372036854775807n) throw fail();
    return `<filter><id>${filter.id}</id><name></name><type>30</type><matcher><id>${xml(filter.matcherId)}</id><arguments>${xml(filter.arguments)}</arguments></matcher></filter>`;
  });
  const files = {
    '.project': `<projectDescription><name>threadnote-java</name><comment/><projects/><buildSpec/><natures><nature>org.eclipse.jdt.core.javanature</nature></natures><linkedResources>${EffectArray.join(links, '')}</linkedResources><filteredResources>${EffectArray.join(filters, '')}</filteredResources></projectDescription>`,
    '.classpath': `<classpath>${EffectArray.join(entries, '')}<classpathentry kind="output" path="${alias(fixed.outputPath, 'output')}"/></classpath>`,
    '.settings/org.eclipse.jdt.core.prefs': javaCompilerPreferences(compiler),
    '.settings/org.eclipse.core.resources.prefs': 'eclipse.preferences.version=1\nencoding/<project>=UTF-8\n',
  };
  if (EffectRecord.reduce(files, 0, (bytes, value) => bytes + new TextEncoder().encode(value).length) > 2 * 1024 * 1024)
    throw fail();
  return files;
}

/** Pure A0 translation of sealed facts. URI bindings and documentation ownership require filesystem verification by the consumer. */
export function javaPreparedProjection(
  model: JavaPreparedModel,
  sourceUris: readonly {readonly path: string; readonly uri: string}[],
  documentationUri: string,
) {
  let fixed: JavaPreparedModel;
  try {
    fixed = Schema.decodeSync(JavaPreparedModel, {onExcessProperty: 'error'})(model);
  } catch {
    throw fail();
  }
  if (new TextEncoder().encode(javaPreparedModelJson(fixed)).length > 256 * 1024) throw fail();
  // Java URL treats four leading slashes as UNC spelling rather than a local URI prefix.
  if (EffectString.startsWith('file:////')(documentationUri)) throw fail();
  const relative = (value: string) => {
    if (
      !value ||
      /[:\\]/u.test(value) ||
      EffectArray.some(
        EffectString.split('/')(value),
        part => !part || part === '.' || part === '..' || part === '.git',
      )
    )
      throw fail();
    return value;
  };
  const absolute = (value: string) => {
    if (!EffectString.startsWith('/')(value)) throw fail();
    relative(EffectString.slice(1)(value));
    return value;
  };
  absolute(fixed.project);
  absolute(fixed.javaHome);
  const overlaps = (a: string, b: string) => inside(a, b, '/') || inside(b, a, '/');
  const sources = EffectArray.filter(fixed.rawClasspath, entry => entry.kind === 3);
  if (!sources.length || sources.length > 32 || sources.length !== sourceUris.length) throw fail();
  const outputs = [relative(fixed.output)];
  const aliases = new Map<string, string>();
  const links = EffectArray.map(sources, (entry, index) => {
    relative(entry.path);
    if (
      entry.exists === undefined ||
      (!entry.exists &&
        !EffectArray.some(
          entry.attributes,
          attr => attr.name === 'optional' && 'value' in attr && attr.value === 'true',
        )) ||
      EffectArray.some(EffectString.split('/')(entry.path), part =>
        ['node_modules', '__CREATED_BY_JAVA_LANGUAGE_SERVER__'].includes(part),
      ) ||
      EffectArray.some(Array.from(aliases.keys()), name => overlaps(name, entry.path))
    )
      throw fail();
    const binding = sourceUris[index];
    if (binding.path !== entry.path) throw fail();
    try {
      const physical = decodeURIComponent(new URL(binding.uri).pathname);
      const expected = fixed.project + '/' + entry.path;
      if (physical !== expected && physical !== expected + '/') throw fail();
    } catch {
      throw fail();
    }
    const name = 'source-' + index;
    aliases.set(entry.path, '/threadnote-java/' + name);
    if (entry.output !== undefined && !outputs.includes(relative(entry.output))) outputs.push(entry.output);
    return {path: name, uri: binding.uri, type: 2 as const};
  });
  if (!EffectArray.some(sources, entry => entry.exists === true)) throw fail();
  for (const [index, output] of outputs.entries())
    if (
      EffectArray.some(sources, source => overlaps(source.path, output)) ||
      EffectArray.some(outputs.slice(0, index), previous => overlaps(previous, output))
    )
      throw fail();
  const libraries = new Set<string>();
  for (const library of fixed.libraries) {
    absolute(library.file);
    if (inside(fixed.javaHome, library.file, '/') || libraries.has(library.file)) throw fail();
    libraries.add(library.file);
  }
  const transformed = (entry: JavaPreparedModel['rawClasspath'][number], flatten = false) => {
    const {exists: _exists, output, ...rest} = entry;
    // JRE documentation attributes use Java URL.toExternalForm; raw .classpath attributes retain URI text.
    const documentationValue =
      entry.path === fixed.javaHome + '/lib/jrt-fs.jar'
        ? EffectString.replace(/^file:\/\/\//u, 'file:/')(documentationUri)
        : documentationUri;
    if (entry.sourceAttachmentPath !== undefined) {
      absolute(entry.sourceAttachmentPath);
      if (!inside(fixed.javaHome, entry.sourceAttachmentPath, '/')) throw fail();
    }
    const names = new Set<string>();
    const attributes: JavaPreparedModel['rawClasspath'][number]['attributes'][number][] = [];
    for (const attr of entry.attributes) {
      if (attr.name === 'javadoc_location' && !('valueSha256' in attr)) throw fail();
      if (names.has(attr.name)) {
        if (
          flatten &&
          attr.name === 'maven.pomderived' &&
          'value' in attr &&
          attr.value === 'true' &&
          EffectArray.some(
            attributes,
            previous => previous.name === attr.name && 'value' in previous && previous.value === 'true',
          )
        )
          continue;
        throw fail();
      }
      names.add(attr.name);
      attributes.push(
        attr.name === 'javadoc_location'
          ? {
              name: 'javadoc_location' as const,
              valueSha256: sha256HexSync(documentationValue),
              access: 'disabled' as const,
            }
          : attr,
      );
    }
    if (entry.kind !== 3 && (entry.exists !== undefined || output !== undefined)) throw fail();
    return {
      ...rest,
      path: entry.kind === 3 ? (aliases.get(entry.path) ?? '') : entry.path,
      ...(output === undefined ? {} : {outputPath: '/threadnote-java/output-' + outputs.indexOf(output)}),
      attributes,
    };
  };
  const jre =
    'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21';
  const importer =
    fixed.build === 'maven'
      ? 'org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER'
      : 'org.eclipse.buildship.core.gradleclasspathcontainer';
  const raw: (typeof JavaProjectionImage.Type)['rawClasspath'][number][] = [];
  const resolved: (typeof JavaProjectionImage.Type)['resolvedClasspath'][number][] = [];
  const rawPaths = new Set<string>();
  const resolvedPaths = new Set<string>();
  const explicit = new Set(
    EffectArray.map(
      EffectArray.filter(fixed.rawClasspath, entry => entry.kind === 1),
      entry => entry.path,
    ),
  );
  let cursor = 0;
  let jres = 0;
  let importers = 0;
  const take = () => {
    const entry = fixed.resolvedClasspath[cursor++];
    if (!entry || resolvedPaths.has(entry.path)) throw fail();
    resolvedPaths.add(entry.path);
    return entry;
  };
  const binary = (entry: JavaPreparedModel['rawClasspath'][number], flatten = true) => {
    if (entry.kind !== 1 || !libraries.delete(entry.path)) throw fail();
    const projected = transformed(entry, flatten);
    raw.push(projected);
    resolved.push(projected);
  };
  for (const entry of fixed.rawClasspath) {
    if (rawPaths.has(entry.path)) throw fail();
    rawPaths.add(entry.path);
    if (entry.kind !== 5) {
      if (javaPreparedEntryJson(entry) !== javaPreparedEntryJson(take())) throw fail();
      if (entry.kind === 1) binary(entry, false);
      else {
        const projected = transformed(entry);
        raw.push(projected);
        resolved.push(projected);
      }
      continue;
    }
    if (entry.path === jre) {
      if (++jres !== 1 || entry.exported || entry.accessRules.length) throw fail();
      raw.push(transformed(entry));
      const sdk = take();
      const {sourceAttachmentPath, attributes, ...sdkFacts} = sdk;
      const expected = {
        ...entry,
        kind: 1 as const,
        contentKind: 2 as const,
        combineAccessRules: false,
        path: fixed.javaHome + '/lib/jrt-fs.jar',
      };
      if (
        sourceAttachmentPath !== fixed.javaHome + '/lib/src.zip' ||
        javaPreparedEntryJson({
          ...sdkFacts,
          attributes: EffectArray.filter(attributes, attr => attr.name !== 'javadoc_location'),
        }) !== javaPreparedEntryJson(expected)
      )
        throw fail();
      resolved.push(transformed(sdk));
    } else if (entry.path === importer) {
      if (
        ++importers !== 1 ||
        entry.contentKind !== 1 ||
        !entry.combineAccessRules ||
        entry.exported ||
        entry.inclusions.length ||
        entry.exclusions.length ||
        entry.accessRules.length ||
        entry.sourceAttachmentPath !== undefined ||
        entry.sourceAttachmentRoot !== undefined
      )
        throw fail();
      transformed(entry);
      while (cursor < fixed.resolvedClasspath.length) {
        const next = fixed.resolvedClasspath[cursor];
        if (next.kind !== 1 || explicit.has(next.path) || inside(fixed.javaHome, next.path, '/')) break;
        if (
          !EffectArray.every(entry.attributes, inherited =>
            EffectArray.some(
              next.attributes,
              attr =>
                inherited.name === attr.name &&
                ('value' in inherited
                  ? 'value' in attr && attr.value === inherited.value
                  : 'valueSha256' in attr && attr.valueSha256 === inherited.valueSha256),
            ),
          )
        )
          throw fail();
        binary(take());
      }
    } else throw fail();
  }
  if (jres !== 1 || importers !== 1 || cursor !== fixed.resolvedClasspath.length || libraries.size) throw fail();
  const image: typeof JavaProjectionImage.Type = {
    format: 'threadnote-passive-java-projection-v1',
    projectCharset: fixed.projectCharset,
    outputPath: '/threadnote-java/output-0',
    rawClasspath: raw,
    resolvedClasspath: resolved,
    links,
    resourceFilters: fixed.resourceFilters,
  };
  const metadata = javaProjectionMetadata(image, fixed.compilerOptions, documentationUri);
  return {image, metadata, digest: javaProjectionDigest(image)};
}

/** Logical membership in verified prepared facts; callers must separately verify physical identity and source characters. */
export function javaPreparedSourceMember(model: JavaPreparedModel, file: string) {
  let remaining = 1_000_000;
  const step = () => {
    if (--remaining < 0) throw LspFault.make({code: 'capacity'});
  };
  const segment = (pattern: string, name: string) => {
    let previous = EffectArray.replicate(false, name.length + 1);
    previous[0] = true;
    // Java's case-sensitive char[] matcher treats '?' as one UTF-16 unit.
    for (let p = 0; p < pattern.length; p++) {
      const next = EffectArray.replicate(false, name.length + 1);
      for (let n = 0; n <= name.length; n++) {
        step();
        if (pattern[p] === '*') next[n] = previous[n] || (n > 0 && next[n - 1]);
        else if (n > 0) next[n] = previous[n - 1] && (pattern[p] === '?' || pattern[p] === name[n - 1]);
      }
      previous = next;
    }
    return previous[name.length];
  };
  // Compatibility target: Eclipse JDT CharOperation.pathMatch, source commit5a4dd839342e057849b378ec912c47035db65dbb.
  const pathMatch = (pattern: string, target: string) => {
    const trailing = EffectString.endsWith('/')(pattern);
    const pieces = EffectString.split('/')(pattern);
    const patterns = trailing ? EffectArray.take(pieces, pieces.length - 1) : pieces;
    const names = EffectString.split('/')(target);
    let p = 0,
      n = 0;
    while (p < patterns.length && patterns[p] !== '**') {
      step();
      if (n >= names.length || !segment(patterns[p], names[n])) return false;
      p++;
      n++;
    }
    if (p === patterns.length) return trailing || n === names.length;
    let restartPattern = ++p,
      restartName = n;
    while (n < names.length) {
      step();
      if (p >= patterns.length) {
        if (trailing) return true;
        p = restartPattern;
        n = ++restartName;
      } else if (patterns[p] === '**') {
        restartPattern = ++p;
        restartName = n;
        if (p === patterns.length) return true;
      } else if (segment(patterns[p], names[n])) {
        p++;
        n++;
      } else {
        p = restartPattern;
        n = ++restartName;
      }
    }
    // Preserve pinned JDT's terminal recursive-segment behavior, including a trailing separator.
    return (
      p >= patterns.length ||
      restartPattern >= patterns.length ||
      (!trailing && p === patterns.length - 1 && patterns[p] === '**')
    );
  };
  const pathText = (value: string) =>
    value.length > 0 && value.length <= 8192 && wellFormed(value) && !/[\p{Cc}\uFFFE\uFFFF]/u.test(value);
  if (
    !pathText(file) ||
    !pathText(model.project) ||
    model.project === '/' ||
    !EffectString.startsWith('/')(model.project) ||
    EffectString.endsWith('/')(model.project)
  )
    throw fail();
  if (!EffectString.startsWith(model.project + '/')(file)) return false;
  const relative = EffectString.slice(model.project.length + 1)(file);
  const parts = EffectString.split('/')(relative);
  if (EffectArray.some(parts, part => !part || part === '.' || part === '..')) throw fail();
  if (model.rawClasspath.length > 162 || model.resourceFilters.length > 1) throw fail();
  for (const filter of model.resourceFilters) {
    if (
      filter.path !== '' ||
      filter.type !== 30 ||
      filter.matcherId !== 'org.eclipse.core.resources.regexFilterMatcher' ||
      filter.arguments !== 'node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__'
    )
      throw fail();
    if (
      EffectArray.some(parts, (part: string) =>
        ['node_modules', '.git', '__CREATED_BY_JAVA_LANGUAGE_SERVER__'].includes(part),
      )
    )
      return false;
  }
  const roots = EffectArray.filter(model.rawClasspath, entry => entry.kind === 3);
  if (roots.length > 32) throw fail();
  const matches = EffectArray.filter(
    EffectArray.map(roots, (entry, index) => ({entry, index})),
    ({entry}) => entry.exists === true && EffectString.startsWith(entry.path + '/')(relative),
  );
  if (matches.length > 1) throw fail();
  if (!matches.length) return false;
  const {entry, index} = matches[0];
  const root = '/threadnote-java/source-' + index;
  const target = root + '/' + EffectString.slice(entry.path.length + 1)(relative);
  const fullPattern = (pattern: string) => {
    if (
      !pathText(pattern) ||
      /[:\\|]/u.test(pattern) ||
      EffectString.includes('//')(pattern) ||
      EffectArray.some(EffectString.split('/')(pattern), part => part === '.' || part === '..')
    )
      throw fail();
    // Eclipse IPath.append ignores a leading separator; a lone '/' contributes no segments.
    const value = EffectString.startsWith('/')(pattern) ? EffectString.slice(1)(pattern) : pattern;
    return value ? root + '/' + value : root;
  };
  if (entry.inclusions.length > 128 || entry.exclusions.length > 128) throw fail();
  const matchesPattern = (pattern: string) => pathMatch(fullPattern(pattern), target);
  return (
    (!entry.inclusions.length || EffectArray.some(entry.inclusions, matchesPattern)) &&
    !EffectArray.some(entry.exclusions, matchesPattern)
  );
}

/** One prepared Java 21 source project. Unprepared, changed or ambiguous models fail before provider startup. */
export const makeJavaProject = Effect.fn('semantic.makeJavaProject')(function* (options: {
  readonly project: string;
  readonly worktree: string;
  readonly privateDirectory: string;
  readonly javaHome: string;
  readonly environment: JavaEnvironment;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const selected = yield* Schema.decodeEffect(JavaEnvironment, {onExcessProperty: 'error'})(options.environment);
  const staticPath = (value: string) =>
    value.length > 0 &&
    value.length <= 8192 &&
    wellFormed(value) &&
    !/[\p{Cc}\uFFFE\uFFFF]/u.test(value) &&
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    !EffectString.split(path.sep)(value).includes('.git');
  const directory = (value: string) =>
    Effect.gen(function* () {
      if (!staticPath(value) || (yield* fs.realPath(value)) !== value || (yield* fs.stat(value)).type !== 'Directory')
        return yield* fail();
    });
  yield* directory(options.worktree);
  yield* directory(options.project);
  if (
    !inside(options.worktree, options.project, path.sep) ||
    !staticPath(selected.metadataFile) ||
    inside(options.worktree, selected.metadataFile, path.sep) ||
    inside(options.worktree, options.javaHome, path.sep) ||
    !staticPath(options.privateDirectory) ||
    inside(options.worktree, options.privateDirectory, path.sep) ||
    inside(options.privateDirectory, options.worktree, path.sep) ||
    inside(options.javaHome, options.privateDirectory, path.sep) ||
    inside(options.privateDirectory, options.javaHome, path.sep)
  )
    return yield* fail();
  if ((yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile) return yield* fail();
  const metadataBytes = yield* readBounded(selected.metadataFile, 128 * 1024);
  if (sha256HexSync(metadataBytes) !== selected.metadataDigest) return yield* fail();
  const model = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(metadataBytes)) as unknown,
    catch: fail,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(JavaProjectModel, {onExcessProperty: 'error'})));
  if (
    model.project !== options.project ||
    model.worktree !== options.worktree ||
    model.javaHome !== options.javaHome ||
    model.importer !==
      (model.build === 'maven' ? 'org.eclipse.m2e.core.maven2Nature' : 'org.eclipse.buildship.core.gradleprojectnature')
  )
    return yield* fail();
  const roots = EffectArray.map(model.sourceRoots, root => root.directory);
  const libraries = EffectArray.map(model.libraries, library => library.file);
  if (new Set(roots).size !== roots.length || new Set(libraries).size !== libraries.length) return yield* fail();
  for (const [index, root] of roots.entries()) {
    if (!staticPath(root) || !inside(options.worktree, root, path.sep)) return yield* fail();
    if (
      EffectArray.some(roots.slice(index + 1), other => inside(root, other, path.sep) || inside(other, root, path.sep))
    )
      return yield* fail();
  }
  const existing: string[] = [];
  const missing: string[] = [];
  for (const root of model.sourceRoots) {
    if (yield* fs.exists(root.directory)) {
      yield* directory(root.directory);
      existing.push(root.directory);
    } else {
      if (root.required) return yield* fail();
      missing.push(root.directory);
    }
  }
  if (!existing.length) return yield* fail();
  const verify = (projection?: {directory: string; digest: string}) =>
    Effect.gen(function* () {
      yield* directory(options.worktree);
      yield* directory(options.project);
      yield* directory(options.javaHome);
      if (
        (yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile ||
        (yield* boundedFileDigest(selected.metadataFile, 128 * 1024)) !== selected.metadataDigest ||
        (yield* semanticTreeDigest(options.worktree)) !== model.sourceDigest ||
        (yield* semanticSdkDigest(options.javaHome)) !== model.javaSdkDigest
      )
        return yield* fail();
      for (const root of existing) yield* directory(root);
      for (const root of missing) if (yield* fs.exists(root)) return yield* fail();
      let libraryBytes = 0;
      for (const library of model.libraries) {
        if (!staticPath(library.file) || (yield* fs.realPath(library.file)) !== library.file) return yield* fail();
        const stat = yield* fs.stat(library.file);
        libraryBytes += Number(stat.size);
        if (
          stat.type !== 'File' ||
          libraryBytes > 512 * 1024 * 1024 ||
          (yield* boundedFileDigest(library.file, 64 * 1024 * 1024)) !== library.digest
        )
          return yield* fail();
      }
      if (projection && (yield* semanticTreeDigest(projection.directory)) !== projection.digest) return yield* fail();
    });
  yield* verify();
  let ancestor = options.privateDirectory;
  let depth = 0;
  while (!(yield* fs.exists(ancestor))) {
    if (++depth > 128 || path.dirname(ancestor) === ancestor) return yield* fail();
    ancestor = path.dirname(ancestor);
  }
  yield* directory(ancestor);
  yield* fs.makeDirectory(options.privateDirectory, {recursive: true, mode: 0o700});
  yield* directory(options.privateDirectory);
  if ((yield* fs.stat(options.privateDirectory)).mode & 0o077) return yield* fail();
  const workspace = yield* makeJavaWorkspace(options.privateDirectory);
  const privateRoot = workspace.directory;
  const project = path.join(privateRoot, 'project');
  yield* fs.makeDirectory(project, {mode: 0o700});
  yield* fs.makeDirectory(path.join(project, '.settings'), {mode: 0o700});
  const sourceUris = yield* Effect.forEach(existing, root => path.toFileUrl(root).pipe(Effect.map(url => url.href)));
  const files = javaProjectMetadata(sourceUris, libraries);
  for (const [relative, content] of EffectRecord.toEntries(files)) {
    const file = path.join(project, relative);
    yield* fs.writeFileString(file, content, {flag: 'wx', mode: 0o600});
  }
  const verifyProjection = verify({directory: project, digest: yield* semanticTreeDigest(project)});
  yield* verifyProjection;
  return {
    directory: privateRoot,
    workspace,
    project,
    verify: verifyProjection,
    sourceRoots: existing,
    roots: [options.javaHome],
    settings: {
      java: {
        project: {resourceFilters: []},
        autobuild: {enabled: false},
        import: {
          maven: {enabled: false},
          gradle: {enabled: false, wrapper: {enabled: false}, offline: {enabled: true}},
        },
        configuration: {
          updateBuildConfiguration: 'disabled',
          runtimes: [{name: 'JavaSE-21', path: options.javaHome, default: true}],
          annotationProcessing: {enabled: false},
        },
        maven: {downloadSources: false},
      },
    },
    profile: {
      kind: 'java-prepared-offline',
      build: model.build,
      release: model.release,
      environment: selected.id,
      metadataDigest: selected.metadataDigest,
      sourceRoots: existing,
      absentOptionalRoots: missing,
      libraries: model.libraries,
      repositoryExecution: false,
      dependencyAcquisition: false,
    },
  };
});

/** Construct a passive v2 project only; source eligibility and session admission remain separate gates. */
export const makeJavaPreparedProject = Effect.fn('semantic.makeJavaPreparedProject')(
  function* (options: {
    readonly project: string;
    readonly worktree: string;
    readonly privateDirectory: string;
    readonly javaHome: string;
    readonly environment: JavaEnvironment;
  }) {
    const selected = yield* Schema.decodeEffect(
      Schema.Struct({
        project: Schema.String,
        worktree: Schema.String,
        privateDirectory: Schema.String,
        javaHome: Schema.String,
        environment: JavaEnvironment,
      }),
      {onExcessProperty: 'error'},
    )({...options, environment: {...options.environment}}).pipe(Effect.mapError(fail));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The caller supplies an existing private parent, disjoint from every observed input and persisted artifact.
    for (const input of [selected.worktree, selected.javaHome, path.dirname(selected.environment.metadataFile)])
      if (inside(input, selected.privateDirectory, path.sep) || inside(selected.privateDirectory, input, path.sep))
        return yield* fail();
    const loaded = yield* loadJavaPreparedModel({
      project: selected.project,
      worktree: selected.worktree,
      javaHome: selected.javaHome,
      metadataFile: selected.environment.metadataFile,
      metadataDigest: selected.environment.metadataDigest,
    });
    const model = loaded.model;
    const workspace = yield* makeJavaWorkspace(selected.privateDirectory);
    const directories = new Map<string, FileSystem.File.Info>();
    const sameIdentity = (original: FileSystem.File.Info, current: FileSystem.File.Info) =>
      Option.isSome(original.ino) &&
      Option.isSome(current.ino) &&
      original.ino.value === current.ino.value &&
      original.dev === current.dev;
    const verifyDirectories = Effect.gen(function* () {
      yield* workspace.verify;
      for (const [directory, original] of directories) {
        const current = yield* fs.lstat(directory);
        if (
          current.type !== 'Directory' ||
          (current.mode & 0o777) !== 0o700 ||
          !sameIdentity(original, current) ||
          (yield* fs.realPath(directory)) !== directory
        )
          return yield* fail();
      }
    });
    const createDirectory = (directory: string) =>
      Effect.gen(function* () {
        yield* verifyDirectories;
        yield* fs.makeDirectory(directory, {mode: 0o700});
        const current = yield* fs.lstat(directory);
        if (
          current.type !== 'Directory' ||
          Option.isNone(current.ino) ||
          (current.mode & 0o777) !== 0o700 ||
          (yield* fs.realPath(directory)) !== directory
        )
          return yield* fail();
        directories.set(directory, current);
        yield* verifyDirectories;
      });
    const project = path.join(workspace.directory, 'project');
    const documentationDirectory = path.join(workspace.directory, 'documentation');
    yield* createDirectory(project);
    yield* createDirectory(path.join(project, '.settings'));
    yield* createDirectory(documentationDirectory);
    const documentationUri = javaFileUri(yield* path.toFileUrl(documentationDirectory + path.sep));
    const bindings = yield* Effect.forEach(
      EffectArray.filter(model.rawClasspath, entry => entry.kind === 3),
      entry =>
        path
          .toFileUrl(path.join(model.project, entry.path))
          .pipe(Effect.map(url => ({path: entry.path, uri: javaFileUri(url)}))),
    );
    const projected = yield* Effect.try({
      try: () => javaPreparedProjection(model, bindings, documentationUri),
      catch: fail,
    });
    const files = Object.freeze(projected.metadata);
    const outputs = new Set([projected.image.outputPath]);
    for (const entry of projected.image.rawClasspath) if (entry.outputPath !== undefined) outputs.add(entry.outputPath);
    const outputNames = EffectArray.map(Array.from(outputs), output => path.basename(output));
    for (const output of outputNames) yield* createDirectory(path.join(project, output));
    const artifacts = new Map<string, FileSystem.File.Info>();
    for (const [name, content] of EffectRecord.toEntries(files)) {
      yield* verifyDirectories;
      yield* fs.writeFileString(path.join(project, name), content, {flag: 'wx', mode: 0o600});
      artifacts.set(path.join(project, name), yield* fs.lstat(path.join(project, name)));
    }
    const inventories = new Map<string, readonly string[]>([
      [project, ['.project', '.classpath', '.settings', ...outputNames]],
      [path.join(project, '.settings'), ['org.eclipse.jdt.core.prefs', 'org.eclipse.core.resources.prefs']],
      [documentationDirectory, []],
      ...EffectArray.map(outputNames, name => [path.join(project, name), []] as const),
    ]);
    const verifyFile = (file: string, content: string) =>
      Effect.gen(function* () {
        const original = artifacts.get(file)!;
        const current = yield* fs.lstat(file);
        if (
          current.type !== 'File' ||
          (current.mode & 0o777) !== 0o600 ||
          !sameIdentity(original, current) ||
          (yield* fs.realPath(file)) !== file ||
          Number(current.size) !== new TextEncoder().encode(content).length ||
          Option.getOrUndefined(current.mtime)?.getTime() !== Option.getOrUndefined(original.mtime)?.getTime()
        )
          return yield* fail();
      });
    const verifyOwnership = Effect.gen(function* () {
      yield* verifyDirectories;
      for (const [directory, names] of inventories) {
        const actual = yield* fs.readDirectory(directory);
        if (actual.length !== names.length || EffectArray.some(actual, name => !names.includes(name)))
          return yield* fail();
      }
      for (const [name, content] of EffectRecord.toEntries(files)) yield* verifyFile(path.join(project, name), content);
    });
    const verify = Effect.gen(function* () {
      yield* loaded.verify;
      yield* verifyOwnership;
      for (const [name, content] of EffectRecord.toEntries(files)) {
        const file = path.join(project, name);
        if (sha256HexSync(yield* readBounded(file, 2 * 1024 * 1024)) !== sha256HexSync(content)) return yield* fail();
      }
      yield* loaded.verify;
      yield* verifyOwnership;
    }).pipe(Effect.mapError(error => (Schema.is(LspFault)(error) ? error : fail())));
    yield* verify;
    return Object.freeze({
      directory: workspace.directory,
      workspace,
      project,
      documentationUri,
      model,
      sourceRoots: loaded.sourceRoots,
      absentSourceRoots: loaded.absentSourceRoots,
      compilerOptions: model.compilerOptions,
      projectionDigest: projected.digest,
      verify,
      settings: {
        java: {
          compile: {nullAnalysis: {mode: 'interactive', nonnull: [], nullable: [], nonnullbydefault: []}},
          // JDT appends its own marker to nonempty preferences; the sealed schema admits only this exact filter.
          project: {resourceFilters: model.resourceFilters.length ? ['node_modules', '\\.git'] : []},
          autobuild: {enabled: false},
          import: {
            maven: {enabled: false},
            gradle: {enabled: false, wrapper: {enabled: false}, offline: {enabled: true}},
          },
          configuration: {
            updateBuildConfiguration: 'disabled',
            runtimes: [{name: 'JavaSE-21', path: model.javaHome, default: true, javadoc: documentationUri}],
            annotationProcessing: {enabled: false},
          },
          maven: {downloadSources: false},
        },
      },
    });
  },
  effect =>
    effect.pipe(
      Effect.mapError(error => (Schema.is(LspFault)(error) ? error : fail())),
      Effect.timeoutOption(45000),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    ),
);
