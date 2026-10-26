import {spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {expect, it} from 'vitest';
import fc from 'fast-check';

// Host test controller only: exercise real pipe codecs without a release build.
const controller = 'apps/threadnote/test/dev-skills/native-release-workflows.py';
const program = String.raw`import hashlib, json, locale, runpy, subprocess, sys
from unittest.mock import patch

run_utf8 = runpy.run_path(sys.argv[1])["_run_utf8"]
body = json.load(sys.stdin)["body"]
options = {"text": True, "capture_output": True, "check": True, "timeout": 5}
producer = "import sys;sys.stdout.buffer.write(bytes.fromhex(sys.argv[1]))"
reader = ("import json,sys;body=sys.stdin.read();"
          "sys.stdout.buffer.write(json.dumps({'body':body},ensure_ascii=False).encode('utf-8'))")
def emit(data, runner=run_utf8):
    return runner([sys.executable, "-c", producer, data.hex()], **options)
def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
def roundtrip(value):
    # Git document bytes -> Python text -> UTF-8 reader stdin -> native JSON stdout.
    raw = emit(value.encode("utf-8")).stdout
    result = run_utf8([sys.executable, "-c", reader], input=raw, **options)
    durable = json.loads(result.stdout)["body"].strip() + "\n"
    expected = value.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"
    assert durable == expected
    assert digest(durable) == digest(expected)
    return durable

# Deterministic Windows-style ANSI default on every CI host. Only the locale
# selector is controlled; Popen, pipes, codecs, JSON and SHA-256 remain real.
assert sys.flags.utf8_mode == 0
text_wrapper = subprocess.io.TextIOWrapper
def ansi_default(buffer, *args, **kwargs):
    # Python 3.9 delegates the omitted encoding to TextIOWrapper's C locale;
    # newer Python versions select it through locale.getencoding instead.
    if kwargs.get("encoding") is None:
        kwargs["encoding"] = "cp1252"
    return text_wrapper(buffer, *args, **kwargs)
with patch.object(subprocess.io, "TextIOWrapper", side_effect=ansi_default), \
     patch.object(locale, "getpreferredencoding", return_value="cp1252"), \
     patch.object(locale, "getencoding", return_value="cp1252", create=True):
    roundtrip(body)
    if sys.argv[2] == "examples":
        # PYTHONIOENCODING configures Python stdio, not Popen's default text codec.
        assert sys.stdout.encoding.lower().replace("-", "") == "utf8"
        wire = json.dumps({"body": body}, ensure_ascii=False).encode("utf-8")
        implicit = emit(wire, subprocess.run).stdout
        corrupted = json.loads(implicit)["body"].strip() + "\n"
        assert corrupted != body.strip() + "\n"
        assert digest(corrupted) != digest(body.strip() + "\n")
        # The existing full-body assertion can agree with equally misdecoded
        # preview JSON while the independent expected SHA correctly rejects it.
        assert corrupted == json.loads(emit(wire, subprocess.run).stdout)["body"].strip() + "\n"
        assert json.loads(emit(wire).stdout)["body"] == body
        assert roundtrip(body.replace("\n", "\r\n")) == body.strip() + "\n"
        for stream in ("stdout", "stderr"):
            invalid = [sys.executable, "-c", "import sys;sys." + stream + ".buffer.write(bytes.fromhex('ff'))"]
            try:
                run_utf8(invalid, **options)
            except UnicodeDecodeError:
                pass
            else:
                raise AssertionError("Malformed UTF-8 was accepted on " + stream)
        try:
            run_utf8([sys.executable, "-c", "import sys;sys.stderr.buffer.write(bytes.fromhex('636166c3a9'));sys.exit(7)"], **options)
        except subprocess.CalledProcessError as error:
            assert error.returncode == 7 and error.stderr == "caf\u00e9"
        else:
            raise AssertionError("Nonzero exit was accepted")
        # The wrapper does not replace or project TimeoutExpired; the existing
        # finish handler remains responsible for its bounded stdout projection.
        timeout = subprocess.TimeoutExpired(["fixture"], 180, output=b'{"status":"ok"}')
        with patch.object(subprocess, "run", side_effect=timeout):
            try:
                run_utf8(["fixture"], timeout=180)
            except subprocess.TimeoutExpired as error:
                assert error is timeout and error.stdout == b'{"status":"ok"}'
            else:
                raise AssertionError("Timeout was accepted")
print(json.dumps({"status": "passed"}))
`;

const check = (body: string, mode: 'examples' | 'roundtrip') => {
  const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-B', '-X', 'utf8=0', '-c', program, resolve(controller), mode], {
    encoding: 'utf8',
    input: JSON.stringify({body}),
    env: {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1'},
    timeout: 15_000,
  });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({status: 'passed'});
};

it('preserves native UTF-8 bodies and hashes under an ANSI locale and rejects malformed pipes', () => {
  check('café — λ 測試 🧪\nnext → €\n', 'examples');
});

it('roundtrips bounded Unicode and newline combinations through real document and JSON pipes', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('é', '—', 'λ', '測', '🧪', '\n', '\r\n', '\r', 'a'), {minLength: 1, maxLength: 12}),
      values => check(values.join(''), 'roundtrip'),
    ),
    {numRuns: 8, seed: 931},
  );
});
