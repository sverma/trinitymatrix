# Changelog

## 0.2.0 Activity Insights — 2026-11-27

- Added a passkey-protected administrator Activity panel with sign-ins, observed
  sessions, estimated active time, human/AI outcomes and a filterable timeline.
- Added date/search/actor filters, daily UTC charts, page/action breakdowns,
  player inspection and stable cursor pagination.
- Added bounded first-party interaction tracking, multi-tab time protection,
  fresh focus baselines, hashed session keys and periodic retention cleanup.
- Reused authoritative match history for historical wins, losses, drops and game
  actions. Past sign-in or active-time data is not fabricated.
- Added privacy information, real PostgreSQL tests and desktop/mobile browser
  verification. Fixed mobile administrator navigation to accommodate Activity.

See [Activity operations and metric definitions](docs/ACTIVITY.md).
