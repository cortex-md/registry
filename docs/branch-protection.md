# Branch Protection

Configure the `main` branch in GitHub repository settings with these rules.

## Required Checks

- Require status checks before merging.
- Require the `Registry Review / Validate registry` check.
- Require branches to be up to date before merging.

## Review Rules

- Require at least one approving review.
- Require review from Code Owners.
- Dismiss stale approvals when new commits are pushed.
- Require conversation resolution before merge.

## Automation

- Keep the `data` branch unprotected (or add GitHub Actions as a bypass actor). Every stats workflow
  pushes `stats.json` there with `GITHUB_TOKEN`.
- Block pull requests opened by the audit use `GITHUB_TOKEN`, so they do not trigger
  `Registry Review` and never get the required check. A repository admin merges them with the
  bypass ("Merge without waiting for requirements"), or closes them as false positives.
- Fork pull requests from `cortex submit` get their `review/ci-*` label from `CI Result Labels`,
  which finds the pull request by the head commit.

## Merge Rules

- Block force pushes.
- Block branch deletion.
- Allow squash merge as the default merge strategy.

## Labels

The workflows maintain review labels automatically:

- `kind/plugin`
- `kind/theme`
- `kind/mixed`
- `kind/infra`
- `review/needs-ci`
- `review/ci-passed`
- `review/ci-failed`
