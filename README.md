# TrainFlow (练程)

Offline-first, single-user native WeChat Mini Program for morning workout planning,
reliable timing, training records and basic stats. No TypeScript, no cross-platform
framework, no npm runtime dependencies.

## Getting started

1. Open this directory in WeChat DevTools; `project.config.json` ships with the
   placeholder `touristappid` so the project imports without a real AppID.
2. `npm test` runs the Node-native test suite (unit + structural E2E) — no
   third-party test runner required.

## Structure

- `miniprogram/pages/` — page routes registered in `miniprogram/app.json`.
- `miniprogram/application/` — application services pages call into; pages never
  touch `wx.setStorageSync` or the cloud database directly.
- `miniprogram/domain/` — domain models and repository contracts, framework-free.
- `miniprogram/assets/` — packaged local media used by device adapters.
- `tests/integration/`, `tests/e2e/` — Node `--test` suites.

## Notification audio asset

`miniprogram/assets/workout-notification.m4a` is a short project-generated alert
tone used by the default WeChat `InnerAudioContext` when sound reminders are
enabled. It contains no downloaded or third-party recording: the source was a
deterministic 22.05 kHz mono PCM sine-wave tone generated locally, then encoded
with the macOS system converter:

```sh
/usr/bin/afconvert notification-tone.wav \
  -o miniprogram/assets/workout-notification.m4a \
  -f m4af -d aac -b 32000 -c 1
```

The source WAV was temporary; the packaged M4A is the auditable delivery asset.

## Today page development fixtures

The Today page accepts an anonymous date/fixture query in WeChat DevTools so the
built-in 2026 plan remains reproducible after those calendar dates have passed:

- `pages/today/index?date=2026-08-03` — scheduled workout.
- `pages/today/index?date=2026-08-03&fixture=active` — active session / continue.
- `pages/today/index?date=2026-08-03&fixture=completed` — completed session summary.
- `pages/today/index?date=2026-08-09` — rest day with no start action.
- `pages/today/index?date=2026-08-10` — honest no-plan state.

These query parameters are enabled only when the Mini Program environment is
`develop`. `trial` and `release` ignore both `date` and `fixture` and render the
real `currentTrainingDate`. Fixtures are read-only view inputs; they do not
commit records or sessions to the local database.

## Plan editor verification

Open `pages/plan/edit/index?planId=plan_20260803_builtin` in WeChat DevTools to
exercise the plan editor. It supports kind-specific duration/set/rep/rest and
equipment-target fields, step add/delete/reorder, field-level validation, and a
copy-to-date flow. Copying over an existing date always shows a confirmation
bound to the target plan ID and exact revision. Replayed taps reuse one copy
intent; completing or cancelling the flow rotates it, so a later user-initiated
copy receives a fresh identity. The copied source is the current detached editor
draft, including unsaved nested edits. Saving or copying recalculates duration as
follows: timed steps use duration; interval steps use sets × duration plus rests
between sets; strength steps use 5 seconds per rep plus rests between sets; manual
steps use 5 seconds per rep; rest days use zero. Existing plans preserve their
non-modeled baseline by applying only the modeled-step delta, while new plans use
the modeled total directly. Saving an edited plan only affects future workout
starts because an active Session keeps its own deep `PlanSnapshot`.

## Local backup and restore

Open `pages/settings/index?section=data` to generate a canonical JSON backup,
preview a restore, or clear this device. The backup contains only portable
profile/settings/plans/records data; it excludes device identity, OpenID,
authentication material, synchronization cursors/outbox/conflicts and runtime
projections. Imports are limited to 5 MiB, validated before any write, and bound
to the previewed package plus the exact local database revision. Confirmed
restores and clears use one strict A/B commit. Local clear always says what it
does: it removes this device's data and never claims that cloud data was deleted.

## Privacy

The public repository contains no real identities, health data, training
records, OpenIDs, or secrets — see `design/train-flow-solution-design.md` in the
workspace for the full privacy boundary.
