import {runQualificationCommand} from './candidate.js';
import {runEditorQualificationCommand} from './editor.js';

// Root operator scripts launch this fixed owning-app entrypoint with the current Bun executable.
const [surface, ...arguments_] = process.argv.slice(2);
if (surface === 'providers') await runQualificationCommand(arguments_);
else if (surface === 'editors') await runEditorQualificationCommand(arguments_);
else throw new Error('Qualification entrypoint requires providers or editors');
