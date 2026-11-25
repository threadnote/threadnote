"""Small Bun rules with declared source and npm dependency closures."""

_TOOLCHAIN = "//tools/bazel:toolchain_type"

# The only host variables a test may inherit: the prepared native TypeScript asset location and the CI flag that makes
# a missing asset fail instead of skip. Values are part of the test action key, so CI exports a fixed per-host path
# (see tools/bazel/README.md).
_INHERITABLE = ["THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR", "THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED"]

def _inherited(ctx):
    names = getattr(ctx.attr, "inherited_env", [])
    for name in names:
        if name not in _INHERITABLE:
            fail("%s may not inherit host variable %s" % (ctx.label, name))
    return names

def _toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(bun = ctx.file.bun)]

bun_toolchain = rule(implementation = _toolchain_impl, attrs = {"bun": attr.label(allow_single_file = True, mandatory = True)})

def _files(ctx):
    return depset(ctx.files.srcs + ctx.files.data, transitive = [dep[DefaultInfo].files for dep in ctx.attr.deps])

def _library_impl(ctx):
    return [DefaultInfo(files = _files(ctx))]

_ATTRS = {
    "srcs": attr.label_list(allow_files = True),
    "data": attr.label_list(allow_files = True),
    "deps": attr.label_list(),
}
bun_library = rule(implementation = _library_impl, attrs = _ATTRS)

def _manifest(ctx, inputs, args, testing):
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    files = []
    for file in inputs.to_list():
        path = file.short_path
        destination = path
        if path.startswith("../"):
            destination = "/".join(path.split("/")[2:])
            if not destination.startswith("node_modules/"):
                fail("External Bun inputs must be npm files: " + path)
        files.append({"source": path if testing else file.path, "destination": destination})
    ctx.actions.write(manifest, json.encode({"files": files, "args": args, "env": ctx.attr.env, "inheritedEnv": _inherited(ctx)}))
    return manifest

def _test_impl(ctx):
    inputs = _files(ctx)
    bun = ctx.toolchains[_TOOLCHAIN].bun
    manifest = _manifest(ctx, inputs, ctx.attr.runner_args, True)
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, """#!/bin/sh
set -eu
cd "$TEST_SRCDIR/%s"
exec "%s" "%s" "%s" --test "$@"
""" % (ctx.workspace_name, bun.short_path, ctx.file._runner.short_path, manifest.short_path), is_executable = True)
    return [
        DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = [bun, manifest, ctx.file._runner], transitive_files = inputs)),
        RunEnvironmentInfo(inherited_environment = _inherited(ctx)),
    ]

def _workspace_test_impl(ctx):
    inputs = _files(ctx)
    bun = ctx.toolchains[_TOOLCHAIN].bun
    manifest = _manifest(ctx, inputs, ctx.attr.runner_args, True)
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, """#!/bin/sh
set -eu
cd "$TEST_SRCDIR/%s"
exec "%s" "%s" "%s" --workspace-test "$@"
""" % (ctx.workspace_name, bun.short_path, ctx.file._runner.short_path, manifest.short_path), is_executable = True)
    return [
        DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = [bun, manifest, ctx.file._runner], transitive_files = inputs)),
        RunEnvironmentInfo(inherited_environment = _inherited(ctx)),
    ]

_RUN_ATTRS = dict(
    _ATTRS,
    env = attr.string_dict(),
    _runner = attr.label(default = "//tools/bazel:runner.mjs", allow_single_file = True),
)
# Names (never values) of allowlisted host variables a test inherits.
_TEST_ATTRS = dict(_RUN_ATTRS, runner_args = attr.string_list(), inherited_env = attr.string_list())

bun_test = rule(
    implementation = _test_impl,
    attrs = _TEST_ATTRS,
    test = True,
    toolchains = [_TOOLCHAIN],
)

# Repository-contract tests need the checkout's Git object database. They still
# declare exact inputs for analysis and CI selection, but execute locally.
bun_workspace_test = rule(
    implementation = _workspace_test_impl,
    attrs = _TEST_ATTRS,
    test = True,
    toolchains = [_TOOLCHAIN],
)

def _action_impl(ctx):
    inputs = _files(ctx)
    bun = ctx.toolchains[_TOOLCHAIN].bun
    manifest = _manifest(ctx, inputs, ctx.attr.args, False)
    output = ctx.actions.declare_directory(ctx.attr.out_dir or ctx.label.name)
    ctx.actions.run(
        executable = bun,
        arguments = [ctx.file._runner.path, manifest.path, output.path],
        inputs = depset([manifest, ctx.file._runner], transitive = [inputs]),
        outputs = [output],
        mnemonic = "BunAction",
        env = {"TZ": "UTC"},
        execution_requirements = {"local": "1", "no-sandbox": "1"} if ctx.attr.local else {},
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([output]))]

bun_action = rule(
    implementation = _action_impl,
    attrs = dict(_RUN_ATTRS, args = attr.string_list(), local = attr.bool(), out_dir = attr.string()),
    toolchains = [_TOOLCHAIN],
)
