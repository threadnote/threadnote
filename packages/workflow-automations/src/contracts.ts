import {Context, Effect, Schema} from 'effect';

/** Versioned executor contracts are independent from immutable skill provenance. */
export const workflowAutomationProtocol = 1 as const;

export class WorkflowAutomationError extends Schema.TaggedError<WorkflowAutomationError>()('WorkflowAutomationError', {
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export interface WorkflowArtifact {
  readonly uri: string;
  readonly memoryId: string;
  readonly revision: string;
  readonly body: string;
  readonly storageKind: 'durable' | 'handoff';
  readonly state: 'active' | 'archived';
}

export interface WorkflowWriteIntent {
  readonly bindingId: string;
  readonly operationId: string;
  readonly artifactKey: string;
  readonly sourceRunId: string;
  readonly role: string;
  readonly nameHint?: string;
  readonly body: string;
  readonly expectedRevision: string | null;
  readonly uri?: string;
  readonly storageKind?: 'durable' | 'handoff';
  readonly codeRefs?: readonly string[];
  readonly relations?: readonly {readonly type: string; readonly uri: string}[];
  readonly evidenceRefs?: readonly WorkflowEvidenceReference[];
}

export interface WorkflowEvidenceReference {
  readonly uri: string;
  readonly memoryId: string;
  readonly revision: string;
}

/** App adapters retain native scope, identity, citation, CAS and publication authority. */
export class WorkflowMemory extends Context.Service<
  WorkflowMemory,
  {
    readonly read: (
      bindingId: string,
      uri: string,
      evidenceRefs?: readonly WorkflowEvidenceReference[],
    ) => Effect.Effect<WorkflowArtifact, WorkflowAutomationError>;
    readonly preflight: (
      intent: WorkflowWriteIntent,
    ) => Effect.Effect<{readonly uri: string; readonly bodySha256: string}, WorkflowAutomationError>;
    readonly write: (intent: WorkflowWriteIntent) => Effect.Effect<WorkflowArtifact, WorkflowAutomationError>;
    readonly inspectOperation: (
      intent: WorkflowWriteIntent,
    ) => Effect.Effect<
      {readonly state: 'absent' | 'prepared' | 'verified'; readonly intentDigest?: string},
      WorkflowAutomationError
    >;
    readonly recover: (
      bindingId: string,
      operationId: string,
    ) => Effect.Effect<WorkflowArtifact, WorkflowAutomationError>;
  }
>()('@threadnote/workflow-automations/contracts/WorkflowMemory') {}

export interface WorkflowSourceSnapshot {
  readonly head: string;
  readonly tree: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface WorkflowReadyGraph {
  readonly state: 'ready';
  readonly snapshotId: string;
  readonly head: string;
  readonly graphContentId: string;
  readonly repositoryRoot: string;
  readonly dirty: boolean;
}

/** Prepare/verify readiness before graph-dependent discovery, never silently downgrade it. */
export class WorkflowGraph extends Context.Service<
  WorkflowGraph,
  {
    readonly ready: (repo: string) => Effect.Effect<WorkflowReadyGraph, WorkflowAutomationError>;
  }
>()('@threadnote/workflow-automations/contracts/WorkflowGraph') {}

export class WorkflowGit extends Context.Service<
  WorkflowGit,
  {
    readonly inspect: (
      repo: string,
      paths: readonly string[],
    ) => Effect.Effect<WorkflowSourceSnapshot, WorkflowAutomationError>;
    readonly snapshot: (repo: string, base: string) => Effect.Effect<WorkflowSourceSnapshot, WorkflowAutomationError>;
  }
>()('@threadnote/workflow-automations/contracts/WorkflowGit') {}

/** Paths must be admitted by the app's canonical ownership guard before access. */
export class WorkflowFiles extends Context.Service<
  WorkflowFiles,
  {
    readonly read: (path: string, maximumBytes: number) => Effect.Effect<string, WorkflowAutomationError>;
    readonly replace: (
      path: string,
      body: string,
      expectedDigest: string | null,
    ) => Effect.Effect<void, WorkflowAutomationError>;
  }
>()('@threadnote/workflow-automations/contracts/WorkflowFiles') {}

export interface WorkflowWatchSnapshot {
  readonly head: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly complete: boolean;
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly events: readonly {readonly id: string; readonly kind: string; readonly url?: string}[];
}

export class WorkflowWatchProvider extends Context.Service<
  WorkflowWatchProvider,
  {
    readonly collect: (pr: string) => Effect.Effect<WorkflowWatchSnapshot, WorkflowAutomationError>;
  }
>()('@threadnote/workflow-automations/contracts/WorkflowWatchProvider') {}

/** Only a trusted same-binary child is launchable through this port. */
export class WorkflowProcesses extends Context.Service<
  WorkflowProcesses,
  {
    readonly launchWatcher: (
      pr: string,
      stateDirectory: string,
    ) => Effect.Effect<{readonly pid: number}, WorkflowAutomationError>;
  }
>()('@threadnote/workflow-automations/contracts/WorkflowProcesses') {}
