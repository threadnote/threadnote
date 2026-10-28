import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {ConfigProvider, Effect, Layer, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {anonymousTelemetryLayer, withAnonymousTelemetry} from '@threadnote/threadnote/effect/telemetry';

import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';

describe('anonymous telemetry OTLP transport', () => {
  effectIt.effect('posts one traces-only protobuf envelope without private failure data', () => {
    const localServiceVersion = '4.2.2-local.g7a52016818f2accd497ee40e1f7c72e856e14857';
    const requests: Array<{
      readonly authorization: string | null;
      readonly baggage: string | null;
      readonly body: Uint8Array;
      readonly contentType: string | null;
      readonly path: string;
      readonly traceparent: string | null;
      readonly userAgent: string | null;
    }> = [];
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          fetch: async request => {
            requests.push({
              authorization: request.headers.get('authorization'),
              baggage: request.headers.get('baggage'),
              body: new Uint8Array(await request.arrayBuffer()),
              contentType: request.headers.get('content-type'),
              path: new URL(request.url).pathname,
              traceparent: request.headers.get('traceparent'),
              userAgent: request.headers.get('user-agent'),
            });
            return new Response(null, {status: 200});
          },
          hostname: '127.0.0.1',
          port: 0,
        }),
      ),
      server =>
        Effect.gen(function* () {
          const endpoint = `http://127.0.0.1:${server.port}/v1/traces`;
          yield* withAnonymousTelemetry(
            {component: 'cli', operation: 'graph-build'},
            Effect.withSpan(
              Effect.fail(TestError.make({message: 'secret at /Users/private/repository/graph.sqlite'})),
              'private-application-span',
              {attributes: {'private.path': '/Users/private/repository'}},
            ),
          ).pipe(
            Effect.exit,
            provideTestLayer(
              anonymousTelemetryLayer({
                correlationScope: 'invocation',
                endpoint,
                exportInterval: '1 millis',
                maxBatchSize: 1,
                serviceVersion: localServiceVersion,
                sessionId: 'tns_000102030405060708090a0b0c0d0e0f',
                shutdownTimeout: '1 second',
              }).pipe(Layer.provideMerge(TestSystemInfoLayer)),
            ),
          );

          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatchObject({
            authorization: null,
            baggage: null,
            contentType: 'application/x-protobuf',
            path: '/v1/traces',
            traceparent: null,
            userAgent: 'OTel-OTLP-Exporter-JavaScript-Effect-OtlpTracer/4.0.7',
          });
          const envelope = decodeTelemetryEnvelope(requests[0].body);
          expect(envelope.resourceAttributes).toEqual({
            'service.name': 'threadnote',
            'service.version': localServiceVersion,
            'session.id': 'tns_000102030405060708090a0b0c0d0e0f',
            'threadnote.session.scope': 'invocation',
            'threadnote.telemetry.schema_version': 6,
          });
          expect(envelope.scopeName).toBe('threadnote');
          expect(envelope.spanFieldNumbers).toEqual([1, 2, 5, 6, 7, 8, 9, 15]);
          expect(envelope.spanName).toBe('threadnote.anonymous-diagnostic');
          expect(envelope.spanKind).toBe(1);
          expect(envelope.traceId).toHaveLength(16);
          expect(envelope.spanId).toHaveLength(8);
          expect(envelope.startTimeUnixNano).toBeGreaterThan(0n);
          expect(envelope.endTimeUnixNano).toBeGreaterThanOrEqual(envelope.startTimeUnixNano);
          expect(envelope.status).toEqual({code: 1});
          expect(Object.keys(envelope.spanAttributes).sort()).toEqual([
            'error.type',
            'threadnote.component',
            'threadnote.duration_ms',
            'threadnote.event',
            'threadnote.invocation.id',
            'threadnote.memory.external.end_bucket',
            'threadnote.memory.external.start_bucket',
            'threadnote.memory.heap.end_bucket',
            'threadnote.memory.heap.start_bucket',
            'threadnote.memory.peak_rss.end_bucket',
            'threadnote.memory.peak_rss.start_bucket',
            'threadnote.memory.rss.end_bucket',
            'threadnote.memory.rss.start_bucket',
            'threadnote.operation',
            'threadnote.outcome',
            'threadnote.runtime.architecture',
            'threadnote.runtime.platform',
            'threadnote.runtime.version',
          ]);
          expect(envelope.spanAttributes).toMatchObject({
            'error.type': 'UnknownError',
            'threadnote.component': 'cli',
            'threadnote.event': 'completion',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'failure',
            'threadnote.runtime.architecture': process.arch,
            'threadnote.runtime.platform': process.platform,
            'threadnote.runtime.version': Bun.version,
          });
          expect(envelope.spanAttributes['threadnote.invocation.id']).toMatch(/^tni_[\da-f]{24}$/u);
          expect(envelope.spanAttributes['threadnote.duration_ms']).toBeTypeOf('number');
          for (const [key, value] of Object.entries(envelope.spanAttributes)) {
            if (key.startsWith('threadnote.memory.')) expect(value).toMatch(TELEMETRY_MEMORY_BUCKET);
          }
          const protobufText = new TextDecoder().decode(requests[0].body);
          expect(protobufText).toContain('threadnote.anonymous-diagnostic');
          expect(protobufText).toContain('threadnote.operation');
          expect(protobufText).toContain('graph-build');
          expect(protobufText).toContain('tns_000102030405060708090a0b0c0d0e0f');
          expect(protobufText).not.toContain('secret');
          expect(protobufText).not.toContain('/Users/private');
          expect(protobufText).not.toContain('graph.sqlite');
          expect(protobufText).not.toContain('private-host');
          expect(protobufText).not.toContain('private-application-span');
          expect(protobufText).not.toContain('private.path');
        }),
      server => Effect.promise(() => server.stop(true)),
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          OTEL_RESOURCE_ATTRIBUTES: 'host.name=private-host',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer private-token,baggage=private-baggage',
          OTEL_SERVICE_NAME: 'private-service',
          OTEL_SERVICE_VERSION: 'private-version',
        }),
      ),
      TestClock.withLive,
    );
  });

  effectIt.effect('drops a queued batch when consent is revoked before the transport flush', () => {
    const requests: Array<Uint8Array> = [];
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          fetch: async request => {
            requests.push(new Uint8Array(await request.arrayBuffer()));
            return new Response(null, {status: 200});
          },
          hostname: '127.0.0.1',
          port: 0,
        }),
      ),
      server =>
        Effect.gen(function* () {
          const enabled = yield* Ref.make(true);
          const layer = anonymousTelemetryLayer({
            correlationScope: 'broker',
            endpoint: `http://127.0.0.1:${server.port}/v1/traces`,
            exportInterval: '1 hour',
            isEnabled: Ref.get(enabled),
            maxBatchSize: 64,
            serviceVersion: 'test',
            sessionId: 'tns_000102030405060708090a0b0c0d0e0f',
            shutdownTimeout: '1 second',
          }).pipe(Layer.provideMerge(TestSystemInfoLayer));

          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(layer);
              yield* withAnonymousTelemetry(
                {component: 'mcp', operation: 'queued-before-revocation'},
                Effect.succeed('ok'),
              ).pipe(Effect.provide(context));
              expect(requests).toEqual([]);
              yield* Ref.set(enabled, false);
            }),
          );

          expect(requests).toEqual([]);
        }),
      server => Effect.promise(() => server.stop(true)),
    ).pipe(TestClock.withLive);
  });

  effectIt.effect('refuses to follow an OTLP redirect', () => {
    let endpointRequests = 0;
    let redirectedRequests = 0;
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          fetch: request => {
            const url = new URL(request.url);
            if (url.pathname === '/redirect-target') {
              redirectedRequests += 1;
              return new Response(null, {status: 200});
            }
            endpointRequests += 1;
            return Response.redirect(new URL('/redirect-target', url), 307);
          },
          hostname: '127.0.0.1',
          port: 0,
        }),
      ),
      server =>
        withAnonymousTelemetry({component: 'cli', operation: 'redirect-refusal'}, Effect.succeed('ok')).pipe(
          Effect.andThen(Effect.sleep('50 millis')),
          provideTestLayer(
            anonymousTelemetryLayer({
              correlationScope: 'invocation',
              endpoint: `http://127.0.0.1:${server.port}/v1/traces`,
              exportInterval: '1 hour',
              maxBatchSize: 1,
              serviceVersion: 'test',
              sessionId: 'tns_000102030405060708090a0b0c0d0e0f',
              shutdownTimeout: '100 millis',
            }).pipe(Layer.provideMerge(TestSystemInfoLayer)),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(endpointRequests).toBeGreaterThan(0);
              expect(redirectedRequests).toBe(0);
            }),
          ),
        ),
      server => Effect.promise(() => server.stop(true)),
    ).pipe(TestClock.withLive);
  });
});

