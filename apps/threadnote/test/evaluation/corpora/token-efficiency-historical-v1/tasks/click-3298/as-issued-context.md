Any instance of `semver.Version` set as `default` in an option will lead to an error when Click tries to show it in the help text.
The problem seems to be that `Version` allows comparison to strings, and Click, when building the help text, tries to check the default value against an empty string `""`, which cannot be parsed by `semver.Version`:

```
  File ".venv/lib/python3.12/site-packages/click/core.py", line 3091, in get_help_extra
    elif default_value == "":
         ^^^^^^^^^^^^^^^^^^^
  File ".venv/lib/python3.12/site-packages/semver/version.py", line 52, in wrapper
    return operator(self, other)
           ^^^^^^^^^^^^^^^^^^^^^
  File ".venv/lib/python3.12/site-packages/semver/version.py", line 467, in __eq__
    return self.compare(other) == 0
           ^^^^^^^^^^^^^^^^^^^
  File ".venv/lib/python3.12/site-packages/semver/version.py", line 394, in compare
    other = cls.parse(other)
            ^^^^^^^^^^^^^^^^
  File ".venv/lib/python3.12/site-packages/semver/version.py", line 644, in parse
    raise ValueError(f"{version} is not valid SemVer string")
ValueError:  is not valid SemVer string
```

This can be replicated with the following code by trying to print the help text:

<details>

```python
import click
from semver import Version


class SemverType(click.ParamType):
    name = "semver"

    def convert(self, value: str | Version, param: click.Parameter | None, ctx: click.Context | None) -> Version:
        if isinstance(value, Version):
            return value

        try:
            return Version.parse(value)
        except ValueError as e:
            raise self.fail(str(e), param, ctx) from e


@click.command()
@click.option(
    "--version",
    type=SemverType(),
    default=Version(1, 0, 0),
    show_default=True,
)
def cli(version: Version | None) -> None:
    print(version)


if __name__ == "__main__":
    cli()
```

</details>

By quickly inspecting the code, I'd say this could be fixed by checking whether `default_value` is actually a string before comparing it to `""`. 

Environment:

- Python version: 3.12
- Click version: 8.3.1
- semver version: 3.0.4

