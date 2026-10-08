import type {RawContractObservation} from './probe.js';

const safeKeys = new Set([
  'uri',
  'documentUri',
  'docUri',
  'pageUri',
  'id',
  'type',
  'content',
  'text',
  'result',
  'data',
  'pages',
  'page',
  'items',
  'blocks',
  'markdownBlocks',
  'markdown',
  'metadata',
  'document',
  'count',
  'total',
  'totalCount',
  'totalPages',
  'pageCount',
  'markdownBlockCount',
  'offset',
  'limit',
  'nextCursor',
  'hasMore',
  'isTruncated',
  'truncated',
  'hidden',
  'isHidden',
  'revision',
  'version',
  'modifiedAt',
  'updatedAt',
  'createdAt',
  'nextOffset',
]);
const numericKeys = new Set([
  'count',
  'total',
  'totalCount',
  'totalPages',
  'pageCount',
  'markdownBlockCount',
  'offset',
  'limit',
  'nextOffset',
]);
const booleanKeys = new Set(['hasMore', 'isTruncated', 'truncated', 'hidden', 'isHidden']);

function summarize(value: unknown) {
  const paths: Array<{path: string; kind: string; count?: number; value?: boolean | number}> = [];
  const visit = (item: unknown, path: string, key: string, depth: number) => {
    if (paths.length >= 160 || depth > 7) return;
    if (Array.isArray(item)) {
      paths.push({path, kind: 'array', count: item.length});
      if (item.length > 0) visit(item[0], `${path}[]`, '', depth + 1);
    } else if (item !== null && typeof item === 'object') {
      const entries = Object.entries(item);
      paths.push({path, kind: 'object', count: entries.length});
      for (const [childKey, child] of entries) {
        const label = safeKeys.has(childKey) ? childKey : '<field>';
        visit(child, `${path}.${label}`, childKey, depth + 1);
      }
    } else {
      const kind = item === null ? 'null' : typeof item;
      const safeValue =
        numericKeys.has(key) && typeof item === 'number' && Number.isSafeInteger(item)
          ? item
          : booleanKeys.has(key) && typeof item === 'boolean'
            ? item
            : undefined;
      paths.push({path, kind, ...(safeValue === undefined ? {} : {value: safeValue})});
    }
  };
  visit(value, '$', '', 0);
  const text = typeof value === 'string' ? value : '';
  return {
    paths,
    ...(text.length === 0
      ? {}
      : {
          guideSignals: {
            mentionsPagination: /paginat|offset|limit/i.test(text),
            mentionsTruncation: /truncat|incomplete/i.test(text),
            mentionsMarkdown: /markdown/i.test(text),
            mentionsRevision: /revision|version/i.test(text),
          },
        }),
  };
}

export function summarizeContractObservation(stage: 'identity' | 'primary', observation: RawContractObservation) {
  return {
    stage,
    contractStatus: 'unverified',
    ...(observation.protocolVersion === undefined ? {} : {protocolVersion: observation.protocolVersion}),
    scopeMatched: observation.scopeMatched,
    ...(observation.identitySignals === undefined ? {} : {identitySignals: observation.identitySignals}),
    calls: observation.calls.map(call => ({name: call.name, ...summarize(call.value)})),
  };
}
