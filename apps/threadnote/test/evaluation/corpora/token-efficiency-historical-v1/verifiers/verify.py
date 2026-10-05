#!/usr/bin/env python3
"""Hidden offline behavior checks for the historical token-efficiency corpus."""

from __future__ import annotations

import enum
import html
import os
import sys
import types
from pathlib import Path
from typing import Callable


def use_source(repository: Path, root_package: bool = False) -> None:
    source = repository if root_package else repository / "src"
    sys.path.insert(0, str(source))


def verify_h11(repository: Path) -> None:
    use_source(repository, root_package=True)
    import h11

    state = h11.Connection(h11.CLIENT)
    state.send(h11.Request(method=b"GET", target=b"/", headers=[(b"Host", b"example.com")]))
    state.send(h11.EndOfMessage())
    state.receive_data(
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"1  \r\nx\r\n0\r\n\r\n"
    )
    assert isinstance(state.next_event(), h11.Response)
    data = state.next_event()
    assert isinstance(data, h11.Data) and bytes(data.data) == b"x"
    assert isinstance(state.next_event(), h11.EndOfMessage)


def verify_hpack(repository: Path) -> None:
    use_source(repository)
    from hpack import Decoder, Encoder

    def headers():
        return ((f"k{index}", f"v{index}") for index in range(3))

    encoded = Encoder().encode(headers())
    assert Decoder().decode(encoded) == list(headers())


def verify_attrs(repository: Path) -> None:
    use_source(repository)
    import attr

    original = (attr.evolve.__doc__, attr.evolve.__name__, attr.evolve.__qualname__, str(attr.evolve))
    for name in ("CorpusRecord", "SecondCorpusRecord"):
        cls = attr.make_class(name, {"value": attr.ib()})
        instance = cls(1)
        assert (attr.evolve.__doc__, attr.evolve.__name__, attr.evolve.__qualname__, str(attr.evolve)) == original
        assert instance.__replace__(value=2).value == 2


def verify_click(repository: Path) -> None:
    use_source(repository)
    import click
    from semver import Version

    option = click.Option(["--version"], default=Version(1, 0, 0), show_default=True)
    help_text = option.get_help_record(click.Context(click.Command("cli")))[1]
    assert "[default: 1.0.0]" in help_text

    empty = click.Option(["--empty"], default="", show_default=True)
    empty_help = empty.get_help_record(click.Context(click.Command("cli")))[1]
    assert '[default: ""]' in empty_help

    class StrictEquality:
        def __eq__(self, other):
            if isinstance(other, str):
                raise ValueError("must not compare a non-string default with an empty string")
            return NotImplemented

        def __str__(self):
            return "strict"

    strict = click.Option(["--strict"], default=StrictEquality(), show_default=True)
    strict_help = strict.get_help_record(click.Context(click.Command("cli")))[1]
    assert "[default: strict]" in strict_help

    class Choice(enum.Enum):
        FIRST = "first"

    cases = [
        (click.Option(["--items"], default=("one", "two"), show_default=True), "[default: one, two]"),
        (click.Option(["--choice"], default=Choice.FIRST, show_default=True), "[default: FIRST]"),
        (click.Option(["--dynamic"], default=lambda: "value", show_default=True), "[default: (dynamic)]"),
        (click.Option(["--feature/--no-feature"], default=True, show_default=True), "[default: feature]"),
    ]
    for case, expected in cases:
        case_help = case.get_help_record(click.Context(click.Command("cli")))[1]
        assert expected in case_help


def verify_werkzeug(repository: Path) -> None:
    from mypy import api as mypy_api

    program = """\
from werkzeug import Request, Response

@Request.application
def standalone(request: Request) -> Response:
    return Response()

class Application:
    @Request.application
    def bound(self, request: Request) -> Response:
        return Response()
"""
    previous = os.environ.get("MYPYPATH")
    os.environ["MYPYPATH"] = str(repository / "src")
    try:
        stdout, stderr, status = mypy_api.run(
            [
                "--strict",
                "--config-file=/dev/null",
                "--no-incremental",
                "--cache-dir=/dev/null",
                "--ignore-missing-imports",
                "--disable-error-code=import-untyped",
                "--disable-error-code=override",
                "--disable-error-code=unused-ignore",
                "--disable-error-code=misc",
                "-c",
                program,
            ]
        )
    finally:
        if previous is None:
            os.environ.pop("MYPYPATH", None)
        else:
            os.environ["MYPYPATH"] = previous
    assert status == 0, f"{stdout}\n{stderr}"

    use_source(repository)
    if "markupsafe" not in sys.modules:
        markupsafe = types.ModuleType("markupsafe")

        class Markup(str):
            def __html__(self):
                return self

        markupsafe.Markup = Markup
        markupsafe.escape = lambda value: Markup(html.escape(str(value)))
        sys.modules["markupsafe"] = markupsafe
    from werkzeug import Request, Response
    from werkzeug.exceptions import BadRequest
    from werkzeug.test import EnvironBuilder

    def invoke(application):
        environ = EnvironBuilder(path="/typed", method="POST").get_environ()
        observed = {}

        def start_response(status, headers, exc_info=None):
            observed["status"] = status
            observed["headers"] = headers
            observed["exc_info"] = exc_info

        body = b"".join(application(environ, start_response))
        return observed["status"], body

    @Request.application
    def standalone_runtime(request):
        return Response(f"standalone:{request.method}")

    class RuntimeApplication:
        @Request.application
        def bound_runtime(self, request):
            return Response(f"bound:{request.path}")

    @Request.application
    def failure_runtime(request):
        raise BadRequest("expected")

    assert invoke(standalone_runtime) == ("200 OK", b"standalone:POST")
    assert invoke(RuntimeApplication().bound_runtime) == ("200 OK", b"bound:/typed")
    failure_status, failure_body = invoke(failure_runtime)
    assert failure_status.startswith("400 ") and b"expected" in failure_body


def verify_packaging(repository: Path) -> None:
    use_source(repository)
    from packaging.markers import Marker

    expressions = [
        'python_version < "3.10" and ((sys_platform == "linux" or sys_platform == "darwin"))',
        'os_name == "posix" or ((python_version >= "3.12" and platform_machine == "arm64"))',
    ]
    environments = [
        {"python_version": "3.9", "sys_platform": "linux", "os_name": "posix", "platform_machine": "x86_64"},
        {"python_version": "3.12", "sys_platform": "darwin", "os_name": "posix", "platform_machine": "arm64"},
        {"python_version": "3.12", "sys_platform": "linux", "os_name": "nt", "platform_machine": "x86_64"},
    ]
    for expression in expressions:
        marker = Marker(expression)
        reparsed = Marker(str(marker))
        for environment in environments:
            assert reparsed.evaluate(environment) == marker.evaluate(environment)


VERIFIERS: dict[str, Callable[[Path], None]] = {
    "attrs": verify_attrs,
    "click": verify_click,
    "h11": verify_h11,
    "hpack": verify_hpack,
    "packaging": verify_packaging,
    "werkzeug": verify_werkzeug,
}


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in VERIFIERS:
        print("usage: verify.py <attrs|click|h11|hpack|packaging|werkzeug> <repository>", file=sys.stderr)
        return 2
    repository = Path(sys.argv[2]).resolve()
    if not repository.is_dir():
        print("repository must be an existing directory", file=sys.stderr)
        return 2
    try:
        VERIFIERS[sys.argv[1]](repository)
    except Exception as error:
        print(f"{sys.argv[1]} verifier failed: {error}", file=sys.stderr)
        return 1
    print(f"{sys.argv[1]} verifier passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