const TELEMETRY_MEMORY_BUCKET =
  /^(?:<32MiB|32-64MiB|64-128MiB|128-256MiB|256-512MiB|512MiB-1GiB|1-2GiB|2-4GiB|>=4GiB)$/u;

type ProtoField =
  | {readonly wireType: 0; readonly value: bigint}
  | {readonly wireType: 1; readonly value: Uint8Array}
  | {readonly wireType: 2; readonly value: Uint8Array}
  | {readonly wireType: 5; readonly value: Uint8Array};

type ProtoMessage = ReadonlyMap<number, readonly ProtoField[]>;

interface DecodedTelemetryEnvelope {
  readonly endTimeUnixNano: bigint;
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scopeName: string;
  readonly spanAttributes: Readonly<Record<string, unknown>>;
  readonly spanFieldNumbers: readonly number[];
  readonly spanId: Uint8Array;
  readonly spanKind: number;
  readonly spanName: string;
  readonly startTimeUnixNano: bigint;
  readonly status: Readonly<{code: number}>;
  readonly traceId: Uint8Array;
}

/** Minimal schema-aware decoder: unknown OTLP fields fail the allowlist assertions below. */
function decodeTelemetryEnvelope(bytes: Uint8Array): DecodedTelemetryEnvelope {
  const traces = decodeProtoMessage(bytes);
  expect(fieldNumbers(traces)).toEqual([1]);
  const resourceSpans = embeddedField(traces, 1);
  expect(fieldNumbers(resourceSpans)).toEqual([1, 2]);

  const resource = embeddedField(resourceSpans, 1);
  expect(fieldNumbers(resource)).toEqual([1]);
  const resourceAttributes = decodeAttributes(resource, 1);

  const scopeSpans = embeddedField(resourceSpans, 2);
  expect(fieldNumbers(scopeSpans)).toEqual([1, 2]);
  const scope = embeddedField(scopeSpans, 1);
  expect(fieldNumbers(scope)).toEqual([1]);

  const span = embeddedField(scopeSpans, 2);
  const status = embeddedField(span, 15);
  expect(fieldNumbers(status)).toEqual([3]);
  return {
    endTimeUnixNano: fixed64Field(span, 8),
    resourceAttributes,
    scopeName: stringField(scope, 1),
    spanAttributes: decodeAttributes(span, 9),
    spanFieldNumbers: fieldNumbers(span),
    spanId: bytesField(span, 2),
    spanKind: numberField(span, 6),
    spanName: stringField(span, 5),
    startTimeUnixNano: fixed64Field(span, 7),
    status: {code: numberField(status, 3)},
    traceId: bytesField(span, 1),
  };
}

