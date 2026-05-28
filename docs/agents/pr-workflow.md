# PR workflow

> Moved out of `AGENTS.md` to keep the model's per-turn project context lean.
> Loaded on demand only when a PR task is in progress.

## Reviewing

- Analyze PRs without pulling locally first.
- If the user approves: create a feature branch, pull PR, rebase on main, apply
  adjustments, commit, merge into main, push, close PR, and leave a comment in
  the user's tone.
- The agent never opens PRs itself. Work happens in feature branches until
  everything matches the user's requirements; then merge into main and push.

## Posting issue/PR comments

- Write the full comment to a temp file and use `gh issue comment --body-file`
  or `gh pr comment --body-file`.
- Never pass multi-line markdown directly via `--body` in shell commands.
- Preview the exact comment text before posting.
- Post exactly one final comment unless the user explicitly asks for multiple.
- If a comment is malformed, delete it immediately, then post one corrected
  comment.
- Keep comments concise, technical, and in the user's tone.

## Closing issues via commit

- Include `fixes #<number>` or `closes #<number>` in the commit message.
- The issue auto-closes when the commit is merged.
