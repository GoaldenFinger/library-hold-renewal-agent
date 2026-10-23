# Library Hold & Renewal Agent — Test Report

Date: 22 October 2026
Mode: Simulation (Stabilized Phase 2.2)

## Summary

- Unit test suite: `test/renewal.test.js` covering core renewal eligibility rules.
- Acceptance test suite: `test/acceptance.test.js` covering TC1–TC4, disambiguation, fine policy, and idempotency.
- TC1: Two simulated renewals approved and verified independently.
- TC2: Renewal blocked when another user is waiting; return-date estimation preserved (`expectedReturnDateSource: "scheduled_due_date"`).
- TC3: Ambiguous title search differentiates editions of the same work (`clarificationRequired`) from broad multi-work results (`selectionRequired`).
- TC4: Renewal blocked when the renewal limit is reached; synthetic overdue fine policy applied (₹5 per overdue day in INR).
- Idempotency: Stable `requestId` tracking with response reuse (`reusedRequest: true`), single-pending-approval enforcement (`reusedApproval: true`), and duplicate prevention.

## Verification Status

The automated unit and acceptance tests are implemented and ready for execution.
To maintain verification integrity, tests are run manually in PowerShell by the user using:

```powershell
npm.cmd test
```

## TC1 — Renew Two Books Due Tomorrow

Starting due date: Dynamically calculated via UTC (1 day from current UTC date)

Book 1:
- ID: `BOOK-001`
- Title: Database Management Systems, 2nd edition
- Action: Request renewal with stable `requestId`, verify state unchanged before approval, approve simulated renewal, and verify new due date (+14 days) and `renewalsUsed` incremented to 1.

Book 2:
- ID: `BOOK-004`
- Title: Database Management Systems, 7th edition
- Action: Request renewal with stable `requestId`, verify state unchanged before approval, approve simulated renewal, and verify new due date (+14 days) and `renewalsUsed` incremented to 1.

Result: Both renewals approved separately and verified in the running simulation. No live OPAC or patron record was modified.

## TC2 — Another User Has a Hold

- Book ID: `BOOK-003`
- Title: Operating System Concepts, 10th edition
- Hold queue: 1
- Expected: Renewal blocked with status 409 / eligibility `false`.
- Actual behavior:
  - `eligible: false`
  - `reason: "Another user is waiting for this book."`
  - `returnDate: null` (actual return date unconfirmed)
  - `returnDateStatus: "unknown_pending_return"`
  - `expectedReturnDate`: Scheduled due date of current loan
  - `expectedReturnDateSource: "scheduled_due_date"`
  - `expectedReturnDateType: "derived_estimate"`
- Action taken: `false`
- Evidence: `evidence/TC2-hold-blocked.json`

## TC3 — Ambiguous Book Title Disambiguation

- Search query: `Database`
- Catalogue matches: Exactly 3 editions of "Database Management Systems" (2nd, 3rd, and 7th editions)
- Disambiguation evaluation:
  - `clarificationRequired: true` (all results share normalized work title)
  - `selectionRequired: false`
  - `distinctTitleCount: 1`
  - `workTitle: "Database Management Systems"`
  - `message: "Found 3 matching editions of \"Database Management Systems\". Which edition would you like?"`
- Distinct works evaluation:
  - Evaluated via shared `src/disambiguation.js` when multiple distinct works are returned.
  - Sets `clarificationRequired: false` and `selectionRequired: true`, prompting the user to select a title or narrow search.
- Evidence: `evidence/TC3-ambiguous-title.json`

## TC4 — Renewal Limit Reached & Synthetic Fine Estimation

- Book ID: `BOOK-002`
- Title: Database Management Systems, 3rd edition
- Renewals used: 1
- Renewal limit: 1
- Due date: 3 days prior to current UTC date
- Expected: Block renewal with fine estimate based on simulation policy.
- Actual behavior:
  - `eligible: false`
  - `reason: "The renewal limit has been reached."`
  - `fineEstimate: 15`
  - `fineEstimateCurrency: "INR"`
  - `fineEstimateDaysOverdue: 3`
  - `fineEstimateRatePerDay: 5`
  - `fineEstimateMode: "synthetic_simulation_policy"`
  - `fineEstimateReason: "Synthetic simulation estimate based on policy of ₹5 per overdue day. This is not an actual library fine or real Koha fee policy."`
- Action taken: `false`
- Evidence: `evidence/TC4-renewal-limit.json`

## Renewal Idempotency & Pending Approval Enforcement

- **Stable Request ID**: Clients submit a client-generated or UI-managed `requestId`. Retrying a request with the same `requestId` returns the exact original status and payload marked with `reusedRequest: true`.
- **Single Pending Approval per Book**: If another request arrives for a book with an existing pending approval, the system reuses the existing approval record (`reusedApproval: true`) and returns HTTP 200 without creating a duplicate approval or duplicate audit event.
- **Negative Result Caching**: Blocked requests (such as 409 Conflict for holds or renewal limits) are cached and replayed idempotently.
- **Subsequent Renewals Allowed**: Once a pending approval is approved or rejected, subsequent renewal requests with fresh request IDs are permitted (provided remaining renewal limit allows).

## Acceptance Test Suite

Located at `test/acceptance.test.js`:
- Uses native `node:test` and `node:assert/strict`.
- Runs on ephemeral ports (`listen(0)`) using Express application factory `createApp()`.
- Zero external dependencies or network traffic.
- Covers TC1 (full normal renewal flow with verification), TC2 (hold blocking and return date estimation), TC3 (disambiguation consistency), TC4 (limit blocking and synthetic fines), and Idempotency (replay, single approval per book, audit deduplication, subsequent renewal).

## Evidence Files

- `evidence/TC2-hold-blocked.json` — TC2 response snapshot.
- `evidence/TC3-ambiguous-title.json` — TC3 search response snapshot.
- `evidence/TC4-renewal-limit.json` — TC4 response snapshot.
- `evidence/test-report.md` — This report.
- `evidence/audit-log.json` — In-memory audit event log snapshot.
- `evidence/books-after-tests.json` — Book records snapshot.
- `evidence/books-after-renewal.json` — Historical loan snapshot.
