from __future__ import annotations

import argparse
from pathlib import Path

from robogjc.db import Database, issue_key


def seed(path: Path) -> None:
    if path.exists():
        path.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = path.with_name(path.name + suffix)
        if sidecar.exists():
            sidecar.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = Database(path)
    try:
        db.record_event(delivery_id="fixture-queued", event_type="issues", repo="octo/widget", issue_key=issue_key("octo/widget", 101), payload={"action": "opened", "issue": {"number": 101}})
        db.record_event(delivery_id="fixture-running", event_type="issue_comment", repo="octo/widget", issue_key=issue_key("octo/widget", 102), payload={"action": "created", "comment": {"id": 202}})
        db.claim_next_event()
        db.record_event(delivery_id="fixture-done", event_type="issues", repo="octo/widget", issue_key=issue_key("octo/widget", 103), payload={"action": "closed"}, state="done")
        db.record_event(delivery_id="fixture-failed", event_type="issues", repo="octo/widget", issue_key=issue_key("octo/widget", 104), payload={"action": "opened"}, state="failed", last_error="fixture failure")
        db.record_event(delivery_id="fixture-skipped", event_type="issues", repo="octo/widget", issue_key=issue_key("octo/widget", 105), payload={"action": "labeled"}, state="skipped", last_error="issues.labeled ignored")
        db.set_event_model("fixture-running", "fixture-model")

        db.upsert_issue(key=issue_key("octo/widget", 101), repo="octo/widget", number=101, state="opened", branch="farm/fixture/issue-101", session_dir="/tmp/fixture-session", pr_number=501)
        db.set_issue_classification(issue_key("octo/widget", 101), "bug")
        db.upsert_issue(key=issue_key("octo/widget", 202), repo="octo/widget", number=202, state="new")
        db.set_issue_classification(issue_key("octo/widget", 202), "question")

        db.log_tool_call(issue_key=issue_key("octo/widget", 101), tool="gh_post_comment", args={"body": "hello"}, result={"comment_id": 9001})
        db.log_tool_call(issue_key=issue_key("octo/widget", 101), tool="set_issue_labels", args={"labels": ["bug"]}, error="fixture tool error")

        db.record_submission(delivery_id="fixture-submission-a", login="Alice", repo="octo/widget")
        db.record_submission(delivery_id="fixture-submission-b", login="bob", repo="octo/widget")
        db.admit_submission(delivery_id="fixture-submission-c", login="Charlie", repo="octo/widget", since="2000-01-01T00:00:00.000000Z", cap=10)

        db.upsert_pending_closure(issue_key=issue_key("octo/widget", 303), repo="octo/widget", number=303, comment_id=7001, issue_author="Alice", close_at="2030-01-01T00:00:00.000000Z")
        db.upsert_pending_closure(issue_key=issue_key("octo/widget", 304), repo="octo/widget", number=304, comment_id=7002, issue_author="Bob", close_at="2000-01-01T00:00:00.000000Z")
        db.claim_due_closures(now="2026-05-15T00:00:00.000000Z", limit=1)
        db.upsert_pending_closure(issue_key=issue_key("octo/widget", 305), repo="octo/widget", number=305, comment_id=7003, issue_author="Carol", close_at="2000-01-01T00:00:00.000000Z")
        db.claim_due_closures(now="2026-05-15T00:00:00.000000Z", limit=1)
        db.finalize_closure(issue_key("octo/widget", 305), state="closed", reason=None)
        db.upsert_pending_closure(issue_key=issue_key("octo/widget", 306), repo="octo/widget", number=306, comment_id=7004, issue_author="Dana", close_at="2030-01-01T00:00:00.000000Z")
        db.cancel_pending_closure(issue_key("octo/widget", 306), reason="user_replied")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path, nargs="?", default=Path("artifacts/robogjc/db/python-era-v1.sqlite"))
    args = parser.parse_args()
    seed(args.output)
