import * as EffectString from 'effect/String';
import * as Effect from 'effect';
const PYTHON_METADATA_SOURCES = new Set([
  'apps/threadnote/src/migration/legacy-installations.ts',
  'packages/graph/src/languages/catalog.generated.ts',
  'packages/graph/src/languages/generic/definitions.ts',
  'packages/graph/src/languages/tree_sitter_assets.ts',
  'packages/manager/src/memory_editor_languages.ts',
]);
const SEMANTIC_PYTHON_METADATA_SOURCES = new Set([
  'apps/threadnote/src/semantic/coordinator.ts',
  'apps/threadnote/src/semantic/provider.ts',
  'apps/threadnote/src/semantic/providers/python.ts',
  'apps/threadnote/src/semantic/providers/python_project.ts',
]);
const LSP_PROCESS_IMPORT = "import {spawn, type ChildProcess} from 'node:child_process';";
const PYTHON_RESPONDER_IMPORTS =
  "return `import {createHash} from 'node:crypto';\nimport {writeFileSync} from 'node:fs';";

/** Bun's owned stdio boundary and the pinned external Node metadata responder are intentional. */
export function hasUndeclaredNodeBuiltinImport(relativePath: string, content: string): boolean {
  let source = Effect.pipe(content, EffectString.replaceAll('\r\n', '\n'));
  if (relativePath === 'apps/threadnote/src/semantic/lsp_transport.ts')
    source = Effect.pipe(source, EffectString.replace(LSP_PROCESS_IMPORT, ''));
  if (relativePath === 'apps/threadnote/src/semantic/providers/python_project.ts')
    source = Effect.pipe(source, EffectString.replace(PYTHON_RESPONDER_IMPORTS, 'return `'));
  return /(?:from\s+['"]node:|import\s+['"]node:|import\s*\(\s*['"]node:|require\s*\(\s*['"]node:)/u.test(source);
}

// Retained ownership metadata permits explicit replacement of installed old packs.
// Native workflows must never probe or execute an interpreter.
const HISTORICAL_WORKFLOW_PREREQUISITES =
  "const historicalPrerequisites = {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']};";
const HISTORICAL_WORKFLOW_DIAGNOSTIC =
  "'Retained Python workflow ownership is recognized. Explicitly update or repair these workflows before running them.'";

export function hasUndeclaredPythonRuntimeReference(relativePath: string, content: string): boolean {
  if (PYTHON_METADATA_SOURCES.has(relativePath)) return false;
  let source = Effect.pipe(content, EffectString.replaceAll('\r\n', '\n'));
  if (SEMANTIC_PYTHON_METADATA_SOURCES.has(relativePath)) {
    // These modules describe a language served by pinned Node, not an interpreter dependency.
    // Consume only the existing protocol literals; added interpreter command literals still fail.
    source = Effect.pipe(
      source,
      EffectString.replaceAll(/\b(?:language|l)\s*===\s*'python'/gu, ''),
      EffectString.replaceAll(/\blanguage:\s*'python'/gu, ''),
      EffectString.replace("'candidate' | 'python' |", ''),
      EffectString.replace("  'python',", ''),
      EffectString.replace("'Experimental Python static-environment profile'", ''),
    );
    return /['"`][^'"`\r\n]*\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?(?=\s|['"`;&|<>])/iu.test(source);
  }
  if (relativePath === 'apps/threadnote/src/dev_skills/manifest.ts') {
    source = Effect.pipe(
      source,
      EffectString.replace(HISTORICAL_WORKFLOW_PREREQUISITES, ''),
      EffectString.replace(HISTORICAL_WORKFLOW_DIAGNOSTIC, ''),
    );
  }
  return /\bpython(?:\d+(?:\.\d+)*)?\b/i.test(source);
}
