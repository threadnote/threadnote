/* oxlint-disable effecttsgo/node-builtin-import -- Deferred-client inventory writes a private operator receipt only. */
import {writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {activeSafetyObligations} from './inventory.js';

/** P09 deferral never discharges shared safety at the active MCP and CLI interfaces. */
export async function runEditorQualificationCommand(arguments_: readonly string[] = process.argv.slice(2)) {
  const {values} = parseArgs({
    args: [...arguments_],
    options: {inventory: {type: 'boolean'}, output: {type: 'string'}},
    strict: true,
  });
  if (!values.inventory || !values.output)
    throw new Error('P09 editor qualification is deferred; use --inventory --output <new-report.json>');
  await writeFile(
    values.output,
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'deferred-editor-qualification',
        status: 'deferred',
        productionQualified: false,
        clients: ['editor-lsp', 'coexistence', 'hover-CodeLens', 'first-party-guarded-integration'],
        activeSafetyObligations,
        providerLaunches: 0,
        editorLaunches: 0,
        note: 'P00 --probe remains historical feasibility only. No P09 release receipt exists.',
      },
      null,
      2,
    ) + '\n',
    {mode: 0o600, flag: 'wx'},
  );
}
