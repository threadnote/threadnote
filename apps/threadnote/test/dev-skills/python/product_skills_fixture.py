"""Test-only installed payload selection and provenance; never imported by product code."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import sys

SKILL_IDS = ("dev-cycle", "dev-plan", "dev-spec", "watch-pr")
OVERRIDE = "DEV_WORKFLOW_INSTALLED_SKILLS"
PROVENANCE = "DEV_WORKFLOW_PROVENANCE_DIR"
sys.dont_write_bytecode = True


def require(condition, message):
    if not condition:
        raise RuntimeError(OVERRIDE + ": " + message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical_manifest(manifest):
    """Independent serialization of the release's declared bundle digest contract."""
    skills = [{"id": item["id"], "role": item["role"], "files": sorted(item["files"])}
              for item in sorted(manifest["skills"], key=lambda item: item["id"])]
    return {"schemaVersion": manifest["schemaVersion"], "workflowProtocol": manifest["workflowProtocol"],
            "stateSchema": manifest["stateSchema"], "minimumRuntime": manifest["minimumRuntime"],
            "releaseVersion": manifest["releaseVersion"],
            "prerequisites": {key: manifest["prerequisites"][key] for key in ("python", "commands", "prCommands")},
            "skills": skills, "hashes": {skill["id"] + "/" + name: manifest["hashes"][skill["id"] + "/" + name]
                                         for skill in skills for name in skill["files"]}}


def inventory(root):
    files = {}
    for file in sorted(root.rglob("*")):
        require(not file.is_symlink(), "generation contains a symlink: " + str(file))
        if file.is_file():
            files[file.relative_to(root).as_posix()] = sha256(file.read_bytes())
        else:
            require(file.is_dir(), "generation contains a non-file entry: " + str(file))
    return files


def validate_generation(root):
    require(root.is_absolute() and root.is_dir(), "select an existing absolute immutable generation directory")
    require(not root.is_symlink(), "generation root must not be a symlink")
    root = root.resolve()
    require(root.parent.name == "generations" and root.parent.parent.name == ".threadnote-dev-skills"
            and re.fullmatch(r"[a-f0-9]{64}", root.name), "expected .threadnote-dev-skills/generations/<digest>")
    receipt_path = root.parent.parent / "receipt.json"
    try:
        receipt_bytes = receipt_path.read_bytes()
        receipt = json.loads(receipt_bytes)
        manifest = receipt["generations"][root.name]
        canonical = canonical_manifest(manifest)
        digest = sha256(json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        require(manifest["digest"] == root.name == digest, "generation digest does not match its ownership manifest")
        require(tuple(item["id"] for item in canonical["skills"]) == SKILL_IDS, "complete four-member bundle required")
        hashes = inventory(root)
        require(hashes == manifest["hashes"] == canonical["hashes"], "generation inventory or bytes differ from receipt")
        for skill in SKILL_IDS:
            require((root / skill / "SKILL.md").is_file() and (root / skill / "scripts").is_dir(),
                    "missing workflow entrypoint or scripts: " + skill)
        return {"generationRoot": str(root), "bundleDigest": digest, "releaseVersion": manifest["releaseVersion"],
                "receiptPath": str(receipt_path), "receiptSha256": sha256(receipt_bytes), "fileHashes": hashes}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError(OVERRIDE + ": invalid generation ownership: " + str(error)) from error


def assert_product_provenance(root, label="imports"):
    root = Path(root).resolve()
    expected = {file.stem for file in root.glob("*/scripts/*.py")}
    modules = {}
    for name, module in tuple(sys.modules.items()):
        if name.rsplit(".", 1)[-1] not in expected:
            continue
        filename = getattr(module, "__file__", None)
        require(filename is not None and Path(filename).resolve().is_relative_to(root),
                "product module escaped the selected generation: " + name + " = " + str(filename))
        relative = Path(filename).resolve().relative_to(root).as_posix()
        modules[name] = {"path": relative, "sha256": sha256(Path(filename).read_bytes())}
    result = {"schemaVersion": 1, "label": label, "mode": "source", "generationRoot": str(root), "modules": modules}
    if OVERRIDE in os.environ:
        require(Path(os.environ[OVERRIDE]).resolve() == root, "selected generation changed during the fixture")
        result.update(validate_generation(root), mode="installed")
        if PROVENANCE in os.environ:
            directory = Path(os.environ[PROVENANCE]).resolve()
            require(not directory.is_relative_to(root), "provenance output must stay outside the immutable generation")
            directory.mkdir(parents=True, exist_ok=True)
            filename = re.sub(r"[^a-zA-Z0-9_.-]", "_", label)[:160] + "-" + str(os.getpid()) + ".json"
            (directory / filename).write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return result


def configure_product_skills(test_file, source_parents):
    # Resolve source-relative paths only in source mode. Copied fixtures may have
    # fewer ancestors, and must work while the checkout is denied by the OS.
    if OVERRIDE in os.environ:
        root = Path(os.environ[OVERRIDE])
        validate_generation(root)
        root = root.resolve()
    else:
        root = Path(test_file).resolve().parents[source_parents] / "apps/threadnote/test/dev-skills/python/oracle-skills"
        require(root.is_dir(), "source payload is missing; supply the explicit installed generation for copied fixtures")
    assert_product_provenance(root, "before-imports")
    sys.path[:0] = [str(root / skill / "scripts") for skill in ("dev-spec", "dev-plan", "dev-cycle", "watch-pr")]
    return root


if __name__ == "__main__":
    selected = configure_product_skills(__file__, 5)
    for name in sorted({file.stem for file in selected.glob("*/scripts/*.py")}):
        importlib.import_module(name)
    print(json.dumps(assert_product_provenance(selected, "all-product-imports"), sort_keys=True))