function decodeAttributes(message: ProtoMessage, fieldNumber: number): Readonly<Record<string, unknown>> {
  const attributes: Record<string, unknown> = {};
  for (const field of message.get(fieldNumber) ?? []) {
    const entry = decodeProtoMessage(lengthDelimitedValue(field, fieldNumber));
    expect(fieldNumbers(entry)).toEqual([1, 2]);
    const key = stringField(entry, 1);
    if (Object.hasOwn(attributes, key)) throw new Error(`Duplicate OTLP attribute: ${key}`);
    const value = embeddedField(entry, 2);
    const valueFields = fieldNumbers(value);
    expect(valueFields).toHaveLength(1);
    const valueFieldNumber = valueFields[0];
    attributes[key] =
      valueFieldNumber === 1
        ? stringField(value, 1)
        : valueFieldNumber === 2
          ? numberField(value, 2) !== 0
          : valueFieldNumber === 3
            ? numberField(value, 3)
            : valueFieldNumber === 4
              ? doubleField(value, 4)
              : (() => {
                  throw new Error(`Unsupported OTLP attribute value field: ${valueFieldNumber}`);
                })();
  }
  return attributes;
}

function decodeProtoMessage(bytes: Uint8Array): ProtoMessage {
  const message = new Map<number, ProtoField[]>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) throw new Error('Invalid protobuf field number.');
    let field: ProtoField;
    if (wireType === 0) {
      const decoded = readVarint(bytes, offset);
      offset = decoded.nextOffset;
      field = {value: decoded.value, wireType: 0};
    } else if (wireType === 1) {
      field = {value: readFixed(bytes, offset, 8), wireType: 1};
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.nextOffset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > bytes.byteLength) {
        throw new Error('Invalid protobuf length-delimited field.');
      }
      field = {value: bytes.slice(offset, offset + byteLength), wireType: 2};
      offset += byteLength;
    } else if (wireType === 5) {
      field = {value: readFixed(bytes, offset, 4), wireType: 5};
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
    const fields = message.get(fieldNumber) ?? [];
    fields.push(field);
    message.set(fieldNumber, fields);
  }
  return message;
}

