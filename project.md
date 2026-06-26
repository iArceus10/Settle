# Decentralized Splitwise — Project Spec

## Concept
An expense-splitting app (like Splitwise) built **offline-first**: users can add
expenses with no network connection, and when they reconnect, everything syncs
and merges automatically with zero conflicts. Balances are always derived from
a full event log, never stored as mutable numbers. Expenses require
confirmation from every involved member before they count toward balances,
preventing unilateral/fraudulent claims.

## Core architectural principles (do not deviate without discussion)
1. **Expenses are immutable, append-only events.** Never UPDATE an expense row.
   Only INSERT. This is what makes offline merge conflict-free by construction.
2. **Balances are always derived, never stored.** Recompute from the full set
   of *confirmed* expenses every time — don't cache/store a running balance.
3. **Confirmations are also append-only events**, synced the same way as
   expenses. No special-casing needed in the sync engine.
4. **Only unanimously-confirmed expenses count toward balances.** Pending or
   disputed expenses are visible but excluded from balance/settlement math.

## Data model

### Group
- id (UUID)
- name
- created_at

### Member
- id (UUID)
- group_id
- name

### Expense (immutable, append-only — INSERT only, never UPDATE)
- id (UUID, generated client-side so it's unique even when created offline)
- group_id
- paid_by (member_id)
- amount (decimal)
- description
- split_among: list of { member_id, share } — share can be equal or custom
- created_at
- origin_device (string/id — which client created this, useful for demo)
- synced (boolean, CLIENT-SIDE ONLY — not stored on server)

### ExpenseConfirmation (one row per involved member per expense)
- id (UUID)
- expense_id
- member_id
- status: "pending" | "confirmed" | "disputed"
- responded_at (nullable)

Behavior: when an Expense is created, auto-create a confirmation row for
every member in `split_among` EXCEPT the payer (who is auto-confirmed,
since they're asserting the claim). Each member can later confirm or
dispute their own row.

## Backend API

```
POST   /groups                         create group
POST   /groups/:id/members             add member to group

POST   /groups/:id/expenses            create expense
                                        -> auto-creates pending confirmations
                                           for all involved members except payer

POST   /expenses/:id/confirm           { member_id } -> mark confirmed
POST   /expenses/:id/dispute           { member_id } -> mark disputed

GET    /groups/:id/expenses            all expenses + their confirmation statuses

POST   /groups/:id/sync                body: { local_expenses: [...], local_confirmations: [...] }
                                        -> server merges by ID (union, dedupe)
                                        -> returns: { expenses: [...], confirmations: [...] }
                                           (everything the client doesn't have yet)

GET    /groups/:id/balances            net balance per member,
                                        computed ONLY from fully-confirmed expenses

GET    /groups/:id/settlements         minimal list of payments to settle up,
                                        via greedy algorithm on net balances
```

## Debt simplification algorithm
1. Compute net balance per member: sum(paid) - sum(owed), using only
   fully-confirmed expenses.
2. Greedy settlement: repeatedly take the member with the largest positive
   balance (owed the most) and the member with the largest negative balance
   (owes the most), settle the smaller of the two amounts between them,
   update balances, repeat until everyone is at ~0.
3. This minimizes total number of transactions needed (does not preserve
   who-originally-owed-whom — only net settlement). Be ready to explain why
   this greedy approach is optimal for minimizing transaction count.

## Offline-first sync (client architecture)

- **Local storage**: IndexedDB via Dexie.js. ALL writes (new expenses,
  confirmations) go to IndexedDB first, immediately, regardless of network
  status.
- **App shell offline support**: Service Worker (use `next-pwa` if using
  Next.js) caching static assets so the app loads with no network.
- **Sync trigger**: on `window` 'online' event, AND a manual "Sync Now"
  button. On trigger:
  1. Gather all local expenses/confirmations where `synced = false`
  2. POST to `/groups/:id/sync`
  3. Receive back anything the server has that the client doesn't
  4. Write received items into local IndexedDB
  5. Mark locally-created items as `synced = true`
  6. Recompute balances locally (or re-fetch from `/groups/:id/balances`)
- **UI must show sync state honestly**: an "Offline / Syncing / Synced"
  indicator. Don't fake real-time updates while offline.

## Demo script (for resume video / live interview demo)
1. Open app in two browser tabs, two different "members"/devices.
2. DevTools → Network → set one tab to Offline.
3. Add expenses in BOTH tabs while one is offline.
4. Confirm some expenses in both tabs.
5. Bring the offline tab back online (or click Sync Now).
6. Watch both tabs converge to identical, correct balances automatically.
7. Show that an unconfirmed/disputed expense does NOT affect the balance
   shown.

## Stack
- Frontend: Next.js + Tailwind CSS + Dexie.js (IndexedDB) + next-pwa
- Backend: FastAPI (Python) or Express (Node) — pick one, stay consistent
- Database: PostgreSQL — `expenses` and `expense_confirmations` tables are
  INSERT-only (no UPDATE statements against them, ever)
- Auth: simple JWT, OR skip per-user login entirely if members are just
  named participants within a group (lower priority than the core logic)
- Deploy: Vercel (frontend) + Railway or Render (backend + Postgres)

## Build order (recommended)
1. DB schema + migrations (Group, Member, Expense, ExpenseConfirmation)
2. Core backend logic: create expense + auto-confirmation creation
3. Confirm/dispute endpoints
4. Balance computation (derived, from confirmed expenses only)
5. Debt simplification / settlements endpoint
6. Sync endpoint (merge by ID, dedupe)
7. Frontend: basic UI for groups/members/expenses (online-only first)
8. Frontend: confirmation/dispute UI
9. Frontend: Dexie.js local storage layer
10. Frontend: Service Worker / PWA offline app-shell support
11. Frontend: sync trigger + online/offline indicator
12. Test the full demo script end-to-end, multiple tabs/devices

## Things to explicitly avoid
- Do NOT use a mutable `balance` column anywhere. Always derive from events.
- Do NOT UPDATE expense or confirmation rows. Only INSERT.
- Do NOT add blockchain/Web3 — the confirmation flow solves the trust
  problem directly; a smart contract would not solve "did this expense
  really happen," only "was the record tampered with after the fact,"
  which is a different problem we are not targeting here.