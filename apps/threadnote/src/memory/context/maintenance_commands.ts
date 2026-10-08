import {Effect} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {renderContextMaintenanceStatus} from './maintenance_projection.js';
import {
  readContextMaintenancePacket,
  readContextMaintenanceStatus,
  retireContextMaintenanceAnchor,
  runContextMaintenance,
  setContextMaintenancePaused,
  undoContextMaintenance,
} from './maintenance.js';

export const runContextMaintainCommand = Effect.fn('contextMaintenance.command')(function* (
  config: RuntimeConfig,
  options: {
    readonly project?: string;
    readonly maxRecords?: number;
    readonly json?: boolean;
    readonly action?: string;
    readonly receiptId?: string;
    readonly caseId?: string;
    readonly caseCursor?: string;
    readonly receiptCursor?: string;
    readonly limit?: number;
    readonly evidenceRevision?: string;
    readonly expectedContentHash?: string;
    readonly citationId?: string;
    readonly memoryUri?: string;
    readonly startLine?: number;
    readonly maximumLines?: number;
  },
) {
  const result =
    options.action === 'retire-anchor'
      ? yield* retireContextMaintenanceAnchor(config, {
          caseId: options.caseId ?? '',
          evidenceRevision: options.evidenceRevision ?? '',
          expectedContentHash: options.expectedContentHash ?? '',
        })
      : options.action === 'packet'
        ? yield* readContextMaintenancePacket(config, options.caseId ?? '', options)
        : options.action === 'status'
          ? yield* readContextMaintenanceStatus(config, options.project, options)
          : options.action === 'pause' || options.action === 'resume'
            ? yield* setContextMaintenancePaused(config, options.action === 'pause')
            : options.action === 'undo'
              ? yield* undoContextMaintenance(config, options.receiptId ?? '')
              : yield* runContextMaintenance(config, {
                  cwd: (yield* SystemInfo).currentDirectory(),
                  project: options.project,
                  maxRecords: options.maxRecords,
                  caseId: options.caseId,
                });
  yield* writeFinalCliOutput(
    options.json
      ? JSON.stringify(result)
      : 'projects' in result
        ? renderContextMaintenanceStatus(result)
        : 'status' in result
          ? `Maintenance undo: ${result.status}`
          : JSON.stringify(result, null, 2),
  );
});
