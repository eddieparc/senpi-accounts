# UBL-31 Fable quota-reset continuation

`UBL-31` explicitly requires three independent Fable audits through the
`second-opinion` flow. The live UBL-31 session completed the independent
code/schema/runtime evidence lanes and cross-check, but all three
`anthropic/claude-fable-5:xhigh` attempts were rejected by the unified
five-hour quota at utilization `1.0`. The documented
`anthropic/claude-opus-4-8:xhigh` fallback was also unavailable in the same
window.

Live Orca evidence:

- screenshot:
  `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/8b2777e6-2bf8-4158-a7d1-e91dd0690454-screenshot.png`
- SHA-256:
  `f488706f5f6418443cd9f3f688ddfc3d74681083d2c2b8a5af357e0b861013f0`
- visibly shows the Fable todo as the only audit blocker, the quota-rejection
  goal status, and the Orca reset counter at `1h 52m`.

An observable monitor was armed:

```text
monitor bash_649
targetUtc 2026-08-03T20:01:34Z
```

At the target it resolved the then-current UBL-31 terminal rather than using
a stale handle and sent the required continuation prompt:

```json
{
  "fableResume": "sent",
  "targetUtc": "2026-08-03T20:01:34Z",
  "handle": "term_ec6e53ca-62a4-4d5c-94f9-70fa5955723f",
  "accepted": true
}
```

The new terminal then reported active work. This satisfies the user's
requirement that an Opus/Fable-essential session automatically continue after
the five-hour window instead of remaining abandoned.
