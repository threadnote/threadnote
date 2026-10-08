export interface ContextMaintenanceReceiptV2 {
  readonly receiptId: string;
  readonly project: string;
  readonly subjectUri: string;
  readonly archivedUri?: string;
  readonly postHash: string;
  readonly timestamp: string;
  readonly state: 'applying' | 'applied' | 'undone' | 'conflict';
}

export interface ContextMaintenanceReadOptions {
  readonly limit?: number;
  readonly caseCursor?: string;
  readonly receiptCursor?: string;
  readonly caseId?: string;
  readonly receiptId?: string;
}
