const PYTHON_METADATA_SOURCES = new Set([
  'apps/threadnote/src/migration/legacy-installations.ts',
  'packages/graph/src/languages/catalog.generated.ts',
  'packages/graph/src/languages/generic/definitions.ts',
  'packages/graph/src/languages/tree_sitter_assets.ts',
  'packages/manager/src/memory_editor_languages.ts',
]);

// This is an optional, nonfatal workflow readiness probe, not a core runtime
// prerequisite. Match the reviewed block rather than exempting its whole file.
const OPTIONAL_WORKFLOW_PROBE = `  const python = yield* findWorkingExecutable(
    ['python3', 'python', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'],
    ['-B', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'],
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (!python)
    prerequisites.push({
      code: 'missing-python',
      message: 'Development workflow helpers require Python 3.10 or newer in PATH.',
    });`;

export function hasUndeclaredPythonRuntimeReference(relativePath: string, content: string): boolean {
  if (PYTHON_METADATA_SOURCES.has(relativePath)) return false;
  let source = content.replaceAll('\r\n', '\n');
  if (
    relativePath === 'apps/threadnote/src/dev_skills/contract.ts' ||
    relativePath === 'packages/manager/src/dev_skills/contracts.ts'
  ) {
    source = source.replace('    readonly python: string;', '');
  } else if (relativePath === 'apps/threadnote/src/dev_skills/manifest.ts') {
    source = source.replace("python: '>=3.10',", '');
  } else if (relativePath === 'apps/threadnote/src/dev_skills/readiness.ts') {
    source = source.replace(OPTIONAL_WORKFLOW_PROBE, '');
  }
  return /\bpython(?:\d+(?:\.\d+)*)?\b/i.test(source);
}
