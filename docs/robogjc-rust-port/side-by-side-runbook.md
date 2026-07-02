# robogjc Rust port side-by-side runbook

## Modes

### Active

The active implementation is the only deployment subscribed to live GitHub webhooks for a repository allowlist entry. It may claim queued events, mutate GitHub state, write PR branches, post comments, open PRs, close issues, and update durable state.

### Standby

The standby implementation is deployed and ready for rollback, but it is not subscribed to live webhooks and must not consume live delivery streams. Operators may start it against a restored database or rollback webhook subscription, but it remains non-mutating while standby.

### Shadow

Shadow mode may observe mirrored inputs or replay fixtures for comparison. It must not acknowledge live webhook deliveries, claim live queue rows, push branches, post comments, open PRs, close issues, or otherwise mutate repository state.

## One mutating consumer per repo allowlist

For every repository in the allowlist, exactly one implementation may be mutating at a time. The allowlist is the unit of safety: do not run Python and Rust as active consumers for the same repo, even if they use separate webhook routes or queue workers. Shadow and standby deployments are allowed only when they are mechanically prevented from mutating that repo.

## Early cutover decision

The approved early-cutover decision is:

- Rust becomes active after the Phase 7 checkpoint.
- Python moves to standby after the Phase 7 checkpoint.
- Python is unsubscribed from live webhooks after Rust becomes active.
- Python remains deployable as rollback until Phase 10.

## Operational checklist

1. Confirm the repo allowlist and webhook subscription map.
2. Confirm Python is either active or standby, never active alongside Rust for the same repo.
3. Before Phase 7, keep Python active and run Rust only in non-mutating shadow paths.
4. At the Phase 7 checkpoint, switch live webhook subscription for the repo allowlist to Rust.
5. After the switch, verify Python is unsubscribed from live webhooks but remains deployable.
6. Keep Python rollback deployability until Phase 10; after Phase 10, remove the standby dependency according to the deletion plan.
