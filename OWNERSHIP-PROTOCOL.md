# Ownership Protocol Proposal

## Decision

Use a global JSON sidecar directory as the ownership authority.

Store it at `~/.pi/agent/crew/ownership`.

Use one atomic file for each globally unique Herdr member name.

Use the Herdr name and child session path as the member incarnation identity.

Require an explicit `transfer` action when another Pi session takes control.

## Required record

Store one record for each globally unique Herdr member name.

```text
memberName           file identity
memberId             stable random identity
sessionPath          member incarnation identity
ownerSessionId       current Pi owner
generation           transfer version
state                opening | active
paneId               latest live location
updatedAt            diagnostic timestamp
```

Do not use a pane ID as the durable identity. A pane move changes that ID.

## Atomic operations

Use an atomic per-member lock directory for each ownership change.

Write a temporary file, sync it, and rename it over the ownership record.

A transfer must read and update one record while it holds the same lock.

The transfer must match the expected generation and member incarnation.

The transfer increments `generation` and changes `owner_session_id`.

A stale owner must reject each later write after its generation check fails.

A watcher must verify ownership while it holds the same per-member lock.

Call the synchronous `pi.sendMessage` before the lock is released.

This sequence prevents a transfer from crossing a notification send.

## Start and reconnect

Create an `opening` record before the extension starts a Herdr agent.

Change the record to `active` after Herdr returns the child session path.

On `session_start`, restore session entries and reconnect only matching owned records.

Reconcile each loaded record with `herdr agent get`.

Start a watcher only for an owned record with a pending task.

Do not adopt unowned agents during status or member resolution.

## Recovery

A different Pi session must call `transfer` with the member name.

The transfer reads the live Herdr agent before it changes ownership.

The live child session path must match the stored incarnation.

The transfer can repair an `opening` record after an interrupted start.

If the live agent is absent, do not transfer the record.

Never close a live unowned pane as name reconciliation.

## Storage and permissions

Create sidecar files with mode `0600`.

Keep orchestration result files in the repository `.pi/crew` directory.

Do not put global ownership records in a repository directory.

## Status behavior

Compute `crew status` from records owned by the current session only.

Remove the persistent member status label, or refresh it after every ownership check.

The first option gives the smallest strict design.

## Sidecar requirement

A sidecar is required with the current Herdr API.

Herdr has no custom owner metadata.

Pi session entries are visible only through the current session history.

Neither source can prove ownership during transfer to another session.
