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
- `tests/integration/`, `tests/e2e/` — Node `--test` suites.

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

## Privacy

The public repository contains no real identities, health data, training
records, OpenIDs, or secrets — see `design/train-flow-solution-design.md` in the
workspace for the full privacy boundary.
