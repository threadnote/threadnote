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
