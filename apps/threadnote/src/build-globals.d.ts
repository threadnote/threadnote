declare const THREADNOTE_STANDALONE: boolean;
declare const THREADNOTE_RUNTIME_SOURCE_IDENTITY:
  import('./memory/handoff_save_contract.js').HandoffSaveSourceIdentity | null;
declare const THREADNOTE_VERSION: string;
/** Compiled only into a notarized macOS release, after publish verified the Developer ID signed private `tsc`. */
declare const THREADNOTE_SIGNED_NATIVE_TYPESCRIPT:
  {readonly host: string; readonly sha256: string; readonly cdhash: string} | null | undefined;
