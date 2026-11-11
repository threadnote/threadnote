const crate = `${import.meta.dir}/../packages/inference/native-vector/`;
const target = `${import.meta.dir}/../.context/native-vector-target`;
const build = Bun.spawn(['cargo', 'build', '--release', '--locked', '--target-dir', target], {
  cwd: crate,
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await build.exited) !== 0) throw new Error('Native vector experiment build failed.');
const library =
  process.platform === 'darwin'
    ? 'libthreadnote_native_vector.dylib'
    : process.platform === 'win32'
      ? 'threadnote_native_vector.dll'
      : 'libthreadnote_native_vector.so';
await Bun.write(`${crate}vector-search.node`, Bun.file(`${target}/release/${library}`));
await Bun.write(Bun.stdout, `${crate}vector-search.node\n`);
