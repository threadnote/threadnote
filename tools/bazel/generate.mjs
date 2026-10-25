// oxlint-disable-next-line effecttsgo/node-builtin-import -- Build bootstrap uses Bun's path utilities without an Effect service layer.
import {join, resolve} from 'node:path';
import {buildGenerationModel} from './generation-model.mjs';
import {prepareBazelWorkspace} from './prepare.mjs';

export {buildGenerationModel} from './generation-model.mjs';
export {prepareBazelWorkspace} from './prepare.mjs';

export const publishGenerationModel = async ({root, output}, {check = false} = {}) => {
  for (const [path, content] of output) {
    const absolute = join(root, path);
    if (check) {
      const file = Bun.file(absolute);
      if (!(await file.exists()) || (await file.text()) !== content)
        throw new Error(`Stale Bazel declarations: ${path}; run bun tools/bazel/generate.mjs`);
    } else await Bun.write(absolute, content);
  }
};

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  if (process.argv.includes('--check')) await publishGenerationModel(await buildGenerationModel({root}), {check: true});
  else await prepareBazelWorkspace({root});
}
