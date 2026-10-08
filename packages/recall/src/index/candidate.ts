import {isExternalResourceUri, parseExternalResource} from '@threadnote/store/external-resource';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  parseMemoryDocument,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {redactSensitiveText} from '@threadnote/platform/scrubber';
import {identifiers, stripRecallAnchor} from './lexical.js';
import {recallMemoryContentHash, type RecallCandidate} from '../rank.js';
import {normalizeRecallSearchText} from '../tokenize.js';
import {recallCandidateIsEligible, type RecallEligibilityPolicy} from '../eligibility.js';

export function indexCandidate(
  uri: string,
  content: string,
  canonicalResource: boolean,
  memory = parseMemoryDocument(uri, content),
  externalFetchedAt?: number,
): RecallCandidate {
  if (isExternalResourceUri(uri)) {
    const external = parseExternalResource(uri, content);
    const text = redactSensitiveText(external?.body ?? '');
    return {
      authority: 'external',
      trust: 'untrusted',
      uri,
      text,
      contentHash: sha256HexSync(content),
      ...(external !== undefined && externalFetchedAt !== undefined
        ? {externalSource: {...external.metadata, fetchedAt: externalFetchedAt}}
        : {}),
      fields: {
        identifiers: identifiers(text),
        project: external?.metadata.project ?? undefined,
        title: external?.metadata.title ?? uriBasename(uri),
        topic: 'superhuman-docs',
      },
    };
  }
  const text = redactSensitiveText(memory?.body ?? content);
  const fields = {
    identifiers: identifiers(text),
    keywords: memory?.metadata.keywords,
    project: memory?.metadata.project ?? resourceProject(uri),
    title: firstHeading(text) ?? uriBasename(uri),
    topic: memory?.metadata.topic ?? uriTopic(uri),
    workspaceScope: memory?.metadata.workspaceScope,
  };
  return {
    authority: boundedMemoryAuthority(uri, memory?.metadata, {canonicalResource}),
    contentHash: memory ? recallMemoryContentHash(memory.body) : undefined,
    fields,
    kind: memory?.metadata.kind,
    memoryId: memory?.metadata.memoryId,
    relations: memoryRelations(memory),
    status: memory?.metadata.status,
    text,
    timestamp: memory?.metadata.timestamp,
    trust: boundedMemoryTrust(uri, memory?.metadata, {canonicalResource}),
    uri,
    validFrom: memory?.metadata.validFrom,
    validTo: memory?.metadata.validTo,
  };
}

/** Exact search uses document text and discovery fields, excluding machine headers. */
export function recallExactSearchText(candidate: RecallCandidate): string {
  const fields = candidate.fields;
  return normalizeRecallSearchText(
    redactSensitiveText(
      [
        candidate.text,
        fields?.title,
        fields?.topic,
        fields?.project,
        fields?.workspaceScope,
        ...(fields?.keywords ?? []),
      ]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join('\n'),
    ),
  );
}

export function recallIndexCandidateIsEligible(
  policy: RecallEligibilityPolicy | undefined,
  candidate: RecallCandidate,
): boolean {
  if (
    isExternalResourceUri(candidate.uri) &&
    (candidate.authority !== 'external' ||
      candidate.trust !== 'untrusted' ||
      candidate.contentHash === undefined ||
      policy?.externalResources?.[stripRecallAnchor(candidate.uri)] !== candidate.contentHash)
  )
    return false;
  return (
    policy === undefined ||
    recallCandidateIsEligible(policy, {
      authority: candidate.authority,
      project: candidate.fields?.project,
      trust: candidate.trust,
    })
  );
}

function memoryRelations(memory: ReturnType<typeof parseMemoryDocument>): readonly MemoryRelation[] | undefined {
  if (!memory) return undefined;
  const relations: MemoryRelation[] = [
    ...(memory.metadata.relations ?? []),
    ...(memory.metadata.references ?? []).map(uri => ({type: 'references' as const, uri})),
    ...(memory.metadata.evidence ?? [])
      .filter(evidence => evidence.startsWith('threadnote://'))
      .map(uri => ({type: 'evidence_for' as const, uri})),
    ...(memory.metadata.supersedes ? [{type: 'supersedes' as const, uri: memory.metadata.supersedes}] : []),
  ];
  return relations.length > 0 ? relations : undefined;
}

function firstHeading(value: string): string | undefined {
  return /^#{1,3}[ \t]+(\S.*)$/m.exec(value)?.[1]?.trim();
}

function resourceProject(uri: string): string | undefined {
  return /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
}

function uriTopic(uri: string): string {
  return uriBasename(uri).replace(/\.[a-z0-9]+$/i, '');
}

function uriBasename(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}
