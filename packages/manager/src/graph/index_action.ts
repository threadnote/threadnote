import type {ManagerDialogs} from '../dialog.js';
import type {GraphAdministrationAction, GraphIndexActionResponse} from './model.js';

/** A scope-selection response never started a build. Cancellation sends no follow-up action. */
export async function requestGraphAdministrationAction(
  action: GraphAdministrationAction,
  api: (
    path: string,
    body: GraphAdministrationAction & {readonly confirm: boolean},
  ) => Promise<GraphIndexActionResponse>,
  dialogs: ManagerDialogs,
): Promise<{readonly output: string} | undefined> {
  const request = (requested: GraphAdministrationAction) =>
    api('/api/graphs/action', {...requested, confirm: !('dryRun' in requested) || requested.dryRun !== true});
  const result = await request(action);
  if ('output' in result) return result;
  if (action.action !== 'index') {
    throw new Error('Refresh Manager and choose the configured project again.');
  }
  const {projects, expectedRevision} = result.scopeSelection;
  const values = await dialogs.prompt({
    title: 'Choose graph scope',
    message: 'This repository has multiple configured graph scopes. Choose the scope to index.',
    detail: projects.map(project => `${project.name}: ${project.roots.join(', ') || '.'}`).join('\n'),
    confirmLabel: action.full ? 'Reindex scope' : 'Index scope',
    fields: [{id: 'project', label: 'Scope', options: projects.map(project => project.name), required: true}],
  });
  if (!values) return undefined;
  const selected = projects.find(project => project.name === values.project);
  if (!selected) throw new Error('Choose one of the configured graph scopes.');
  const indexed = await request({...action, project: selected.name, expectedRevision});
  if (!('output' in indexed)) throw new Error('Configured graph scopes changed. Refresh Manager and choose again.');
  return indexed;
}
