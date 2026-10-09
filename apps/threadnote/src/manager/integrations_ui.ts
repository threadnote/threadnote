import {obsidianIntegration} from '@threadnote/integration-obsidian/manager-ui';
import {superhumanIntegration} from '@threadnote/integration-superhuman/manager-ui';
import {pocketIntegration} from '@threadnote/integration-pocket/manager-ui';
import {linearIntegration} from '@threadnote/integration-linear/manager-ui';
import {githubIntegration} from '@threadnote/integration-github/manager-ui';

export const managerIntegrations = [
  obsidianIntegration,
  superhumanIntegration,
  pocketIntegration,
  linearIntegration,
  githubIntegration,
] as const;
