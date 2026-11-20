// Fault injection is confined to the test runner subprocess; its parent reaps the real child.
const denied = () => {
  throw Object.assign(new Error('Simulated process-group permission denial'), {code: 'EPERM'});
};
const originalKill = process.kill;
process.kill = (pid, signal) => (pid < 0 ? denied() : originalKill(pid, signal));
