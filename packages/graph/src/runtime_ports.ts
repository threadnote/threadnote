import {Context, Effect, Exit} from 'effect';
import type {CodeGraphInventory} from './inventory.js';
import type {
  CodeGraphIndexSummary,
  CodeGraphProgress,
  CodeGraphStoreFailureCode,
  CodeGraphStoreRecovery,
} from './types.js';
import type {CodeGraphWorksetPrepareProgressV1, CodeGraphWorksetPrepareResultV1} from './workset_catalog/workset.js';

export type CodeGraphAnonymousTelemetryComponent = 'cli' | 'mcp';

export interface CodeGraphBuildAnonymousTelemetryReporter {
  readonly observeExtractedFactBytes: (bytes: number) => Effect.Effect<void>;
  readonly observeInventory: (inventory: CodeGraphInventory) => Effect.Effect<void>;
  readonly observeOverlay: (dirty: boolean) => Effect.Effect<void>;
  readonly progress: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly terminal: <E>(exit: Exit.Exit<CodeGraphIndexSummary, E>) => Effect.Effect<void>;
}

export interface CodeGraphWorksetTelemetryReporter {
  readonly failure: (error: unknown, completed: number, total: number) => Effect.Effect<void>;
  readonly progress: (progress: CodeGraphWorksetPrepareProgressV1) => Effect.Effect<void>;
  readonly terminal: (result: CodeGraphWorksetPrepareResultV1) => Effect.Effect<void>;
}

export type CodeGraphBackgroundFailure =
  | {readonly operation: 'graph-maintenance'; readonly error: unknown}
  | {
      readonly operation: 'graph-refresh';
      readonly failure: {
        readonly code: CodeGraphStoreFailureCode;
        readonly operation: 'refresh code graph';
        readonly recovery: CodeGraphStoreRecovery;
        readonly retryable: boolean;
      };
    };

export class CodeGraphObservability extends Context.Service<
  CodeGraphObservability,
  {
    readonly makeBuildReporter: (
      component: CodeGraphAnonymousTelemetryComponent,
    ) => Effect.Effect<CodeGraphBuildAnonymousTelemetryReporter>;
    readonly makeWorksetReporter: Effect.Effect<CodeGraphWorksetTelemetryReporter>;
    readonly backgroundFailure: (
      component: CodeGraphAnonymousTelemetryComponent,
      failure: CodeGraphBackgroundFailure,
    ) => Effect.Effect<void>;
  }
>()('@threadnote/graph/runtime_ports/CodeGraphObservability') {}

export class CodeGraphProcessActivity extends Context.Service<
  CodeGraphProcessActivity,
  {
    readonly withActivity: <A, E, R>(
      role: 'graph-waiter' | 'graph-builder',
      operation: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()('@threadnote/graph/runtime_ports/CodeGraphProcessActivity') {}

export function codeGraphAnonymousTelemetryComponent(
  environment: Readonly<Record<string, string | undefined>>,
): CodeGraphAnonymousTelemetryComponent {
  return environment.THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli';
}

export function withCodeGraphBuildAnonymousTelemetry<A extends CodeGraphIndexSummary, E, R>(
  reporter: CodeGraphBuildAnonymousTelemetryReporter,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.onExit(exit => reporter.terminal(exit)));
}

/** Application-owned detached process adapter; waking never authorizes queue creation. */
export class CodeGraphEmbeddingWorkerProcess extends Context.Service<
  CodeGraphEmbeddingWorkerProcess,
  {readonly wake: (home: string) => Effect.Effect<boolean, unknown>}
>()('@threadnote/graph/runtime_ports/CodeGraphEmbeddingWorkerProcess') {}
