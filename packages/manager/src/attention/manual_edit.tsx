import React, {useRef, useState} from 'react';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent, declaresReviewedSupportHeader} from '@threadnote/memory/document';
import {api, errorMessage} from '../ui/support.js';
import type {MemoryResponse} from '../ui/contracts.js';
import {AutomaticMemoryReviewDialog} from './automatic_review.js';
import type {ManagerAutomaticReview} from './topic_contracts.js';
import {memoryDocumentParts} from '../library_model.js';

/** Holds the authored draft until the existing acceptance controller verifies the exact write. */
export function useManualSupportEdit(props: {
  readonly selectedUri?: string;
  readonly onError: (message: string) => void;
  readonly onApplied: (uri: string) => void;
}) {
  const [review, setReview] = useState<ManagerAutomaticReview>();
  const lastRead = useRef<Pick<ManagerAutomaticReview, 'project' | 'reviewId' | 'revision' | 'targetUri'> | undefined>(
    undefined,
  );
  const selection = useRef(props.selectedUri);
  selection.current = props.selectedUri;
  const epoch = useRef(0);
  const previous = useRef(props.selectedUri);
  if (previous.current !== props.selectedUri) {
    previous.current = props.selectedUri;
    epoch.current++;
  }
  return {
    pending: !!review && review.targetUri === props.selectedUri,
    preview: async (memory: MemoryResponse | undefined, content: string, project: string) => {
      if (!memory || (!memory.record?.metadata.reviewedSupport && !declaresReviewedSupportHeader(memory.content)))
        return false;
      if (memoryDocumentParts(memory.content).body === memoryDocumentParts(content).body) return false;
      const uri = memory.node.uri;
      const requestEpoch = epoch.current;
      const projectName = memory.record?.metadata.project ?? (project || 'unscoped');
      const expectedContentHash = sha256HexSync(canonicalMemoryDocumentContent(memory.content));
      try {
        const result = await api<ManagerAutomaticReview>('/api/attention/automatic-review', {
          action: 'manual-preview',
          project: projectName,
          uri,
          expectedContentHash,
          desiredContent: content,
          ...(lastRead.current?.targetUri === uri
            ? {reviewId: lastRead.current.reviewId, revision: lastRead.current.revision}
            : {}),
        });
        if (
          result.kind !== 'automatic-memory-review' ||
          result.project !== projectName ||
          result.targetUri !== uri ||
          result.targetHash !== expectedContentHash
        )
          throw new Error(
            'The memory changed before its support-aware preview. Reload the exact memory and try again.',
          );
        if (
          selection.current === uri &&
          epoch.current === requestEpoch &&
          result.kind === 'automatic-memory-review' &&
          result.targetUri === uri
        ) {
          lastRead.current = result;
          setReview(result);
        }
      } catch (cause) {
        if (selection.current === uri && epoch.current === requestEpoch) props.onError(errorMessage(cause));
      }
      return true;
    },
    dialog:
      review && props.selectedUri === review.targetUri ? (
        <AutomaticMemoryReviewDialog
          key={`${review.project}:${review.reviewId}`}
          project={review.project}
          reviewId={review.reviewId}
          initialReview={review}
          onRead={result => {
            lastRead.current = result;
          }}
          onIdentity={identity => {
            const prior = lastRead.current;
            if (
              selection.current === review.targetUri &&
              prior?.targetUri === review.targetUri &&
              prior.project === identity.project &&
              prior.reviewId === identity.reviewId &&
              identity.revision >= prior.revision
            )
              lastRead.current = {...prior, revision: identity.revision};
          }}
          onClose={() => setReview(undefined)}
          onApplied={result => {
            if (selection.current === result.targetUri) {
              setReview(undefined);
              props.onApplied(result.targetUri);
            }
          }}
        />
      ) : null,
  };
}
