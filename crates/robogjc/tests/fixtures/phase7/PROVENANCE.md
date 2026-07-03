# Phase 7 fixture provenance

These NDJSON fixtures are authoritative replay transcripts for `crates/robogjc/src/worker.rs` tests. They were regenerated from the injectable `AppServerTransport` harness after resolving the stage-07 architect findings so each outbound frame matches real Rust worker output and each inbound notification is replayed through the same notification parser used by the stdio client.
