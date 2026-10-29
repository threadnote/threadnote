"""Pinned Bun toolchain and frozen installation from the single Bun lockfile."""

_VERSION = "1.4.4"
_PLATFORMS = {
    "darwin-arm64": ("darwin-aarch64", "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510", "osx", "aarch64"),
    "darwin-x86_64": ("darwin-x64", "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e", "osx", "x86_64"),
    "linux-arm64": ("linux-aarch64", "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e", "linux", "aarch64"),
    "linux-x86_64": ("linux-x64", "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c", "linux", "x86_64"),
}

def _host(ctx):
    os = "darwin" if ctx.os.name in ["mac os x", "darwin"] else ctx.os.name
    arch = "arm64" if ctx.os.arch in ["aarch64", "arm64"] else "x86_64" if ctx.os.arch in ["amd64", "x86_64"] else ctx.os.arch
    key = os + "-" + arch
    if key not in _PLATFORMS:
        fail("The Bun Bazel compatibility gate supports macOS and glibc Linux on arm64/x64; unsupported host: " + key)
    return _PLATFORMS[key]

def _toolchain_impl(ctx):
    platform = _host(ctx)
    ctx.download_and_extract(
        url = "https://github.com/oven-sh/bun/releases/download/bun-v%s/bun-%s.zip" % (_VERSION, platform[0]),
        sha256 = platform[1],
        stripPrefix = "bun-" + platform[0],
    )
    ctx.file("BUILD.bazel", """
load("@threadnote//tools/bazel:bun.bzl", "bun_toolchain")
package(default_visibility = ["//visibility:public"])
exports_files(["bun"])
bun_toolchain(name = "implementation", bun = "bun")
toolchain(
    name = "registered",
    toolchain = ":implementation",
    toolchain_type = "@threadnote//tools/bazel:toolchain_type",
    exec_compatible_with = ["@platforms//os:%s", "@platforms//cpu:%s"],
    target_compatible_with = ["@platforms//os:%s", "@platforms//cpu:%s"],
)
""" % (platform[2], platform[3], platform[2], platform[3]))

_toolchain = repository_rule(implementation = _toolchain_impl)

def _install_impl(ctx):
    for label in [ctx.attr.package_json, ctx.attr.lock] + ctx.attr.workspace_manifests:
        destination = label.name if label.package == "" else label.package + "/" + label.name
        ctx.file(destination, ctx.read(label))
    ctx.file("install.mjs", ctx.read(ctx.attr.installer))
    ctx.file("dependency-closure.mjs", ctx.read(ctx.attr.closure))
    env = {
        "HOME": str(ctx.path(".home")),
        "BUN_INSTALL_CACHE_DIR": str(ctx.path(".cache")),
        "BUN_INSTALL_NO_TRACK": "1",
        "DO_NOT_TRACK": "1",
        "NO_COLOR": "1",
        "PATH": "/usr/bin:/bin",
    }
    result = ctx.execute(
        [ctx.path(ctx.attr.bun), ctx.path("install.mjs")],
        environment = env,
        timeout = 600,
    )
    if result.return_code:
        fail("Frozen Bun repository installation failed:\n" + result.stdout + result.stderr)
    ctx.delete(".cache")
    ctx.delete(".home")

_install = repository_rule(
    implementation = _install_impl,
    attrs = {
        "bun": attr.label(allow_single_file = True, mandatory = True),
        "installer": attr.label(allow_single_file = True, default = "//tools/bazel:install.mjs"),
        "closure": attr.label(allow_single_file = True, default = "//tools/bazel:dependency-closure.mjs"),
        "package_json": attr.label(allow_single_file = True, mandatory = True),
        "lock": attr.label(allow_single_file = True, mandatory = True),
        "workspace_manifests": attr.label_list(allow_files = [".json"]),
    },
)

def _extension_impl(ctx):
    _toolchain(name = "bun_toolchain")
    for module in ctx.modules:
        for install in module.tags.install:
            _install(
                name = install.name,
                bun = "@bun_toolchain//:bun",
                package_json = install.package_json,
                lock = install.lock,
                workspace_manifests = install.workspace_manifests,
            )

bun = module_extension(
    implementation = _extension_impl,
    tag_classes = {"install": tag_class(attrs = {
        "name": attr.string(mandatory = True),
        "package_json": attr.label(mandatory = True),
        "lock": attr.label(mandatory = True),
        "workspace_manifests": attr.label_list(),
    })},
    os_dependent = True,
    arch_dependent = True,
)
