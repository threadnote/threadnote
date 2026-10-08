import type {MemoryMetadata} from '@threadnote/memory/document';
import type {DeferredCodeAnchorWriteRequest} from './deferred/code_anchor.js';

export interface StoreMemoryOptions {
  /** Internal create fence for a new reviewed result; cannot replace a concurrent destination. */
  readonly createOnly?: boolean;
  /** Internal deterministic archive destination; retries may reuse identical bytes only. */
  readonly consolidationArchiveKey?: string;
  readonly bodyText: string;
  readonly dryRun: boolean;
  readonly deferredCodeAnchor?: DeferredCodeAnchorWriteRequest;
  readonly expectedReplaceContent?: string;
  readonly expectedReplaceMemoryId?: string;
  readonly expectedReplaceRawContent?: string;
  readonly expectedSourceContent?: readonly {
    readonly allowedUriScopes?: readonly string[];
    readonly content: string;
    readonly memoryId?: string;
    readonly uri: string;
  }[];
  /** Composite mutations refresh once from their final state after every enclosing lock is released. */
  readonly deferRecallIndexRefresh?: boolean;
  /** Nested lifecycle writers already hold the source lock and skip the identity fence to avoid lock inversion. */
  readonly skipMemoryIdentityLock?: boolean;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
  readonly title: 'MEMORY' | 'HANDOFF';
}
