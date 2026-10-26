const PYTHON_METADATA_SOURCES = new Set([
  'apps/threadnote/src/migration/legacy-installations.ts',
  'packages/graph/src/languages/catalog.generated.ts',
  'packages/graph/src/languages/generic/definitions.ts',
  'packages/graph/src/languages/tree_sitter_assets.ts',
  'packages/manager/src/memory_editor_languages.ts',
]);

// Retained ownership metadata permits explicit replacement of installed old packs.
// Native workflows must never probe or execute an interpreter.
const HISTORICAL_WORKFLOW_PREREQUISITES =
  "const historicalPrerequisites = {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']};";
const HISTORICAL_WORKFLOW_DIAGNOSTIC =
  "'Retained Python workflow ownership is recognized. Explicitly update or repair these workflows before running them.'";

export function hasUndeclaredPythonRuntimeReference(relativePath: string, content: string): boolean {
  if (PYTHON_METADATA_SOURCES.has(relativePath)) return false;
  let source = content.replaceAll('\r\n', '\n');
  if (relativePath === 'apps/threadnote/src/dev_skills/manifest.ts') {
    source = source.replace(HISTORICAL_WORKFLOW_PREREQUISITES, '').replace(HISTORICAL_WORKFLOW_DIAGNOSTIC, '');
  }
  return /\bpython(?:\d+(?:\.\d+)*)?\b/i.test(source);
}
