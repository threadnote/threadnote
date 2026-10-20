"""Selector/provenance guard units; synthetic files are not native release evidence."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from product_skills_fixture import (OVERRIDE, PROVENANCE, assert_product_provenance,
                                    configure_product_skills, validate_generation)


class InstalledFixtureSelection(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="workflow-loader-unit-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.addCleanup(setattr, sys, "path", list(sys.path))

    def generation(self):
        # Deliberately tiny synthetic receipt: only tests selector guards. Actual
        # lifecycle fixtures require a generation installed by the real CLI.
        files = {skill + "/" + name: value for skill in ("dev-cycle", "dev-plan", "dev-spec", "watch-pr")
                 for name, value in (("SKILL.md", b"fixture\n"), ("scripts/fixture_product.py", b"value = 1\n"))}
        manifest = {"schemaVersion": 1, "workflowProtocol": 1, "stateSchema": 1,
                    "minimumRuntime": "5.3.0-beta.4", "releaseVersion": "5.3.0-beta.4",
                    "prerequisites": {"python": ">=3.10", "commands": ["threadnote", "git", "rg"], "prCommands": ["gh"]},
                    "skills": [{"id": skill, "role": "support" if skill == "watch-pr" else "primary",
                                "files": ["SKILL.md", "scripts/fixture_product.py"]}
                               for skill in ("dev-cycle", "dev-plan", "dev-spec", "watch-pr")],
                    "hashes": {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}
        digest = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        manifest["digest"] = digest
        physical = self.root / "host/.threadnote-dev-skills"
        generation = physical / "generations" / digest
        for name, content in files.items():
            target = generation / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (physical / "receipt.json").write_text(json.dumps({"generations": {digest: manifest}}), encoding="utf-8")
        return generation

    def test_installed_override_never_evaluates_source_checkout_ancestors(self):
        generation = self.generation()
        with patch.dict(os.environ, {OVERRIDE: str(generation)}, clear=True):
            self.assertEqual(configure_product_skills(self.root / "fixture.py", 999), generation)

    def test_empty_missing_relative_and_non_generation_roots_do_not_fall_back(self):
        for value in ("", "relative", str(self.root / "missing"), str(self.root)):
            with self.subTest(value=value), patch.dict(os.environ, {OVERRIDE: value}, clear=True):
                with self.assertRaisesRegex(RuntimeError, OVERRIDE):
                    configure_product_skills(self.root / "fixture.py", 999)

    def test_changed_extra_missing_and_renamed_generation_bytes_are_rejected(self):
        generation = self.generation()
        file = generation / "dev-plan/scripts/fixture_product.py"
        original = file.read_bytes()
        for mutation in ("changed", "missing", "extra"):
            with self.subTest(mutation=mutation):
                if mutation == "changed": file.write_bytes(b"changed\n")
                elif mutation == "missing": file.unlink()
                else: (generation / "extra.py").write_bytes(b"unowned\n")
                with self.assertRaisesRegex(RuntimeError, "inventory or bytes"):
                    validate_generation(generation)
                file.write_bytes(original)
                (generation / "extra.py").unlink(missing_ok=True)
        renamed = generation.with_name("0" * 64)
        generation.rename(renamed)
        with self.assertRaisesRegex(RuntimeError, "invalid generation ownership"):
            validate_generation(renamed)

    def test_preloaded_product_module_cannot_escape_selected_generation(self):
        generation = self.generation()
        module = types.ModuleType("fixture_product")
        module.__file__ = str(self.root / "checkout/fixture_product.py")
        with patch.dict(sys.modules, fixture_product=module):
            with self.assertRaisesRegex(RuntimeError, "product module escaped"):
                assert_product_provenance(generation)

    def test_provenance_hashes_modules_and_never_writes_into_generation(self):
        generation = self.generation()
        module = types.ModuleType("fixture_product")
        module.__file__ = str(generation / "dev-plan/scripts/fixture_product.py")
        output = self.root / "evidence"
        with patch.dict(sys.modules, fixture_product=module), patch.dict(
                os.environ, {OVERRIDE: str(generation), PROVENANCE: str(output)}, clear=True):
            report = assert_product_provenance(generation, "unit")
            self.assertEqual(report["bundleDigest"], generation.name)
            self.assertEqual(report["modules"]["fixture_product"]["sha256"],
                             report["fileHashes"]["dev-plan/scripts/fixture_product.py"])
            self.assertEqual(json.loads(next(output.glob("*.json")).read_text()), report)
            os.environ[PROVENANCE] = str(generation / "evidence")
            with self.assertRaisesRegex(RuntimeError, "outside the immutable generation"):
                assert_product_provenance(generation)
        self.assertFalse((generation / "evidence").exists())

    def test_copied_native_loaders_fail_explicitly_without_valid_override(self):
        source = Path(__file__).parent
        copied = self.root / "fixtures"
        copied.mkdir()
        for name in ("product_skills_fixture.py", "test_personal_cloud_workflow.py",
                     "dev-spec/test_dev_spec.py", "dev-plan/test_dev_plan.py"):
            target = copied / name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(source / name, target)
        for name in ("test_personal_cloud_workflow.py", "dev-spec/test_dev_spec.py", "dev-plan/test_dev_plan.py"):
            with self.subTest(loader=name):
                environment = dict(os.environ, DEV_WORKFLOW_INSTALLED_SKILLS=str(self.root / "absent"), PYTHONPATH="")
                result = subprocess.run([sys.executable, "-B", str(copied / name), "-q"],
                                        cwd=self.root, env=environment, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(OVERRIDE, result.stderr)
                self.assertNotIn("IndexError", result.stderr)


if __name__ == "__main__":
    unittest.main()
