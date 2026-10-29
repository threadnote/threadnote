import type {IntegrationRegistration} from './integration_registration.js';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {ManagerProcessesProvider} from './process/live.js';
import {ManagerLiveProvider} from './live/provider.js';
import {ModelSetupProvider} from './model_setup_live.js';

type ManagerApp = React.ComponentType<{
  readonly integrations: readonly IntegrationRegistration[];
  readonly onAccount: (account: string) => void;
}>;

function AccountApp({
  integrations,
  App,
}: {
  readonly integrations: readonly IntegrationRegistration[];
  readonly App: ManagerApp;
}): React.ReactElement {
  const [scope, setScope] = useState<{account?: string; generation: number}>({generation: 0});
  const setAccount = (account: string) =>
    setScope(current =>
      current.account === account
        ? current
        : {
            account,
            generation: current.account === undefined ? current.generation : current.generation + 1,
          },
    );
  return (
    <ManagerLiveProvider account={scope.account} key={scope.generation}>
      <ModelSetupProvider>
        <ManagerProcessesProvider>
          <App integrations={integrations} onAccount={setAccount} />
        </ManagerProcessesProvider>
      </ModelSetupProvider>
    </ManagerLiveProvider>
  );
}

export function mountManagerApp(
  App: ManagerApp,
  {integrations}: {readonly integrations: readonly IntegrationRegistration[]},
): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  createRoot(root).render(
    <ManagerDialogProvider>
      <AccountApp integrations={integrations} App={App} />
    </ManagerDialogProvider>,
  );
}
