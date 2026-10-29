import type {Threadnote5ReleaseScenario, Threadnote5SourceV1} from './threadnote-5-release-readiness-contract.js';
import type {Threadnote5LocalAuthorityEntryV1} from './threadnote-5-release-readiness-authority.js';
import type {Threadnote5MeasurementV1} from './threadnote-5-release-readiness-contract.js';
import type {Threadnote5FirstBriefLinkV1} from './threadnote-5-release-readiness-context-brief.js';
import type {
  Threadnote5ActivationValueLinkV1,
  Threadnote5FeedbackTrialLinkV1,
} from './threadnote-5-release-readiness-value-report.js';

export const SOURCE_KINDS = [
  'activation',
  'closeout',
  'context-brief',
  'context-check',
  'context-health',
  'git-proposal',
  'guidance',
  'migration',
  'procedure',
  'recall',
  'sharing',
  'value-report',
] as const;

export type Threadnote5LocalSourceKindV1 = (typeof SOURCE_KINDS)[number];

/**
 * Private, short-lived source material used to derive content-free release evidence.
 * The digest binds the artifact to one scenario and one exact candidate runtime.
 */
export interface Threadnote5LocalSubsystemReceiptRecordV1 {
  readonly artifact: unknown;
  readonly candidate: Threadnote5SourceV1;
  readonly digest: string;
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly version: typeof import('./threadnote-5-release-readiness-receipts.js').THREADNOTE_5_LOCAL_SUBSYSTEM_RECEIPT_VERSION;
}

/** A narrow observer supplied by the offline harness around the production activation flow. */
export interface Threadnote5OfflineNetworkObserverV1 {
  readonly attemptedNetworkActivityCount: () => number;
}

export interface Threadnote5ScenarioReceiptVerificationV1 {
  readonly missingKinds: readonly string[];
  readonly scenario: Threadnote5ReleaseScenario;
  readonly state: 'unknown' | 'verified';
  readonly verifiedKinds: readonly string[];
}

export type Threadnote5LocalReceiptVerificationV1 =
  | {
      readonly reason: 'records-invalid' | 'records-unavailable' | 'records-mismatched' | 'verifier-incomplete';
      readonly scenarios: readonly Threadnote5ScenarioReceiptVerificationV1[];
      readonly state: 'unknown';
    }
  | {
      readonly authorityManifestHash: string | null;
      readonly receiptCount: number;
      readonly recordsHash: string;
      readonly scenarios: readonly Threadnote5ScenarioReceiptVerificationV1[];
      readonly state: 'verified';
    };

export interface Threadnote5DerivedScenarioClaimsV1 {
  readonly assertions: readonly string[];
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly metricContributingKinds: readonly Threadnote5LocalSourceKindV1[];
  readonly missingKinds: readonly string[];
  readonly scenario: Threadnote5ReleaseScenario;
  readonly subsystemReceipts: readonly {
    readonly digest: string;
    readonly kind: Threadnote5LocalSourceKindV1;
  }[];
}

export interface Threadnote5DerivedLocalReceiptSetV1 {
  readonly authorityManifestHash: string;
  readonly records: readonly Threadnote5LocalSubsystemReceiptRecordV1[];
  readonly scenarios: readonly Threadnote5DerivedScenarioClaimsV1[];
}

export interface DerivedClaims {
  readonly assertions: readonly string[];
  readonly correlations?: Threadnote5DerivedCorrelationsV1;
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

export interface Threadnote5SecondSurfaceLinkV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly decisionCanonicalUri: string;
  readonly decisionContentHash: string;
  readonly decisionMemoryId: string;
  readonly proofHash: string;
  readonly publicationReceiptHash: string;
}

export interface Threadnote5SharedDecisionLinkV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly decisionCanonicalUri: string;
  readonly decisionContentHash: string;
  readonly decisionMemoryId: string;
  readonly publicationReceiptHash: string;
}

export interface Threadnote5DerivedCorrelationsV1 {
  readonly activationValues?: readonly Threadnote5ActivationValueLinkV1[];
  readonly feedbackTrials?: readonly Threadnote5FeedbackTrialLinkV1[];
  readonly firstBriefs?: readonly Threadnote5FirstBriefLinkV1[];
  readonly secondSurfaceProofs?: readonly Threadnote5SecondSurfaceLinkV1[];
  readonly sharedDecisions?: readonly Threadnote5SharedDecisionLinkV1[];
}

type Threadnote5AuthorityRequirementV1 =
  | 'activation-live-verification-authority'
  | 'context-brief-plan-citation-authority'
  | 'context-check-read-fence-authority'
  | 'context-health-schedule-authority'
  | 'context-health-team-aggregate-authority'
  | 'guidance-stale-precondition-rejection-authority'
  | 'migration-execution-authority'
  | 'git-proposal-review-authority'
  | 'procedure-execution-authority'
  | 'value-report-trial-authority';

export interface Threadnote5LocalReceiptAdapterV1 {
  readonly acceptedScenarios: readonly Threadnote5ReleaseScenario[];
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly requiredAuthority: readonly Threadnote5AuthorityRequirementV1[];
  readonly authorityType?: (
    record: Threadnote5LocalSubsystemReceiptRecordV1,
  ) => Threadnote5LocalAuthorityEntryV1['type'] | undefined;
  readonly derive: (
    record: Threadnote5LocalSubsystemReceiptRecordV1,
    authority: Threadnote5LocalAuthorityEntryV1 | undefined,
  ) => DerivedClaims;
}
