import {expect, it} from '@effect/vitest';
import {Schema} from 'effect';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {ContextMaintenanceSnapshotDiagnosticV1} from '../../src/health_maintenance.js';

fcProp(
  it,
  'round-trips snapshot diagnostics while preserving optional in-memory field presence',
  {
    category: FC.constantFrom(
      'invalid-header',
      'invalid-utf8',
      'permission-denied',
      'record-size-limit',
      'cache-size-limit',
      'authority-boundary',
      'record-not-regular',
      'record-changed',
      'io-error',
    ),
    stage: FC.constantFrom('discovery', 'record-read', 'authority-check', 'inventory-cache'),
    memoryUri: FC.option(FC.string({maxLength: 80}), {nil: undefined}),
    includeUri: FC.boolean(),
    retryable: FC.boolean(),
  },
  ({category, stage, memoryUri, includeUri, retryable}) => {
    const value: ContextMaintenanceSnapshotDiagnosticV1 = {
      version: 1,
      category,
      stage,
      ...(includeUri ? {memoryUri} : {}),
      summary: 'synthetic summary',
      recovery: 'synthetic recovery',
      retryable,
    };
    const json = JSON.stringify(value);
    const hadUri = 'memoryUri' in value;
    const decoded = Schema.decodeSync(ContextMaintenanceSnapshotDiagnosticV1)(value);
    expect(decoded).toEqual(value);
    expect('memoryUri' in decoded).toBe(hadUri);
    expect('memoryUri' in value).toBe(hadUri);
    expect(JSON.stringify(value)).toBe(json);
    expect(Schema.decodeSync(Schema.fromJsonString(ContextMaintenanceSnapshotDiagnosticV1))(json)).toEqual(
      JSON.parse(json),
    );
  },
  {fastCheck: {numRuns: 100}},
);
