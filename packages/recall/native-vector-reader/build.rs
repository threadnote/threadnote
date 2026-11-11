use std::env;

fn main() {
    let compiler = std::process::Command::new(env::var_os("RUSTC").expect("Cargo RUSTC"))
        .arg("--version")
        .output()
        .expect("read Rust compiler version");
    let compiler = String::from_utf8(compiler.stdout).expect("Rust compiler version UTF-8");
    assert_eq!(
        compiler.split_whitespace().nth(1),
        Some("1.89.0"),
        "native vector reader requires pinned Rust 1.89.0"
    );
    napi_build::setup();
    println!(
        "cargo:rustc-env=THREADNOTE_NATIVE_TARGET={}",
        env::var("TARGET").unwrap()
    );
    for name in [
        "THREADNOTE_NATIVE_SOURCE_COMMIT",
        "THREADNOTE_NATIVE_SOURCE_TREE",
        "THREADNOTE_NATIVE_LOCK_SHA256",
        "THREADNOTE_NATIVE_TOOLCHAIN_SHA256",
        "THREADNOTE_NATIVE_SOURCE_SHA256",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        println!(
            "cargo:rustc-env={name}={}",
            env::var(name).unwrap_or_else(|_| "development".into())
        );
    }
}
