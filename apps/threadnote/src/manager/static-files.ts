import {MANAGER_STATIC_FILES as managerStaticFiles} from '@threadnote/manager/server';
import {managerAssets as obsidianAssets} from '@threadnote/integration-obsidian/manager-assets';
import {managerAssets as superhumanAssets} from '@threadnote/integration-superhuman/manager-assets';
import {managerAssets as pocketAssets} from '@threadnote/integration-pocket/manager-assets';
import {managerAssets as githubAssets} from '@threadnote/integration-github/manager-assets';
import {managerAssets as linearAssets} from '@threadnote/integration-linear/manager-assets';

export const integrationStaticFiles = {
  ...obsidianAssets,
  ...superhumanAssets,
  ...pocketAssets,
  ...githubAssets,
  ...linearAssets,
};

export const MANAGER_STATIC_FILES: typeof managerStaticFiles = {...managerStaticFiles, ...integrationStaticFiles};
