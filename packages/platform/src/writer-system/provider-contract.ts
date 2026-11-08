export const ownedProviderTreeBrand: unique symbol = Symbol('owned-provider-tree');
/** Capability minted by this runtime only; a persisted PID is never a replacement. */
export interface RuntimeOwnedProviderTree {
  readonly [ownedProviderTreeBrand]: true;
}
export interface RuntimeOwnedProviderLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}
export interface RuntimeOwnedProviderObservation {
  readonly state: 'running' | 'drained' | 'unknown';
  readonly leaderExitCode: number | null;
  readonly stdioClosed: boolean;
}
export interface RuntimeOwnedProviderProcess {
  readonly handle: RuntimeOwnedProviderTree;
  readonly pid: number;
  readonly identity: string;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly write: (bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  readonly closeInput: () => Promise<void>;
}
export interface OwnedProviderBackend extends Omit<RuntimeOwnedProviderProcess, 'handle'> {
  readonly observe: () => RuntimeOwnedProviderObservation;
  readonly terminate: (mode: 'terminate' | 'kill') => void;
  readonly close: () => void;
}
