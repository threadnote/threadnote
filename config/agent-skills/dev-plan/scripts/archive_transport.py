"""Exact legacy native archive plans; no workflow rebinding or executable installation."""
import sys
sys.dont_write_bytecode = True

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def require(value, message):
    if not value:
        from dev_plan import PlanError
        raise PlanError(message)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def is_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


class LegacyArchiveTransport:
    def __init__(self, client, policy_path=None):
        self.client = client
        self.repo = str(Path(client.repo).resolve()) if client.repo else None
        self.home = client.home
        self.environment = dict(os.environ)
        self.executable = None
        self.executable_hash = None
        self.identity = None
        self.policy = None
        if policy_path is not None:
            self.policy = json.loads(Path(policy_path).read_text(encoding="utf-8"))
            required = {"version", "executablePath", "executableSha256", "account", "user",
                        "agentContextHome", "sourceUris", "ownerApproval"}
            require(isinstance(self.policy, dict) and set(self.policy) == required and type(self.policy["version"]) is int and self.policy["version"] == 1,
                    "Unsupported archive runtime policy")
            for key in ("account", "user", "agentContextHome", "ownerApproval"):
                require(isinstance(self.policy[key], str) and self.policy[key].strip(),
                        "Archive runtime policy lacks " + key)
            sources = self.policy["sourceUris"]
            require(isinstance(sources, list) and sources
                    and all(isinstance(uri, str) and uri.startswith("threadnote://") for uri in sources)
                    and len(set(sources)) == len(sources),
                    "Archive runtime policy requires the exact permitted source URI set")
            self.executable = self._immutable_path(self.policy["executablePath"])
            self.executable_hash = self.policy["executableSha256"]
            require(is_hash(self.executable_hash) and file_hash(self.executable) == self.executable_hash,
                    "Archive policy executable bytes changed; no native call attempted")

    @staticmethod
    def _immutable_path(value):
        require(isinstance(value, str) and Path(value).is_absolute(), "Archive runtime needs an absolute executable")
        path = Path(value)
        require(path.is_file() and str(path.resolve()) == str(path),
                "Archive runtime needs its existing canonical immutable executable path")
        return str(path)

    def _call(self, request):
        require((str(Path(self.client.repo).resolve()) if self.client.repo else None) == self.repo
                and self.client.home == self.home, "Archive caller checkout or home changed")
        if self.executable is not None:
            require(file_hash(self.executable) == self.executable_hash,
                    "Archive executable bytes changed; no native call attempted")
            executable = self.executable
        else:
            executable = shutil.which("threadnote", path=self.environment.get("PATH"))
            require(executable, "Native memory-archive support is unavailable; no write or retirement attempted")
        argv = [executable, "memory-archive"]
        if self.home:
            argv += ["--home", str(self.home)]
        completed = subprocess.run(argv, input=json.dumps(request, ensure_ascii=True), text=True,
                                   encoding="utf-8", capture_output=True, cwd=self.repo,
                                   env=self.environment, timeout=55)
        try:
            response = json.loads(completed.stdout)
        except (TypeError, ValueError) as error:
            from dev_plan import PlanError
            raise PlanError("Native memory-archive did not return its supported structured protocol; "
                            "no legacy archive fallback is permitted") from error
        require(isinstance(response, dict) and response.get("version") == 1,
                "Unsupported native archive protocol")
        if response.get("status") == "error":
            require(False, "Native archive refused: " + str(response.get("code", "unknown")) + ": "
                    + str(response.get("message", "Unknown native archive error")))
        require(completed.returncode == 0 and response.get("status") == "ok", "Native archive request failed")
        return response

    def _pin(self, native):
        fields = {"version", "planId", "timestamp", "archiveKey", "source", "destination", "runtime", "config"}
        require(isinstance(native, dict) and set(native) == fields
                and type(native.get("version")) is int and native["version"] == 1
                and is_hash(native.get("planId")) and is_hash(native.get("archiveKey"))
                and isinstance(native.get("timestamp"), str)
                and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", native["timestamp"]),
                "Native archive plan identity is missing or unsupported")
        runtime, config = native.get("runtime"), native.get("config")
        require(isinstance(runtime, dict) and set(runtime) == {"executablePath", "sha256"}
                and is_hash(runtime.get("sha256")) and isinstance(config, dict),
                "Native archive plan lacks its runtime/config identity")
        config_fields = {"agentContextHome", "realHome", "manifestPath", "manifestRealPath",
                         "manifestSha256", "account", "user", "agentId"}
        require(set(config) == config_fields and is_hash(config["manifestSha256"])
                and all(isinstance(config[key], str) and config[key] for key in config_fields),
                "Native archive plan has an unsupported configuration identity")
        executable = self._immutable_path(runtime["executablePath"])
        require(file_hash(executable) == runtime["sha256"], "Native archive executable differs from its plan")
        require(self.executable is None or (self.executable == executable and self.executable_hash == runtime["sha256"]),
                "Archive plan switched its pinned executable")
        identity = fingerprint({"runtime": runtime, "config": config})
        require(self.identity is None or self.identity == identity, "Native archive configuration or identity changed")
        for key in ("source", "destination"):
            target = native.get(key)
            require(isinstance(target, dict) and set(target) == {"uri", "sha256", "bytes"}
                    and isinstance(target["uri"], str) and target["uri"].startswith("threadnote://")
                    and is_hash(target["sha256"]) and type(target["bytes"]) is int and target["bytes"] >= 0,
                    "Native archive plan lacks exact " + key + " identity")
        if self.policy is not None:
            require(native["source"]["uri"] in self.policy["sourceUris"], "Archive source is outside its runtime policy")
            require(all(config.get(key) == self.policy[key] for key in ("account", "user"))
                    and Path(config["agentContextHome"]).resolve() == Path(self.policy["agentContextHome"]).resolve(),
                    "Native archive identity differs from the scoped runtime policy")
        self.executable, self.executable_hash, self.identity = executable, runtime["sha256"], identity

    def _native(self, plan):
        require(isinstance(plan, dict) and set(plan) == {"transport", "plan", "preview"}
                and plan.get("transport") == "legacy-native-v1" and isinstance(plan.get("preview"), dict),
                "Wrong archive plan transport")
        native = plan.get("plan")
        self._pin(native)
        require(plan.get("preview", {}).get("canonicalUri") == native["destination"]["uri"],
                "Native archive admission changed its destination")
        return native

    def plan_archive(self, uri):
        if self.policy is not None:
            require(uri in self.policy["sourceUris"], "Archive source is outside its runtime policy")
        response = self._call({"version": 1, "action": "plan", "uri": uri})
        native = response.get("plan")
        self._pin(native)
        require(native["source"]["uri"] == uri, "Native archive plan targets another source")
        return {"transport": "legacy-native-v1", "plan": native,
                "preview": {"canonicalUri": native["destination"]["uri"]}}

    def _result(self, response, native, statuses):
        result = response.get("result")
        require(isinstance(result, dict) and result.get("version") == 1
                and result.get("planId") == native["planId"]
                and result.get("sourceUri") == native["source"]["uri"]
                and result.get("destinationUri") == native["destination"]["uri"]
                and result.get("status") in statuses, "Native archive result differs from its admitted plan")
        return result

    def validate_archive_plans(self, plans):
        for plan in plans:
            native = self._native(plan)
            response = self._call({"version": 1, "action": "check", "plan": native})
            self._result(response, native, {"ready", "already-archived"})

    def archive(self, uri, plan):
        native = self._native(plan)
        require(native["source"]["uri"] == uri, "Native archive plan targets another source")
        response = self._call({"version": 1, "action": "commit", "plan": native})
        return self._result(response, native, {"archived", "already-archived"})["destinationUri"]
