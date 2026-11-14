import {Array as EffectArray, String as EffectString} from 'effect';
export const BUN_STANDALONE_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-arm64',
  'bun-linux-arm64-musl',
  'bun-linux-x64-baseline',
  'bun-linux-x64-baseline-musl',
  'bun-windows-arm64',
  'bun-windows-x64-baseline',
] as const satisfies readonly Bun.Build.CompileTarget[];

export type BunStandaloneTarget = (typeof BUN_STANDALONE_TARGETS)[number];

export function releaseTargetForBunTarget(target: string): string {
  if (!EffectArray.some(BUN_STANDALONE_TARGETS, profile => profile === target))
    throw new Error(`Unsupported release target: ${target}`);
  return EffectString.replace('-baseline', '')(EffectString.replace(/^bun-/u, '')(target));
}
