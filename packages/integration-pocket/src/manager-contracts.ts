export interface PocketSource {
  readonly id: string;
  readonly enabled: boolean;
  readonly project: string | null;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly credentialConfigured: boolean;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
  readonly status: 'active' | 'needs-sync' | 'needs-attention';
  readonly recordings: number;
  readonly chunks: number;
  readonly lastSyncedAt?: number;
  readonly nextAttemptAt?: number;
  readonly progress?: {readonly page: number; readonly offset: number};
}
