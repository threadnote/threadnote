import {Array as EffectArray, Predicate} from 'effect';
import {Effect, Schema} from 'effect';
import {isMap, isScalar, isSeq, parseDocument, type YAMLMap} from 'yaml';
import {previewCodeGraphProjectScope, type CodeGraphProjectScopePreview} from '@threadnote/graph/scope/preview';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import type {ProjectManifest, RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {SystemInfo} from '@threadnote/platform/system';
import type {ApplicationServices} from '../../effect/runtime.js';
import {managerProjectPathIsForeign} from './roots.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export class ManagerProjectGraphScopeError extends Schema.TaggedError<
  ManagerProjectGraphScopeError,
  {readonly brand: unique symbol}
>()('ManagerProjectGraphScopeError', {code: Schema.String, message: Schema.String, status: Schema.Finite}) {
  static of(code: string, message: string, status: number): ManagerProjectGraphScopeError {
    return ManagerProjectGraphScopeError.make({code, message, status});
  }
}

export function validateManagerProjectGraphInput(
  value: unknown,
  maximumPaths: number,
): NonNullable<ProjectManifest['graph']> {
  if (!Predicate.isObject(value)) throw new Error('graph must be an object.');
  const graph = value;
  if (graph.closure !== 'dependencies') throw new Error('graph closure must be dependencies.');
  const roots = graphPaths(graph.roots, 'graph roots', true, maximumPaths);
  const include =
    graph.include === undefined ? undefined : graphPaths(graph.include, 'graph include', false, maximumPaths);
  return {closure: 'dependencies', ...(include === undefined ? {} : {include}), roots};
}

export function reconcileManagerProjectGraph(map: YAMLMap, graph: ProjectManifest['graph']): void {
  if (graph === undefined) {
    map.delete('graph');
    return;
  }
  const current = map.get('graph', true);
  if (!isMap(current)) {
    map.set('graph', copyManagerProjectGraph(graph));
    return;
  }
  setYamlString(current, 'closure', graph.closure);
  reconcileYamlStringSequence(current, 'roots', graph.roots);
  if (graph.include === undefined) current.delete('include');
  else reconcileYamlStringSequence(current, 'include', graph.include);
}

export const previewConfiguredManagerProjectGraphScope = Effect.fn('managerProjectGraph.previewConfiguredScope')(
  function* (config: RuntimeConfig, projectName: string) {
    const manifest = yield* readSeedManifest(config.manifestPath).pipe(
      Effect.mapError(() =>
        ManagerProjectGraphScopeError.of('manifest-unavailable', 'The seed manifest could not be read.', 500),
      ),
    );
    const project = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        manifest.projects,
        item =>
          Effect2.pipe(item.name, EffectString.toLowerCase) === Effect2.pipe(projectName, EffectString.toLowerCase),
      ),
    );
    if (!project)
      return yield* ManagerProjectGraphScopeError.of(
        'project-not-found',
        'Threadnote project not found. Create it in Manager or with `threadnote project create <name>`.',
        404,
      );
    const system = yield* SystemInfo;
    if (managerProjectPathIsForeign(project.path, system.platform)) {
      return yield* ManagerProjectGraphScopeError.of(
        'project-path-unavailable',
        'The configured project path is for another host.',
        409,
      );
    }
    const cwd = yield* expandPath(project.path).pipe(
      Effect.mapError(() =>
        ManagerProjectGraphScopeError.of(
          'project-path-unavailable',
          'The configured project path is unavailable.',
          409,
        ),
      ),
    );
    return yield* previewCodeGraphProjectScope(project, cwd).pipe(
      Effect.mapError(cause => ManagerProjectGraphScopeError.of('scope-preview-failed', cause.message, 409)),
    );
  },
) as (
  config: RuntimeConfig,
  projectName: string,
) => Effect.Effect<CodeGraphProjectScopePreview, ManagerProjectGraphScopeError, ApplicationServices>;

export function copyManagerProjectGraph(
  graph: NonNullable<ProjectManifest['graph']>,
): NonNullable<ProjectManifest['graph']> {
  return {
    closure: graph.closure,
    ...(graph.include === undefined ? {} : {include: [...graph.include]}),
    roots: [...graph.roots],
  };
}

export function managerProjectGraphsEqual(left: ProjectManifest['graph'], right: ProjectManifest['graph']): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.closure === right.closure &&
    unorderedStringsEqual(left.roots, right.roots) &&
    unorderedStringsEqual(left.include ?? [], right.include ?? [])
  );
}

export function managerProjectsEqual(left: ProjectManifest, right: ProjectManifest): boolean {
  return managerProjectGraphIdentityEqual(left, right) && managerProjectSeedsEqual(left.seed, right.seed);
}

