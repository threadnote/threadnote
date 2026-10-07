export interface RuntimeReleaseNotes {
  readonly version: string;
  readonly title: string;
  readonly body: string;
}

export interface RuntimeUpdateJob {
  readonly status: 'running' | 'completed' | 'failed';
  readonly message: string;
  readonly output?: string;
}

export interface RuntimeUpdates {
  readonly installedVersion: string;
  readonly runningVersion: string;
  readonly channel: 'latest' | 'beta';
  readonly developmentBuild: boolean;
  readonly restartRequired: boolean;
  readonly policy: 'automatic' | 'notify';
  readonly policyManaged: boolean;
  readonly automaticRunning: boolean;
  readonly automaticFailure?: string;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly checkedAt?: string;
  readonly checkError?: string;
  readonly notesError?: string;
  readonly installedNotes: readonly RuntimeReleaseNotes[];
  readonly availableNotes: readonly RuntimeReleaseNotes[];
  readonly job?: RuntimeUpdateJob;
}
