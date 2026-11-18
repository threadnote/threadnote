/** Shared lane selection only: the testing package has no dependency on recall. */
export const nativeVectorTestsRequired =
  process.env.THREADNOTE_NATIVE_VECTOR_READER_REQUIRED === '1' || process.env.THREADNOTE_NATIVE_VECTOR_REQUIRED === '1';
export const nativeVectorTestsEnabled =
  nativeVectorTestsRequired || process.env.THREADNOTE_NATIVE_VECTOR_READER_MANIFEST !== undefined;

if (nativeVectorTestsRequired && process.env.THREADNOTE_NATIVE_VECTOR_READER_MANIFEST === undefined)
  throw new Error('The required actual-addon lane needs THREADNOTE_NATIVE_VECTOR_READER_MANIFEST.');