export function managerProjectGraphIdentityEqual(left: ProjectManifest, right: ProjectManifest): boolean {
  return (
    managerProjectGraphsEqual(left.graph, right.graph) &&
    left.name === right.name &&
    left.path === right.path &&
    left.uri === right.uri
  );
}

export function managerProjectSeedsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && EffectArray.every(left, (value, index) => value === right[index]);
}

export function managerProjectGraphYamlSupported(item: YAMLMap): boolean {
  const graph = item.get('graph', true);
  if (graph === undefined) return true;
  if (!isMap(graph) || hasYamlAnchor(graph)) return false;
  const closure = graph.get('closure', true);
  const roots = graph.get('roots', true);
  const include = graph.get('include', true);
  return (
    isScalar(closure) &&
    typeof closure.value === 'string' &&
    !hasYamlAnchor(closure) &&
    isSeq(roots) &&
    !hasYamlAnchor(roots) &&
    !EffectArray.some(roots.items, root => !isScalar(root) || typeof root.value !== 'string' || hasYamlAnchor(root)) &&
    (include === undefined ||
      (isSeq(include) &&
        !hasYamlAnchor(include) &&
        !EffectArray.some(
          include.items,
          value => !isScalar(value) || typeof value.value !== 'string' || hasYamlAnchor(value),
        )))
  );
}

export function managerProjectYamlDocumentSupported(document: ReturnType<typeof parseDocument>): boolean {
  const projects = document.get('projects', true);
  if (!isSeq(projects) || hasYamlAnchor(projects)) return false;
  return EffectArray.every(projects.items, item => {
    if (!isMap(item) || hasYamlAnchor(item)) return false;
    const requiredFields = ['name', 'path', 'uri'] as const;
    if (
      EffectArray.some(requiredFields, field => {
        const value = item.get(field, true);
        return !isScalar(value) || typeof value.value !== 'string' || hasYamlAnchor(value);
      })
    ) {
      return false;
    }
    const seed = item.get('seed', true);
    return (
      isSeq(seed) &&
      !hasYamlAnchor(seed) &&
      !EffectArray.some(
        seed.items,
        pattern => !isScalar(pattern) || typeof pattern.value !== 'string' || hasYamlAnchor(pattern),
      ) &&
      managerProjectGraphYamlSupported(item)
    );
  });
}

function graphPaths(value: unknown, field: string, required: boolean, maximumPaths: number): readonly string[] {
  if (!EffectArray.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${field} must be a${required ? ' non-empty' : ''} string array.`);
  }
  if (value.length > maximumPaths) throw new Error(`${field} has too many paths.`);
  const paths = EffectArray.map(value, item => {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      Effect2.pipe(item, EffectString.startsWith('/')) ||
      Effect2.pipe(item, EffectString.includes('\\'))
    ) {
      throw new Error(`${field} must contain repository-relative paths.`);
    }
    if (
      EffectArray.some(
        Effect2.pipe(item, EffectString.split('/')),
        segment => segment.length === 0 || segment === '.' || segment === '..',
      ) ||
      hasControlCharacter(item)
    ) {
      throw new Error(`${field} must contain repository-relative paths.`);
    }
    return item;
  });
  if (new Set(paths).size !== paths.length) throw new Error(`${field} must not contain duplicate paths.`);
  return paths;
}

function hasControlCharacter(value: string): boolean {
  return EffectArray.some([...value], character => {
    const code =
      Effect2.pipe(
        character,
        EffectString.codePointAt(0),
        Effect2.Option.getOrElse(() => undefined),
      ) ?? 0;
    return code <= 31 || code === 127;
  });
}

function hasYamlAnchor(node: {readonly anchor?: string}): boolean {
  return typeof node.anchor === 'string' && node.anchor.length > 0;
}

function unorderedStringsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === right.length && EffectArray.every(right, value => values.has(value));
}

function reconcileYamlStringSequence(map: YAMLMap, key: string, values: readonly string[]): void {
  const current = map.get(key, true);
  if (!isSeq(current)) {
    map.set(key, [...values]);
    return;
  }
  const available = new Map<string, typeof current.items>();
  for (const item of current.items) {
    if (!isScalar(item) || typeof item.value !== 'string') continue;
    const matches = available.get(item.value) ?? [];
    matches.push(item);
    available.set(item.value, matches);
  }
  const next = [] as typeof current.items;
  for (const value of values) {
    const retained = available.get(value)?.shift();
    if (retained !== undefined) next.push(retained);
    else {
      current.add(value);
      next.push(current.items.pop());
    }
  }
  current.items = next;
}

function setYamlString(map: YAMLMap, key: string, value: string): void {
  const current = map.get(key, true);
  if (isScalar(current) && typeof current.value === 'string') current.value = value;
  else map.set(key, value);
}
