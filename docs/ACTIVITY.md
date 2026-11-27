# Administrator Activity panel

The **Activity** section at `/admin` shows successful sign-ins, recent presence,
estimated active time, completed match outcomes and selected interactions. It
requires the administrator email allowlist and an unlocked passkey, like the rest
of the admin workspace.

## Views and filters

- Select the last 24 hours, 7 days, 30 days, or a custom window of at most 90 days.
- Filter humans, AI players or both, and search by display name or email.
- Summary cards show sign-ins, unique observed users, recently active humans,
  estimated active time, completed matches and interactions. Participant wins,
  losses and dropped results are shown separately.
- Daily charts use UTC calendar days. Individual timestamps and custom-date
  inputs use the administrator browser's local timezone.
- Page and interaction breakdowns explain how people use the platform.
- The people table shows per-player outcomes, sign-ins, last seen and active time.
  Inspect a person to scope the dashboard and view their recorded browser sessions.
- The timeline can show all events, authentication, match activity or interactions.
  People, sessions and events have bounded cursor pagination.

The default window refreshes every 15 seconds while visible and online. Loading
older pages pauses automatic refresh to preserve the pagination snapshot. Custom
date windows stay fixed; **Refresh activity** explicitly reloads a window. Filters
and authorization failures clear unrelated or expired results.

## What the numbers mean

| Signal | Source | Meaning |
| --- | --- | --- |
| Successful sign-in and sign-out | Server authentication flow | Verified authentication events; OTP requests and failed attempts are not counted as successful sign-ins. |
| Session first observed | Authenticated browser activity | A pre-release session can first appear without a sign-in event. It is labelled first observed, not assigned an invented login. |
| Recently active / seen | Browser samples received by the server | Recent signals rather than a guarantee that a person is currently online. |
| Estimated active time | Visible, focused browser with input in the last 60 seconds | Server-bounded elapsed time between continuous samples; not a client-submitted duration or exact attendance record. |
| Match wins, losses and drops | Completed `ranking_matches` and `match_participants` | Existing authoritative outcomes, including historical matches. A drop is not silently combined with a loss. |
| Draw, discard, declaration and final-hand actions | Authoritative `game_events` metadata | Server-recorded gameplay interactions; analytics never reads card/event payloads for these counts. |
| Page views and selected UI actions | Browser reports | Fixed categories, not independently verified outcomes. Queue events represent sent join/leave requests; private-room events follow successful UI requests. |
| Profile saved | Server profile update | A successful profile update, with none of the submitted profile contents copied into activity records. |

The same match can produce one win and several participant losses/drops. The
completed-match card counts distinct matches represented by the current filters;
outcome totals count participants. AI players have game outcomes and actions but
no human sign-ins or browser active-time estimate.

New sign-in and browsing records start at the collection timestamp displayed in
the panel. Old login times or time spent cannot be reconstructed from past games.
Existing game outcomes remain available within the selected window. Empty values
are not evidence that a user never visited before collection started.

### Estimated time

The browser samples every 15 seconds. Hidden, unfocused and offline tabs stop
sending periodic samples. A fresh baseline after focus, visibility, page or idle
transitions prevents the intervening gap from becoming active time. Input is used
only as a timestamp: its content is not read or transmitted.

The server credits bounded elapsed server time, serializes samples per account
and does not add simultaneous tabs/devices together. Samples more than 45 seconds
apart do not accrue time. Minute buckets provide page/session breakdowns; a custom
window cutting through a minute uses an estimated proportional boundary. Short
visits, passive reading or video viewing without recent input, disconnections and
delivery failures can be undercounted. These figures are operational estimates.

## Privacy and storage

Collection is first-party and scoped to authenticated human sessions. Browser
payloads contain an event UUID, a fixed page/action category, and heartbeat flags.
They cannot supply user IDs, outcomes, durations, arbitrary URLs or free text.
The server derives the account and hashes the bearer session value before using
it as an analytics key. APIs return a separate analytics session ID, never the
hash, login cookie or authentication credentials.

Activity does not collect input contents, keystrokes, chat text, card identifiers,
private room codes, raw URLs, IP addresses or user-agent strings. Existing account,
gameplay and security records have their own purposes and access rules. Browser
reports are labelled separately from server-verified records. The privacy page
describes the new service-activity collection.

Migration `0014_user_activity.sql` adds:

- `activity_settings`: collection start and the 90-day retention setting.
- `activity_sessions` and `activity_presence`: observed human sessions and recent signals.
- `activity_events`: bounded authentication/interaction metadata.
- `activity_ingest_receipts`: short-lived retry deduplication.
- `activity_time_buckets`: estimated time grouped by account, session, page and minute.

Detailed analytics use a 90-day retention window with bounded cleanup at startup
and every five minutes. Retry receipts expire after an hour. Cleanup is periodic
and may lag under sustained load. It does not delete the separate game history,
ratings, accounts, AI identities, model notes or practice records.

## Failure and access behavior

Ingestion is authenticated, same-origin, rate-limited and strictly validated.
Admin queries require both the allowlist and passkey access, use `no-store`, and
validate date windows, pagination and filter binding. Raw analytics errors and
sensitive database details are not returned to a browser.

The browser collector has a 20-event memory-only queue, a 60-second expiry, a
five-second request timeout and at most three retries with the same UUID.
Server authentication/profile events use a bounded background writer. Analytics is
best effort: queue pressure, shutdown or unavailable storage can lose a sample or
event. Tracking does not block gameplay or authentication. Redis-only development
can continue playing without collecting analytics; the Activity panel requires
PostgreSQL.

## Implementation and verification

The schema and DTO contract live in
[`packages/protocol/src/activity.ts`](../packages/protocol/src/activity.ts).
[`activity-repository.ts`](../apps/server/src/activity-repository.ts) computes
server-bounded time and combines telemetry with authoritative game metadata.
[`activity-routes.ts`](../apps/server/src/activity-routes.ts) provides the guarded
API; [`activity-tracker.ts`](../apps/web/src/activity-tracker.ts) is the browser
collector; [`AdminActivity.tsx`](../apps/web/src/components/AdminActivity.tsx) is the
panel.

Focused tests cover authorization, privacy, deduplication, session ownership,
multi-tab/focus boundaries, cursor stability, outcomes and retention. Real
PostgreSQL integration and the OTP/WebAuthn browser journey are included in CI,
with desktop/mobile layout and accessibility checks. The initial design sketch
is in [`diagrams/activity-panel-sketch.svg`](diagrams/activity-panel-sketch.svg);
its numbers are illustrative, not production measurements.
