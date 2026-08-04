# GoToLearn session restart wave

Source: `orca worktree list --repo name:GoToLearn --limit 100 --json` plus
per-worktree `orca terminal list/read`.

Explicit exclusions:

- `ubl-19`
- `ubl-20`
- non-UBL temporary verification worktrees

Classification:

- 22 active `ubl-*` worktrees were still `in-progress` and had either no
  terminal or terminal output idle for about 90 minutes or more.
- Existing terminals were stopped (19 had one terminal; 3 had none).
- A fresh visible terminal was created for every target.

Restart command template:

```bash
ALIBABA_MODEL_STUDIO_BASE_URL=https://ws-tzcu53xu4sxxeqq4.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 \
senpi -e /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts/dist/index.js \
  --model alibaba-model-studio/glm-5.2 \
  --thinking high \
  --continue \
  "Continue the current work end-to-end. Re-read the active goal, todo, and prior session context. Finish all remaining implementation, tests, real QA, and the worktree-required delivery updates. Do not stop at a status report."
```

Targets:

- `ubl-39-spaces-redesign`
- `ubl-38-ended-courses`
- `ubl-37-portfolio`
- `ubl-36-space-capacity`
- `ubl-35-course-delete`
- `ubl-34-mobile-order-bug`
- `ubl-33-mobile-partner-info`
- `ubl-32-sandbox-qa`
- `ubl-31-fable-audit`
- `ubl-30-admin-edublock-deep`
- `ubl-29-multi-booking`
- `ubl-28-realtime-seating`
- `ubl-27-refund-state`
- `ubl-26-admin-redesign`
- `ubl-25-consent-ui`
- `ubl-24-deeplink-return`
- `ubl-23-course-alerts`
- `ubl-22-course-order-policy`
- `ubl-21-mobile-course-pages`
- `ubl-18-mobile-course-spacing`
- `ubl-17-orca-local-origin`
- `ubl-13-cancel-request-status`

Creation result: 22/22 worktrees have one new connected terminal. A single
multi-terminal readiness watcher waits for all 22 to reach TUI idle before
model/progress evidence is collected.
