import * as EffectRecord from 'effect/Record';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {Predicate} from 'effect';
import type {
  CodeGraphBodyDiscovery,
  CodeGraphBodyDiscoveryRecord,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../types.js';

export const BODY_DISCOVERY_POLICY = 'body-discovery-v3-owner-presence-utf16-cursor-combined-64k';
export const BODY_DISCOVERY_PREFIX = '~body:v1:';
export const BODY_DISCOVERY_WORK_BYTES = 65_536;
export const BODY_DISCOVERY_WINDOW_BYTES = 4_096;
export const BODY_DISCOVERY_OWNERS = 128;
export const BODY_DISCOVERY_RECORD_BYTES = 65_536;

export function discoveryTerms(value: string): readonly string[] {
  return [
    ...new Set(
      EffectOption.getOrNull(
        EffectString.match(/[\p{L}\p{N}_$.-]{2,}/gu)(
          EffectString.toLowerCase(
            EffectString.replace(
              /([A-Z]+)([A-Z][a-z])/g,
              '$1 $2',
            )(EffectString.replace(/([a-z0-9])([A-Z])/g, '$1 $2')(EffectString.normalize('NFKC')(value))),
          ),
        ),
      ) ?? [],
    ),
  ].slice(0, 32);
}

const position = (span: CodeGraphSpan) => ({line: span.line, column: span.column});
function compare(
  left: {readonly line: number; readonly column: number},
  right: {readonly line: number; readonly column: number},
): number {
  return left.line - right.line || left.column - right.column;
}
function validSpan(span: CodeGraphSpan): boolean {
  return (
    EffectArray.every([span.line, span.column, span.endLine, span.endColumn], n => Number.isSafeInteger(n) && n > 0) &&
    compare(position(span), {line: span.endLine, column: span.endColumn}) < 0
  );
}
function sameSpan(a: CodeGraphSpan, b: CodeGraphSpan): boolean {
  return a.line === b.line && a.column === b.column && a.endLine === b.endLine && a.endColumn === b.endColumn;
}
function ownerMatches(
  body: CodeGraphBodyDiscovery,
  record: CodeGraphBodyDiscoveryRecord,
  symbol: CodeGraphSymbol | undefined,
): boolean {
  return (
    symbol !== undefined &&
    (symbol.kind === 'function' || symbol.kind === 'method') &&
    symbol.id === record.ownerId &&
    symbol.path === body.path &&
    symbol.contentHash === body.contentHash &&
    sameSpan(symbol.span, record.ownerSpan)
  );
}

/** One monotonic locator; window reads are separately charged, including overlaps. No source survives this call. */
export function captureBodyDiscovery(file: CodeGraphInventoryFile, facts: CodeGraphFileFacts): CodeGraphFileFacts {
  const owners = EffectArray.filter(facts.symbols, s => s.kind === 'function' || s.kind === 'method');
  // No path-bound body evidence is needed without owners. Preserve other derivation inputs unchanged.
  if (owners.length === 0) return facts;
  const records: CodeGraphBodyDiscoveryRecord[] = [];
  const omissions = new Set<string>();
  let workBytes = 0;
  let index = 0;
  let line = 1;
  let column = 1;
  const source = file.content;
  const body = (): CodeGraphBodyDiscovery => ({
    version: 1,
    policy: BODY_DISCOVERY_POLICY,
    path: facts.path,
    contentHash: file.contentHash,
    records,
    workBytes,
    omissions: [...omissions].sort(),
  });
  if (source === undefined || facts.path !== file.path) omissions.add('source-unavailable');
  else {
    owners.sort((a, b) => compare(a.span, b.span) || EffectString.localeCompare(b.id)(a.id));
    const ownerCounts = new Map<string, number>();
    for (const owner of owners) ownerCounts.set(owner.id, (ownerCounts.get(owner.id) ?? 0) + 1);
    if (owners.length > BODY_DISCOVERY_OWNERS) omissions.add('owner-limit');
    for (const owner of owners.slice(0, BODY_DISCOVERY_OWNERS)) {
      if (
        ownerCounts.get(owner.id) !== 1 ||
        owner.id.length > 256 ||
        owner.path !== file.path ||
        owner.contentHash !== file.contentHash ||
        !validSpan(owner.span)
      ) {
        omissions.add('owner-identity');
        continue;
      }
      // Admit the maximum UTF-8 width before inspecting even a single code point.
      while (
        compare({line, column}, owner.span) < 0 &&
        index < source.length &&
        workBytes + 4 <= BODY_DISCOVERY_WORK_BYTES
      ) {
        const point = EffectOption.getOrUndefined(EffectString.codePointAt(index)(source))!;
        const units = point > 0xffff ? 2 : 1;
        workBytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : units === 2 ? 4 : 3;
        index += units;
        if (point === 10) {
          line += 1;
          column = 1;
        } else column += units;
      }
      if (compare({line, column}, owner.span) !== 0) {
        omissions.add('location-budget-or-span');
        continue;
      }
      let end = index;
      let endLine = line;
      let endColumn = column;
      let bytes = 0;
      const target = {line: owner.span.endLine, column: owner.span.endColumn};
      while (
        compare({line: endLine, column: endColumn}, target) < 0 &&
        end < source.length &&
        bytes + 4 <= BODY_DISCOVERY_WINDOW_BYTES &&
        workBytes + bytes + 8 <= BODY_DISCOVERY_WORK_BYTES
      ) {
        const point = EffectOption.getOrUndefined(EffectString.codePointAt(end)(source))!;
        const units = point > 0xffff ? 2 : 1;
        const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : units === 2 ? 4 : 3;
        bytes += width;
        workBytes += width;
        end += units;
        if (point === 10) {
          endLine += 1;
          endColumn = 1;
        } else endColumn += units;
      }
      if (
        compare({line: endLine, column: endColumn}, target) > 0 ||
        end === index ||
        (end === source.length && compare({line: endLine, column: endColumn}, target) < 0)
      ) {
        omissions.add('invalid-window');
        continue;
      }
      if (compare({line: endLine, column: endColumn}, target) < 0) omissions.add('window-limit');
      // Endpoint scanning and copying/tokenization are separate source work.
      workBytes += bytes;
      const terms = EffectArray.filter(
        discoveryTerms(EffectString.slice(index, end)(source)),
        term => Buffer.byteLength(term, 'utf8') <= 128,
      ).sort();
      const record = {ownerId: owner.id, ownerSpan: owner.span, window: {line, column, endLine, endColumn}, terms};
      // Serialized evidence is bounded independently of source work. The transient serialization includes the already bounded accumulated records.
      if (
        Buffer.byteLength(JSON.stringify({...body(), records: [...records, record]}), 'utf8') >
        BODY_DISCOVERY_RECORD_BYTES - 1_024
      ) {
        omissions.add('record-bytes');
        continue;
      }
      records.push(record);
    }
  }
  return {...facts, derivationInputs: {...facts.derivationInputs, bodyDiscovery: body()}};
}

/** Strict private boundary, including exact owner-ID attribution. Never guess by name or span. */
export function validateBodyDiscovery(
  value: unknown,
  path: string,
  symbols: readonly CodeGraphSymbol[],
  ownerIndex?: ReadonlyMap<string, CodeGraphSymbol>,
): CodeGraphBodyDiscovery {
  const fail = (): never => {
    throw new Error('Invalid private body discovery evidence.');
  };
  if (!Predicate.isObject(value)) return fail();
  const input = value;
  if (
    EffectArray.join(EffectRecord.keys(input).sort(), ',') !==
      'contentHash,omissions,path,policy,records,version,workBytes' ||
    input.version !== 1 ||
    input.policy !== BODY_DISCOVERY_POLICY ||
    input.path !== path ||
    typeof input.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.contentHash) ||
    typeof input.workBytes !== 'number' ||
    !Number.isSafeInteger(input.workBytes) ||
    input.workBytes < 0 ||
    input.workBytes > BODY_DISCOVERY_WORK_BYTES ||
    !EffectArray.isArray(input.records) ||
    input.records.length > BODY_DISCOVERY_OWNERS ||
    !EffectArray.isArray(input.omissions) ||
    input.omissions.length > 16
  )
    return fail();
  const omissions: string[] = [];
  for (const reason of input.omissions) {
    if (typeof reason !== 'string' || !/^[a-z-]{1,48}$/.test(reason)) return fail();
    omissions.push(reason);
  }
  const readSpan = (value: unknown): CodeGraphSpan => {
    if (
      !Predicate.isObject(value) ||
      EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'column,endColumn,endLine,line' ||
      typeof value.line !== 'number' ||
      typeof value.column !== 'number' ||
      typeof value.endLine !== 'number' ||
      typeof value.endColumn !== 'number'
    )
      return fail();
    const span = {line: value.line, column: value.column, endLine: value.endLine, endColumn: value.endColumn};
    if (!validSpan(span)) return fail();
    return span;
  };
  const records: CodeGraphBodyDiscoveryRecord[] = [];
  for (const record of input.records) {
    if (
      !Predicate.isObject(record) ||
      EffectArray.join(EffectRecord.keys(record).sort(), ',') !== 'ownerId,ownerSpan,terms,window' ||
      typeof record.ownerId !== 'string' ||
      record.ownerId.length > 256 ||
      !EffectArray.isArray(record.terms) ||
      record.terms.length > 32
    )
      return fail();
    const terms: string[] = [];
    for (const term of record.terms) {
      if (
        typeof term !== 'string' ||
        term.length > 128 ||
        Buffer.byteLength(term, 'utf8') > 128 ||
        discoveryTerms(term).length !== 1 ||
        discoveryTerms(term)[0] !== term
      )
        return fail();
      terms.push(term);
    }
    if (new Set(terms).size !== terms.length) return fail();
    records.push({
      ownerId: record.ownerId,
      ownerSpan: readSpan(record.ownerSpan),
      window: readSpan(record.window),
      terms,
    });
  }
  const body: CodeGraphBodyDiscovery = {
    version: 1,
    policy: BODY_DISCOVERY_POLICY,
    path,
    contentHash: input.contentHash,
    workBytes: input.workBytes,
    omissions,
    records,
  };
  const byId = ownerIndex ?? new Map(EffectArray.map(symbols, symbol => [symbol.id, symbol]));
  const ids = new Set<string>();
  for (const record of records) {
    if (
      ids.has(record.ownerId) ||
      compare(record.window, record.ownerSpan) !== 0 ||
      compare(
        {line: record.window.endLine, column: record.window.endColumn},
        {line: record.ownerSpan.endLine, column: record.ownerSpan.endColumn},
      ) > 0 ||
      !ownerMatches(body, record, byId.get(record.ownerId))
    )
      return fail();
    ids.add(record.ownerId);
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > BODY_DISCOVERY_RECORD_BYTES) return fail();
  return body;
}

/** Existing attributors preserve IDs; close only over the explicit surviving identity map. */
export function closeBodyDiscovery(
  body: CodeGraphBodyDiscovery,
  symbols: readonly CodeGraphSymbol[],
  ownerIndex?: ReadonlyMap<string, CodeGraphSymbol>,
): CodeGraphBodyDiscovery {
  const byId = ownerIndex ?? new Map(EffectArray.map(symbols, symbol => [symbol.id, symbol]));
  const records = EffectArray.filter(body.records, record => ownerMatches(body, record, byId.get(record.ownerId)));
  return {
    ...body,
    records,
    omissions:
      records.length === body.records.length
        ? body.omissions
        : [...new Set([...body.omissions, 'owner-omitted'])].sort(),
  };
}
