# Native selected-vector reader

This private recall capability owns one read-only SQLite connection and transaction. TypeScript owns authorization/predicate compilation, inference, preparation hashing, independent corpus checks, canonical validation, and scoped admission. Public CLI/MCP requests contain no SQL or native handles. Payload loading never builds or downloads an addon.

`readSelected(request, Float64Array | undefined, new CancellationToken())` returns a Promise with a closed `success`, `absent`, `corrupt`, `operation-error`, `corpus-changed`, or `cancelled` outcome. A token is single-use; `cancel()` cooperatively interrupts SQLite and scoring, including cancellation before task execution. The original Promise always drains before the Effect adapter releases admission. Never use NAPI AsyncTask cancellation or an AbortSignal with this operation.

The request supplies typed generation/model/preparation/corpus expectations and private compiled selection/alias predicates. Rust owns all SQL scaffolding and checks fragment boundaries, one-statement preparation, read-only state, column count and bound parameter count. It validates schema version 5 and metadata/counts before compatibility, accepts legacy schema without `scope_mapping_version`, and accepts valid legacy 64-hex jobs independently of preparation hashing. Only `idle-recall-v2:` jobs must equal the expected preparation identity. TypeScript serializes policy identity inputs; when no corpus is requested Rust hashes the pinned active corpus plus that suffix with exact pinned portable SHA-256. Expected model/corpus equality uses lossless UTF-16 code units; SQL strings retain Bun-compatible UTF-8 replacement and embedded NUL binding. `corpusCheckRequired` records whether metadata reached the old inner lexical-corpus check position.

Safe rusqlite row borrows keep Float32LE vector bytes in SQLite. Scoring uses ordered f64 multiply/add without FMA/reassociation, finite and L2 tolerance checks, UTF-16 ties, and strict validation at limit zero. URI scores clamp negatives to zero and aliases merge in the same snapshot. Post-clamp NaN at positive k triggers a replay in the same pinned transaction with the historical 400-row seek pages, page sort/slice and best+page sort/slice. `legacy_numeric.rs` ports the pinned Bun 1.4.4 galloping WebKit Powersort control flow because the NaN comparator is non-transitive; NOTICE preserves its upstream licenses. Private NaN survives presentation and alias merging until the original caller closing and public finite-wire validation. k0 still validates every row. The native operation imposes no prototype dimension, row, SQL-length or result caps; all finite query magnitudes, optional corpus expectations, legacy limits and string bind inputs use Rust. Semantic failures never trigger a TypeScript retry. A missing or mismatched required payload is a capability failure before selection.

## Build and verify

Rust 1.89.0, exact pinned NAPI 3 and rusqlite dependencies, and private bundled SQLite are required. The only additional rusqlite feature is `hooks` for cooperative progress interruption. `build.rs` verifies the actual Rust compiler version. `buildInfo()` reports protocol/NAPI/target, SQLite version/source ID and assembler-provided source, lockfile and toolchain identities; an unassembled direct build reports `development` identities and cannot be used as a release payload.

Use the explicit post-build assembler outside Bazel. The assembler builds `--locked --release` and publishes a manifest after verifying source and binary identities. Unit tests can run with `cargo test --locked --lib`. The ordinary Bun/Bazel build has no Cargo dependency.

On a machine with an isolated Rust installation, select both Cargo and its child compiler explicitly; `rustup run cargo` alone can leave a different `rustc` on PATH:

```sh
env RUSTUP_HOME=/private/tmp/threadnote-rust-toolchain-1.89.0/rustup \
  CARGO_HOME=/private/tmp/threadnote-vector-reader-bundled-spike/cargo-home \
  RUSTC=/private/tmp/threadnote-rust-toolchain-1.89.0/rustup/toolchains/1.89.0-aarch64-apple-darwin/bin/rustc \
  RUSTDOC=/private/tmp/threadnote-rust-toolchain-1.89.0/rustup/toolchains/1.89.0-aarch64-apple-darwin/bin/rustdoc \
  /private/tmp/threadnote-rust-toolchain-1.89.0/rustup/toolchains/1.89.0-aarch64-apple-darwin/bin/cargo \
  test --locked --lib
```

`THREADNOTE_NATIVE_SOURCE_COMMIT`, `THREADNOTE_NATIVE_SOURCE_TREE`, `THREADNOTE_NATIVE_SOURCE_SHA256`, `THREADNOTE_NATIVE_LOCK_SHA256`, and `THREADNOTE_NATIVE_TOOLCHAIN_SHA256` are set by the assembler. Binary digests remain external so macOS signing can finalize them without a circular embedded digest.
