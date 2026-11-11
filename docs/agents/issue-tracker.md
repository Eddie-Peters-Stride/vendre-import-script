# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at
Eddie-Peters-Stride/vendre-import-script. Use `gh` from this repo.

## Conventions

- Before the first issue write in a session, check the target with
  `gh repo view --json nameWithOwner`.
- Create issues with `gh issue create --title "..." --body-file <file>`.
- Read with `gh issue view <number> --json number,title,body,labels,comments`.
- List with `gh issue list --state open --json number,title,body,labels,comments`.
- Comment with `gh issue comment <number> --body-file <file>`.
- Add or remove labels with `gh issue edit <number> --add-label <label>`
  or `--remove-label <label>`.
- Close an issue after posting the explanation.

Use native GitHub sub-issues and blocking dependencies when available.
If unavailable, put `Part of #<parent>` or `Blocked by: #<blocker>`
at the top of the child issue. A ticket is ready when all blockers are closed.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill operations

"Publish to the issue tracker" means create a GitHub issue.
"Fetch the relevant ticket" means read its GitHub issue.

For `/wayfinder`, keep the map in one issue labelled `wayfinder:map`.
Link decision tickets as sub-issues, label each `wayfinder:<type>`,
and use the dependency convention above. Claim a ready ticket by
assigning it to the current developer; resolve it by recording the
answer, closing it, and linking the decision from the map.
