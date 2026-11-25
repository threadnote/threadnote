import type * as ts from 'typescript/ast';
import {API, type TranspileOptions, type TranspileOutput} from 'typescript/async';

/**
 * Repository tooling parses syntax only, so it uses the official npm `typescript` package and its bundled platform
 * binary after `bun install`. The verified native asset is reserved for the product and the native tests.
 */
export interface TypeScriptSyntaxSource {
  readonly fileName: string;
  readonly text: string;
  readonly scriptKind?: ts.ScriptKind;
}

export interface TypeScriptSyntaxSession {
  withSourceFile<A>(input: TypeScriptSyntaxSource, use: (source: ts.SourceFile) => A | Promise<A>): Promise<A>;
  withSourceFileAndTranspile<A>(
    input: TypeScriptSyntaxSource,
    options: TranspileOptions,
    use: (source: ts.SourceFile, emitted: TranspileOutput) => A | Promise<A>,
  ): Promise<A>;
  close(): Promise<void>;
}

/** One npm API child per command or test file; callers close it once. */
export function createTypeScriptSyntaxSession(options: {readonly cwd: string}): TypeScriptSyntaxSession {
  const api = new API({cwd: options.cwd});
  const leased = async <A>(input: TypeScriptSyntaxSource, use: (source: ts.SourceFile) => A | Promise<A>) => {
    const lease = await api.createSourceFile(
      input.fileName,
      input.text,
      input.scriptKind === undefined ? undefined : {scriptKind: input.scriptKind},
    );
    try {
      return await use(lease.sourceFile);
    } finally {
      await lease.dispose();
    }
  };
  return {
    withSourceFile: leased,
    withSourceFileAndTranspile: async (input, transpileOptions, use) => {
      const emitted = await api.transpileModule(input.text, transpileOptions);
      return leased(input, source => use(source, emitted));
    },
    close: () => api.close(),
  };
}
