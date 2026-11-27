import type {Effect} from 'effect';
import type {CodeGraphQueryResult, CodeGraphSpan, RepositoryIdentity} from '@threadnote/graph/types';
import type {ReadDeadline} from '@threadnote/platform/read_deadline';
import type {NavigationInput, NavigationScope} from './model.js';

/** One structural declaration the navigate lane asks the semantic adapter to query. */
export interface NavigationSemanticAnchorV1 {
  /** Candidate id in `input.candidates`; semantic links attach to this candidate. */
  readonly candidateId: string;
  /** Repository-relative POSIX path, as in the graph. */
  readonly path: string;
  /** Graph content hash of the file the span comes from. */
  readonly contentHash: string;
  /** Declared simple name; the adapter places the LSP position on it inside `span`. */
  readonly name: string;
  /** One-based UTF-16 graph declaration span. */
  readonly span: CodeGraphSpan;
}

export interface NavigationSemanticRequestV1 {
  /** Absolute repository-scope cwd of the request. Worksets never call the semantic dependency. */
  readonly callerCwd: string;
  /** The requested navigation scope; the result must keep it. */
  readonly scope: NavigationScope;
  /** Repository identity of the structural read; callerCwd can be a subdirectory, so it is not a substitute. */
  readonly identity: RepositoryIdentity;
  /** Ready graph observation the structural read used; the disk join binds to this snapshot and head commit. */
  readonly observation: Pick<CodeGraphQueryResult, 'repository' | 'snapshot' | 'freshness'>;
  /** Structural input after task discovery and source-proof admission. */
  readonly input: NavigationInput;
  /** At most two anchors, in lane priority order. Never empty. */
  readonly anchors: readonly NavigationSemanticAnchorV1[];
  /** The semantic sub-deadline: min(request start + 1500 ms, parent deadline). It is never extended. */
  readonly deadline: ReadDeadline;
}

/**
 * Optional semantic enrichment of one structural navigation input, implemented by the application.
 *
 * - Returns the same input with semantic sources, candidates, links, gaps and follow-ups added, or the same
 *   input with gaps only. It never fails and never removes structural evidence.
 * - Starts nothing: no coordinator, provider session, readiness job, installation, download or write. A provider
 *   that is not running gives the gap `semantic-provider-not-running`.
 * - Uses only the saved-disk view and the worktree host profile as authorization.
 * - Ends by `deadline`; interruption stops it with no detached work.
 *
 * The lane reassembles the result through the navigation assembler, so admission and limits still apply.
 */
export type NavigationSemanticDependency<R = never> = (
  request: NavigationSemanticRequestV1,
) => Effect.Effect<NavigationInput, never, R>;
