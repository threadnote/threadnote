import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {previewCodeGraphInventory, type CodeGraphInventoryPreview} from '@threadnote/graph/inventory';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const runCodeGraphInventory = Effect.fn('codeGraph.command.inventory')(function* (
  config: RuntimeConfig,
  options: {readonly cwd?: string; readonly json?: boolean; readonly project?: string},
) {
  const system = yield* SystemInfo;
  const cwd =
    Effect2.pipe(options.cwd, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || system.currentDirectory();
  const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, cwd, options.project);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const preview = yield* previewCodeGraphInventory(identity, {
    ...(route.state === 'selected' ? {project: route.project} : {}),
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(preview) : renderCodeGraphInventoryPreview(preview));
});

function renderCodeGraphInventoryPreview(preview: CodeGraphInventoryPreview): string {
  const source = `${Effect2.pipe(preview.commit, EffectString.slice(0, 12))}${preview.dirty ? ' + worktree changes' : ' (clean)'}`;
  const lines = [
    'Code graph inventory admission preview',
    `Source: ${source}`,
    `Policy: v${preview.policyVersion} · aggregate metadata only · repository paths and content omitted`,
    `Repository: ${formatCount(preview.totals.repository)}`,
    `Eligible: ${formatCount(preview.totals.eligible)}`,
    `Skipped: ${formatCount(preview.totals.skipped)}`,
  ];
  if (preview.omittedUnsafeWorktreeFiles > 0) {
    lines.push(
      `Omitted: ${preview.omittedUnsafeWorktreeFiles} changed unsafe/non-regular worktree path(s) are outside byte totals.`,
    );
  }
  lines.push('', 'DISPOSITION\tLANGUAGE\tROLE\tCLASSIFIER\tREASON\tFILES\tBYTES');
  for (const group of preview.groups) {
    lines.push(
      EffectArray.join(
        EffectArray.map(
          [group.disposition, group.language, group.role, group.classifier, group.reason, group.files, group.bytes],
          item => (item === null || item === undefined ? '' : String(item)),
        ),
        '\t',
      ),
    );
  }
  return `${EffectArray.join(lines, '\n')}\n`;
}

function formatCount(count: {readonly bytes: number; readonly files: number}): string {
  return `${count.files} file(s) · ${count.bytes} bytes (${formatBytes(count.bytes)})`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}