function readVarint(bytes: Uint8Array, initialOffset: number): {readonly nextOffset: number; readonly value: bigint} {
  let value = 0n;
  let shift = 0n;
  for (let offset = initialOffset; offset < bytes.byteLength && offset < initialOffset + 10; offset += 1) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return {nextOffset: offset + 1, value};
    shift += 7n;
  }
  throw new Error('Invalid protobuf varint.');
}

function readFixed(bytes: Uint8Array, offset: number, byteLength: 4 | 8): Uint8Array {
  if (offset + byteLength > bytes.byteLength) throw new Error('Truncated protobuf fixed-width field.');
  return bytes.slice(offset, offset + byteLength);
}

function onlyField(message: ProtoMessage, fieldNumber: number): ProtoField {
  const fields = message.get(fieldNumber) ?? [];
  if (fields.length !== 1) throw new Error(`Expected exactly one protobuf field ${fieldNumber}.`);
  return fields[0];
}

function lengthDelimitedValue(field: ProtoField, fieldNumber: number): Uint8Array {
  if (field.wireType !== 2) throw new Error(`Expected protobuf field ${fieldNumber} to be length-delimited.`);
  return field.value;
}

function embeddedField(message: ProtoMessage, fieldNumber: number): ProtoMessage {
  return decodeProtoMessage(lengthDelimitedValue(onlyField(message, fieldNumber), fieldNumber));
}

function bytesField(message: ProtoMessage, fieldNumber: number): Uint8Array {
  return lengthDelimitedValue(onlyField(message, fieldNumber), fieldNumber);
}

function stringField(message: ProtoMessage, fieldNumber: number): string {
  return new TextDecoder('utf-8', {fatal: true}).decode(bytesField(message, fieldNumber));
}

function numberField(message: ProtoMessage, fieldNumber: number): number {
  const field = onlyField(message, fieldNumber);
  if (field.wireType !== 0) throw new Error(`Expected protobuf field ${fieldNumber} to be a varint.`);
  const value = Number(field.value);
  if (!Number.isSafeInteger(value)) throw new Error(`Protobuf field ${fieldNumber} exceeds JavaScript's safe range.`);
  return value;
}

function fixed64Field(message: ProtoMessage, fieldNumber: number): bigint {
  const field = onlyField(message, fieldNumber);
  if (field.wireType !== 1) throw new Error(`Expected protobuf field ${fieldNumber} to be fixed64.`);
  return new DataView(field.value.buffer, field.value.byteOffset, field.value.byteLength).getBigUint64(0, true);
}

function doubleField(message: ProtoMessage, fieldNumber: number): number {
  const field = onlyField(message, fieldNumber);
  if (field.wireType !== 1) throw new Error(`Expected protobuf field ${fieldNumber} to be fixed64.`);
  return new DataView(field.value.buffer, field.value.byteOffset, field.value.byteLength).getFloat64(0, true);
}

function fieldNumbers(message: ProtoMessage): number[] {
  return [...message.keys()].sort((left, right) => left - right);
}
