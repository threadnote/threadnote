export interface SuperhumanDocumentSelection {
  readonly id: string;
  readonly pages?: readonly string[];
}

export interface ResolvedSuperhumanSelection {
  readonly documents: readonly SuperhumanDocumentSelection[];
  readonly selections: readonly {
    readonly documentId: string;
    readonly pageId?: string;
    readonly name: string;
    readonly browserLink?: string;
    readonly iconUrl?: string;
  }[];
}
