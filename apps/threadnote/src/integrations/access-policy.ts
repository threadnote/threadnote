import {externalSourcePolicyLayer} from '@threadnote/integration-runtime/access-policy';
import {superhumanExternalSourcePolicy} from '@threadnote/integration-superhuman/access-policy';
import {pocketExternalSourcePolicy} from '@threadnote/integration-pocket/access-policy';
import {githubExternalSourcePolicy} from '@threadnote/integration-github/access-policy';
import {linearExternalSourcePolicy} from '@threadnote/integration-linear/access-policy';
export const integrationExternalSourcePolicyLayer = externalSourcePolicyLayer([
  superhumanExternalSourcePolicy,
  pocketExternalSourcePolicy,
  githubExternalSourcePolicy,
  linearExternalSourcePolicy,
]);
