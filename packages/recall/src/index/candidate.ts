import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
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
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

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
        topic: external?.metadata.provider === 'pocket' ? 'pocket-recordings' : 'superhuman-docs',
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
      EffectArray.join(
        EffectArray.filter(
          [
            candidate.text,
            fields?.title,
            fields?.topic,
            fields?.project,
            fields?.workspaceScope,
            ...(fields?.keywords ?? []),
          ],
          (value): value is string => value !== undefined && value.length > 0,
        ),
        '\n',
      ),
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
      kind: candidate.kind,
      project: candidate.fields?.project,
      trust: candidate.trust,
    })
  );
}

function memoryRelations(memory: ReturnType<typeof parseMemoryDocument>): readonly MemoryRelation[] | undefined {
  if (!memory) return undefined;
  const relations: MemoryRelation[] = [
    ...(memory.metadata.relations ?? []),
    ...EffectArray.map(memory.metadata.references ?? [], uri => ({type: 'references' as const, uri})),
    ...EffectArray.map(
      EffectArrayPipe(memory.metadata.evidence ?? [], __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (evidence, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            Effect.pipe(evidence, EffectString.startsWith('threadnote://')),
        ),
      ),
      uri => ({type: 'evidence_for' as const, uri}),
    ),
    ...(memory.metadata.supersedes ? [{type: 'supersedes' as const, uri: memory.metadata.supersedes}] : []),
  ];
  return relations.length > 0 ? relations : undefined;
}

function firstHeading(value: string): string | undefined {
  return Effect.pipe(/^#{1,3}[ \t]+(\S.*)$/m.exec(value)?.[1], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
}

function resourceProject(uri: string): string | undefined {
  return /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
}

function uriTopic(uri: string): string {
  return Effect.pipe(uriBasename(uri), EffectString.replace(/\.[a-z0-9]+$/i, ''));
}

function uriBasename(uri: string): string {
  return Effect.pipe(
    uri,
    EffectString.slice(
      Effect.pipe(
        uri,
        EffectString.lastIndexOf('/'),
        Effect.Option.getOrElse(() => -1),
      ) + 1,
    ),
  );
}
