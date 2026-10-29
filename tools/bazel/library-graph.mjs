import {Array as EffectArray} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/** Condense the resolver's direct graph into deterministic, acyclic source libraries. */
export const buildLibraryGraph = (graph, {owner, generatedOwner}) => {
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  const groups = [];
  const visit = path => {
    indices.set(path, indices.size);
    low.set(path, indices.get(path));
    stack.push(path);
    active.add(path);
    for (const child of graph.get(path)?.files ?? []) {
      if (!indices.has(child)) {
        visit(child);
        low.set(path, Math.min(low.get(path), low.get(child)));
      } else if (active.has(child)) low.set(path, Math.min(low.get(path), indices.get(child)));
    }
    if (low.get(path) !== indices.get(path)) return;
    const members = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      members.push(member);
    } while (member !== path);
    groups.push(members.sort());
  };
  for (const path of [...graph.keys()].sort()) if (!indices.has(path)) visit(path);
  const componentFor = new Map();
  const components = EffectArray.map(groups, srcs => {
    const owners = new Set(srcs.map(owner));
    const packagePath = owner(srcs[0]);
    const eligible = owners.size === 1 && generatedOwner(packagePath);
    const identity = srcs.join('\n');
    const digest = Effect.pipe(
      new Bun.CryptoHasher('sha256').update(identity).digest('hex'),
      EffectString.slice(0, 24),
    );
    const label = `//${packagePath}:_source_${digest}`;
    const component = {label, package: packagePath, srcs, deps: [], npm: [], eligible};
    for (const path of srcs) componentFor.set(path, component);
    return component;
  }).sort((left, right) => Effect.pipe(left.label, EffectString.localeCompare(right.label)));
  for (const component of components) {
    const deps = new Set();
    const npm = new Set();
    for (const path of component.srcs) {
      for (const child of graph.get(path)?.files ?? []) {
        const target = componentFor.get(child);
        if (target !== component) deps.add(target);
      }
      for (const name of graph.get(path)?.npm ?? []) npm.add(name);
    }
    component.deps = [...deps].sort((a, b) => a.label.localeCompare(b.label));
    component.npm = [...npm].sort();
  }
  const libraries = new Map();
  const expanded = new Map();
  const expand = component => {
    if (expanded.has(component)) return expanded.get(component);
    const files = new Set(component.srcs);
    const npm = new Set(component.npm);
    for (const dep of component.deps) {
      const child = expand(dep);
      for (const file of child.files) files.add(file);
      for (const name of child.npm) npm.add(name);
    }
    const result = {files: [...files].sort(), npm: [...npm].sort()};
    expanded.set(component, result);
    return result;
  };
  const boundaries = new Map();
  const boundary = component => {
    if (boundaries.has(component)) return boundaries.get(component);
    if (component.eligible) {
      const result = {srcs: [], deps: [component.label], npm: []};
      boundaries.set(component, result);
      return result;
    }
    const sets = {srcs: new Set(component.srcs), deps: new Set(), npm: new Set(component.npm)};
    for (const dep of component.deps) {
      const child = boundary(dep);
      for (const key of ['srcs', 'deps', 'npm']) for (const value of child[key]) sets[key].add(value);
    }
    const result = EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(sets), ([key, values]) => [key, [...values].sort()]),
    );
    boundaries.set(component, result);
    return result;
  };
  for (const component of components) {
    expand(component);
    if (!component.eligible) continue;
    const declaration = {package: component.package, srcs: [...component.srcs], deps: [], npm: [...component.npm]};
    for (const dep of component.deps) {
      const child = boundary(dep);
      for (const key of ['srcs', 'deps', 'npm']) for (const value of child[key]) declaration[key].push(value);
    }
    for (const key of ['srcs', 'deps', 'npm']) declaration[key] = [...new Set(declaration[key])].sort();
    libraries.set(component.label, declaration);
  }
  const factor = (files, npm, protectedFiles = []) => {
    const allowedFiles = new Set(files);
    const allowedNpm = new Set(npm);
    const protectedSet = new Set(protectedFiles);
    const candidates = EffectArray.filter(components, (component, index) => {
      if (!(index in components)) return false;
      const closure = expanded.get(component);
      return (
        component.eligible &&
        component.srcs.some(path => /\.[cm]?[jt]sx?$/u.test(path)) &&
        closure.files.every(path => allowedFiles.has(path) && !protectedSet.has(path)) &&
        closure.npm.every(name => allowedNpm.has(name))
      );
    });
    const covered = new Set();
    for (const component of candidates)
      for (const dep of component.deps) {
        const pending = [dep];
        while (pending.length) {
          const child = pending.pop();
          if (covered.has(child)) continue;
          covered.add(child);
          pending.push(...child.deps);
        }
      }
    const roots = EffectArray.filter(candidates, component => !covered.has(component));
    const remainingFiles = new Set(files);
    const remainingNpm = new Set(npm);
    for (const component of roots) {
      const closure = expanded.get(component);
      for (const path of closure.files) remainingFiles.delete(path);
      for (const name of closure.npm) remainingNpm.delete(name);
    }
    return {
      srcs: [...remainingFiles].sort(),
      deps: EffectArray.map(roots, component => component.label).sort(),
      npm: [...remainingNpm].sort(),
    };
  };
  return {libraries, factor};
};
