import type {SuperhumanDocumentSelection} from './selection-contracts.js';
export type {SuperhumanDocumentSelection, ResolvedSuperhumanSelection} from './selection-contracts.js';
export interface SuperhumanSource {
  readonly id: string;
  readonly enabled: boolean;
  readonly project: string | null;
  readonly documents: readonly SuperhumanDocumentSelection[];
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly credentialConfigured: boolean;
  readonly includeHidden: boolean;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
  readonly status: 'active' | 'needs-sync' | 'needs-attention';
  readonly chunks: number;
  readonly lastSyncedAt?: number;
  readonly nextAttemptAt?: number;
}

export type SuperhumanAction =
  'save-source' | 'sync-source' | 'remove-source' | 'set-enabled' | 'resolve-links' | 'describe-selection';
