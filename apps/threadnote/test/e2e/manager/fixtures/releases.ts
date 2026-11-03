import type {NetworkRoute} from './runtime.js';

export function releaseRoutes(version: string): readonly NetworkRoute[] {
  const release = {
    tag_name: `v${version}`,
    body: 'Synthetic release notes',
    draft: false,
    prerelease: false,
    immutable: true,
    assets: [],
  };
  return [
    {origin: 'https://api.github.com', path: '/repos/threadnote/threadnote/releases/latest', body: release},
    {origin: 'https://api.github.com', path: '/repos/threadnote/threadnote/releases', body: [release]},
  ];
}
