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

## Privacy

The public repository contains no real identities, health data, training
records, OpenIDs, or secrets — see `design/train-flow-solution-design.md` in the
workspace for the full privacy boundary.
