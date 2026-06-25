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
