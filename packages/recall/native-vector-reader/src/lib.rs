//! Recall's private selected-vector read. SQLite rows and resources remain native-owned.
mod db;
mod legacy_numeric;
mod protocol;
mod scoring;

#[cfg(not(test))]
use napi::{
    bindgen_prelude::{AsyncTask, Float64Array},
    Env, Task,
};
#[cfg(not(test))]
use napi_derive::napi;
use protocol::*;
use rusqlite::InterruptHandle;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
pub(crate) struct CancellationState {
    cancelled: Arc<AtomicBool>,
    #[cfg(not(test))]
    used: AtomicBool,
    interrupt: Mutex<Option<InterruptHandle>>,
}
impl CancellationState {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(handle) = self
            .interrupt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            handle.interrupt();
        }
    }
    pub(crate) fn register(&self, handle: InterruptHandle) {
        let mut slot = self.interrupt.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(handle);
        if self.is_cancelled() {
            slot.as_ref().unwrap().interrupt();
        }
    }
    pub(crate) fn unregister(&self) {
        self.interrupt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

/// A single-use cooperative token. It never cancels napi's queued AsyncTask.
#[cfg_attr(not(test), napi)]
pub struct CancellationToken {
    state: Arc<CancellationState>,
}
#[cfg_attr(not(test), napi)]
impl CancellationToken {
    #[cfg_attr(not(test), napi(constructor))]
    pub fn new() -> Self {
        Self {
            state: Arc::new(CancellationState::default()),
        }
    }
    #[cfg_attr(not(test), napi)]
    pub fn cancel(&self) {
        self.state.cancel();
    }
}
impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(test))]
pub struct ReadTask {
    request: NativeReadRequest,
    query: Option<Vec<f64>>,
    cancellation: Arc<CancellationState>,
}
#[cfg(not(test))]
impl Task for ReadTask {
    type Output = NativeReadOutcome;
    type JsValue = NativeReadOutcome;
    fn compute(&mut self) -> napi::Result<NativeReadOutcome> {
        Ok(db::read(
            &self.request,
            self.query.as_deref(),
            &self.cancellation,
        ))
    }
    fn resolve(&mut self, _env: Env, output: NativeReadOutcome) -> napi::Result<NativeReadOutcome> {
        Ok(output)
    }
}

#[cfg(not(test))]
#[napi]
pub fn read_selected(
    request: NativeReadRequest,
    query: Option<Float64Array>,
    token: &CancellationToken,
) -> napi::Result<AsyncTask<ReadTask>> {
    // No JS-owned array or class reference survives this call. The original task
    // always resolves; the Effect adapter retains admission until it drains.
    let query = query.map(|query| query.to_vec());
    if token.state.used.swap(true, Ordering::AcqRel) {
        return Err(napi::Error::new(
            napi::Status::InvalidArg,
            "A native vector cancellation token is single-use.",
        ));
    }
    Ok(AsyncTask::new(ReadTask {
        request,
        query,
        cancellation: Arc::clone(&token.state),
    }))
}

#[cfg_attr(not(test), napi)]
pub fn build_info() -> NativeBuildInfo {
    NativeBuildInfo {
        protocol_version: PROTOCOL_VERSION,
        napi_version: 6,
        crt_static: cfg!(target_feature = "crt-static"),
        deployment_target: option_env!("THREADNOTE_NATIVE_DEPLOYMENT_TARGET")
            .unwrap_or("")
            .into(),
        crate_version: env!("CARGO_PKG_VERSION").into(),
        sqlite_version: rusqlite::version().into(),
        sqlite_source_id: rusqlite::Connection::open_in_memory()
            .and_then(|db| db.query_row("SELECT sqlite_source_id()", [], |row| row.get(0)))
            .expect("bundled SQLite source identity"),
        target: env!("THREADNOTE_NATIVE_TARGET").into(),
        rust_version: "1.89.0".into(),
        source_commit: env!("THREADNOTE_NATIVE_SOURCE_COMMIT").into(),
        source_tree: env!("THREADNOTE_NATIVE_SOURCE_TREE").into(),
        lock_sha256: env!("THREADNOTE_NATIVE_LOCK_SHA256").into(),
        toolchain_sha256: env!("THREADNOTE_NATIVE_TOOLCHAIN_SHA256").into(),
        build_environment_sha256: env!("THREADNOTE_NATIVE_BUILD_ENVIRONMENT_SHA256").into(),
        source_sha256: env!("THREADNOTE_NATIVE_SOURCE_SHA256").into(),
    }
}
