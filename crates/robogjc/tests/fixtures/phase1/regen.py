#!/usr/bin/env python3
"""Regenerate Phase 1 Rust-port fixtures from the Python robogjc sources.

Run from the monorepo root with either:
  /tmp/robogjc-uv/bin/python crates/robogjc/tests/fixtures/phase1/regen.py
or, when using uv-managed tooling:
  uv run python crates/robogjc/tests/fixtures/phase1/regen.py
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
PY_SRC = ROOT / "python" / "robogjc" / "src"
OUT_DIR = ROOT / "crates" / "robogjc" / "tests" / "fixtures" / "phase1"

sys.path.insert(0, str(PY_SRC))

from proxy_hmac import sign as proxy_sign, verify as proxy_verify  # noqa: E402
from sandbox import workspace_key, make_branch, validate_branch_slug  # noqa: E402
from git_ops import redact_credentials  # noqa: E402


def write_json(name: str, payload: dict) -> None:
    (OUT_DIR / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path: str) -> str:
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def hmac_vectors() -> dict:
    cases = [
        ("get_repo_query", "GET", "/gh/v1/repo?repo=octo%2Fwidget", "", "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1710000000"),
        ("post_json", "post", "/gh/v1/comment", '{"body":"hello","repo":"octo/widget"}', "secret-key", "1710000030"),
        ("unicode_body", "PATCH", "/gh/v1/issues/7", "snowman=☃&emoji=🦀", "unicode-key-✓", "1710000060"),
    ]
    rendered = []
    for name, method, path, body, key, timestamp in cases:
        expected_timestamp, expected_signature = proxy_sign(method=method, path=path, body=body.encode(), key=key.encode(), timestamp=timestamp)
        rendered.append({
            "name": name,
            "method": method,
            "path": path,
            "body": body,
            "key": key,
            "timestamp": timestamp,
            "expected_timestamp": expected_timestamp,
            "expected_signature": expected_signature,
            "verify_ok": proxy_verify(method=method, path=path, body=body.encode(), timestamp=expected_timestamp, signature=expected_signature, key=key.encode(), now=int(timestamp))[0],
        })
    return {"schema_version": 1, "cases": rendered}


def redaction_vectors() -> dict:
    cases = [
        ["basic", "clone https://user:pass@example.com/repo.git", "clone https://***:***@example.com/repo.git"],
        ["multiple", "https://a:b@one.invalid/x and https://two.invalid/y", "https://***:***@one.invalid/x and https://two.invalid/y"],
        ["truncated-at-at", "https://user:p@ss@example.com/repo.git", "https://user:p@ss@example.com/repo.git"],
    ]
    return {"schema_version": 1, "cases": [{"name": n, "input": i, "expected": redact_credentials(i)} for n, i, _ in cases]}


def workspace_vectors() -> dict:
    workspace_cases = []
    for repo, number, title, seed in [
        ("oven-sh/bun", 30654, "JSON.parse crashes on BOM", "oven-sh/bun#30654"),
        ("acme/widgets", 1, "!!!", "acme/widgets#1"),
    ]:
        workspace_cases.append({
            "repo": repo,
            "number": number,
            "expected_key": workspace_key(repo, number),
            "branch_title": title,
            "branch_seed": seed,
            "expected_branch": make_branch(issue_number=number, title=title, seed=seed),
        })
    slug_cases = []
    for slug in ["fix-bug", "a", "x" * 50, "Bad", "bad--slug", "-bad", "bad-", "x" * 51, ""]:
        try:
            validate_branch_slug(slug)
            slug_cases.append({"slug": slug, "ok": True, "error_contains": ""})
        except ValueError as exc:
            slug_cases.append({"slug": slug, "ok": False, "error_contains": "invalid branch slug" if "invalid branch slug" in str(exc) else str(exc)})
    return {"schema_version": 1, "workspace_keys": workspace_cases, "branch_slug_validation": slug_cases}


def main() -> None:
    write_json("hmac-vectors.json", hmac_vectors())
    write_json("redaction-vectors.json", redaction_vectors())
    write_json("workspace-key-vectors.json", workspace_vectors())
    print("Regenerated phase1 fixtures from:")
    for rel in ["python/robogjc/src/proxy_hmac.py", "python/robogjc/src/git_ops.py", "python/robogjc/src/sandbox.py"]:
        print(f"  {rel} sha256={sha(rel)}")


if __name__ == "__main__":
    main()
