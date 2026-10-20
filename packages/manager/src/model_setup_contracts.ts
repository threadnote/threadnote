/** Public setup projection, shared structurally with the CLI without backend imports. */
export interface ModelSetupStatus {
  readonly version: 1;
  readonly intentEpoch: number;
  readonly modelId: string;
  readonly totalBytes: number;
  readonly policy: 'automatic' | 'off';
  readonly phase:
    'not-requested' | 'pending' | 'downloading' | 'verifying' | 'ready' | 'retry-wait' | 'action-required' | 'off';
  readonly bytes: number;
  readonly attempts: number;
  readonly artifactReady: boolean;
  readonly effectiveDefault: boolean;
  readonly environmentOff: boolean;
  readonly nextAttemptAt?: number;
  readonly reason?: string;
}

interface ModelSetupActionFence {
  readonly confirm: true;
  readonly expectedEpoch: number;
}
export type ModelSetupAction = ModelSetupActionFence &
  ({readonly action: 'setup' | 'retry'} | {readonly action: 'policy'; readonly policy: 'automatic' | 'off'});
