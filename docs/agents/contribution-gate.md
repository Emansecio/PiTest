# Contribution gate

> Moved out of `AGENTS.md` to keep the model's per-turn project context lean.
> Loaded on demand only when you are triaging or labeling issues/PRs.

## Auto-gate behavior

- New issues from new contributors are auto-closed by
  `.github/workflows/issue-gate.yml`.
- New PRs from new contributors without PR rights are auto-closed by
  `.github/workflows/pr-gate.yml`.
- Maintainer approval comments are handled by
  `.github/workflows/approve-contributor.yml`.
- Maintainers review auto-closed issues daily.
- Issues that do not meet the quality bar in `CONTRIBUTING.md` are not
  reopened and do not receive a reply.
- `lgtmi` approves future issues.
- `lgtm` approves future issues and rights to submit PRs.

## Labels when creating issues

- Add `pkg:*` labels to indicate which package(s) the issue affects.
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`.
- If an issue spans multiple packages, add all relevant labels.
