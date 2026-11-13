"""Print the NoDo backend's own settings verdict as JSON.

TestParityWithBackend runs this with a clean environment and compares the
result with nodoctl. Only the standard library is needed, because
backend/app/core/config.py imports nothing else.
"""

import sys

sys.dont_write_bytecode = True  # keep backend/ free of __pycache__

import importlib.util  # noqa: E402
import json  # noqa: E402

report = {"load": "", "checks": {}, "skipped": []}
try:
    spec = importlib.util.spec_from_file_location("nodo_config", sys.argv[1])
    config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config)
except RuntimeError as error:
    report["load"] = str(error)
    print(json.dumps(report))
    sys.exit(0)

settings = config.settings


def record(name, check):
    try:
        check()
        report["checks"][name] = ""
    except RuntimeError as error:
        report["checks"][name] = str(error)


record("startup", settings.validate_startup)
if settings.storage_mode == "cloud":
    record("storage_uploads", settings.ensure_private_storage_uploads_enabled)
else:
    report["skipped"].append("storage_uploads")
if settings.vertex_ai_mode == "vertex":
    record("vertex_drafts", settings.ensure_vertex_ai_drafts_enabled)
    record("vertex_assistant", settings.ensure_vertex_ai_student_assistant_enabled)
else:
    report["skipped"] += ["vertex_drafts", "vertex_assistant"]
print(json.dumps(report))
