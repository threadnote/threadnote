import {Array as EffectArray, Option as EffectOption, pipe as effectPipe} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import type {ManagerWorksetDefinition, ManagerWorksetProjectSummary} from '@threadnote/manager/workset/contracts';

export function managerWorksetRepositoryLabel(repositoryKey: string, definition?: ManagerWorksetDefinition): string {
  const member = findDefinitionMember(definition, repositoryKey);
  return member ? `${member.project} · ${managerWorksetMemberLocation(member)}` : opaqueRepositoryLabel(repositoryKey);
}

export function findDefinitionMember(
  definition: ManagerWorksetDefinition | undefined,
  project: string,
): ManagerWorksetDefinition['members'][number] | undefined {
  return definition === undefined
    ? undefined
    : EffectOption.getOrUndefined(
        EffectArray.findFirst(
          definition.members,
          member =>
            Effect.pipe(member.project, EffectString.toLowerCase) === Effect.pipe(project, EffectString.toLowerCase),
        ),
      );
}

export function managerWorksetMemberLocation(member: ManagerWorksetDefinition['members'][number] | undefined): string {
  if (!member) return 'branch and local folder unavailable';
  return managerWorksetLocation(member.branchState, member.branch, member.folder, member.path);
}

export function managerWorksetProjectLocation(project: ManagerWorksetProjectSummary): string {
  return managerWorksetLocation(project.branchState, project.branch, project.folder, project.path);
}

export function managerWorksetProjectSearchText(project: ManagerWorksetProjectSummary): string {
  return Effect.pipe(
    EffectArray.join(
      EffectArray.map(
        effectPipe([project.name, project.branch, project.folder, project.path], values =>
          EffectArray.filter(values, (value, index) => index in values && Boolean(value)),
        ),
        item => (item === null || item === undefined ? '' : String(item)),
      ),
      '\n',
    ),
    EffectString.toLowerCase,
  );
}

export function managerWorksetProjectRank(project: ManagerWorksetProjectSummary, query: string): number {
  if (!query) return 0;
  const name = Effect.pipe(project.name, EffectString.toLowerCase);
  if (name === query) return 0;
  if (Effect.pipe(name, EffectString.startsWith(query))) return 1;
  if (Effect.pipe(name, EffectString.includes(query))) return 2;
  return 3;
}

export function hasProjectSelection(projects: ReadonlySet<string>, project: string): boolean {
  const key = Effect.pipe(project, EffectString.toLowerCase);
  return EffectArray.some([...projects], selected => Effect.pipe(selected, EffectString.toLowerCase) === key);
}

function managerWorksetLocation(
  branchState: ManagerWorksetProjectSummary['branchState'],
  branch: string | undefined,
  folder: string | undefined,
  path: string | undefined,
): string {
  const branchLabel =
    branchState === 'current' && branch
      ? `observed branch ${branch}`
      : branchState === 'detached'
        ? 'observed detached checkout'
        : branchState === 'not-observed'
          ? 'branch observation deferred'
          : 'branch observation unavailable';
  const values = [branchLabel, folder, path];
  return EffectArray.join(
    EffectArray.map(
      EffectArray.filter(
        values,
        (value, index): value is string => value !== undefined && value !== '' && values.indexOf(value) === index,
      ),
      item => String(item),
    ),
    ' · ',
  );
}

function opaqueRepositoryLabel(repositoryKey: string): string {
  const value = Effect.pipe(repositoryKey, EffectString.trim);
  return /^(?:[a-f\d]{24,}|(?:checkout|repository|worktree|repo)[_:-][a-z\d_-]{16,})$/iu.test(value)
    ? `Repository ${Effect.pipe(value, EffectString.slice(0, 8))}…`
    : value || 'Unknown repository';
}
