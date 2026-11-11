import {Array as EffectArray, Effect, FileSystem, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {resolveCodeGraphScopeRoute, CodeGraphScopeRoutingError} from '@threadnote/graph/scope/routing';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {workflowError, type WorkflowBinding} from './protocol.js';

const MAX_CHOICES = 5;
const normalized = (name: string) => EffectString.toLowerCase(EffectString.trim(name));
const choices = (projects: readonly {readonly name: string}[]) => {
  const names = [...new Set(EffectArray.map(projects, project => project.name))].sort();
  return `${EffectArray.join(names.slice(0, MAX_CHOICES), ', ')}${names.length > MAX_CHOICES ? `, and ${names.length - MAX_CHOICES} more` : ''}`;
};

/** Validate a run selector before name reservation, journal creation, or indexing. */
export const validateWorkflowGraphProject = Effect.fn('workflowGraph.validateProject')(function* (
  config: RuntimeConfig,
  repo: string,
  requested: string,
) {
  if (
    !EffectString.trim(requested) ||
    new TextEncoder().encode(requested).byteLength > 256 ||
    config.manifestSource === 'bundled-example'
  )
    return yield* workflowError(
      'graph-scope-invalid',
      'graphProject must name a configured graph project in this checkout. Use a configured project name with graphProject or --graph-project.',
    );
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(config.manifestPath)))
    return yield* workflowError(
      'graph-scope-invalid',
      'No configured graph manifest is available. Configure a graph project before selecting graphProject.',
    );
  const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, repo, requested).pipe(
    Effect.catch(() =>
      workflowError(
        'graph-scope-invalid',
        'graphProject must name a configured graph project in this checkout. Use a configured project name with graphProject or --graph-project.',
      ),
    ),
  );
  if (route.state !== 'selected' || normalized(route.project.name) !== normalized(requested))
    return yield* workflowError(
      'graph-scope-invalid',
      'graphProject must be a configured project name in this checkout; graph root aliases are not accepted.',
    );
  return route.project.name;
});

/** The sole route for native workflow graph access. Selected runs fail closed. */
export const resolveWorkflowGraphScope = Effect.fn('workflowGraph.resolveScope')(function* (
  config: RuntimeConfig,
  binding: Pick<WorkflowBinding, 'repo' | 'graphProject'>,
) {
  if (binding.graphProject !== undefined) {
    const name = yield* validateWorkflowGraphProject(config, binding.repo, binding.graphProject).pipe(
      Effect.catch(() =>
        workflowError(
          'graph-scope-unavailable',
          'The bound graph project is unavailable in this checkout. Restore its manifest entry and checkout, or start a fresh run with graphProject or --graph-project.',
        ),
      ),
    );
    if (name !== binding.graphProject)
      return yield* workflowError(
        'graph-scope-unavailable',
        'The bound graph project changed. Restore its original manifest spelling or start a fresh run.',
      );
    const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, binding.repo, name).pipe(
      Effect.catch(() =>
        workflowError(
          'graph-scope-unavailable',
          'The bound graph project is unavailable. Restore its manifest entry and checkout.',
        ),
      ),
    );
    if (route.state !== 'selected' || route.project.name !== name)
      return yield* workflowError(
        'graph-scope-unavailable',
        'The bound graph project is unavailable. Restore its manifest entry and checkout.',
      );
    return route;
  }
  return yield* resolveCodeGraphScopeRoute(config.manifestPath, binding.repo).pipe(
    Effect.catch(error =>
      Schema.is(CodeGraphScopeRoutingError)(error) && error.projects
        ? workflowError(
            'graph-scope-required',
            `Graph scope is ambiguous. Start a fresh run with graphProject or --graph-project set to one of: ${choices(error.projects)}. Alternatively, make the graph manifest unambiguous, then retry this run.`,
          )
        : workflowError(
            'graph-scope-unavailable',
            'Graph scope is unavailable. Check the configured graph manifest and retry.',
          ),
    ),
  );
});

export const workflowGraphProjectHint = Effect.fn('workflowGraph.projectHint')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  if (binding.graphProject === undefined) return binding.project;
  const route = yield* resolveWorkflowGraphScope(config, binding);
  if (route.state !== 'selected')
    return yield* workflowError('graph-scope-unavailable', 'The bound graph project is unavailable.');
  return route.project.name;
});
