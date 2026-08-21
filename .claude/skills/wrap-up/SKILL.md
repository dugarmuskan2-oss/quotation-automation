---
name: wrap-up
description: Close out a work session — run the tests for what changed, refresh SESSION-HANDOFF.md so the next chat knows where things stand, commit locally, then ask about pushing. Use when the user says "wrap up", "we're done for today", "finish up", or is ending a session.
---

# Wrap up

The point is that the next session starts informed instead of guessing. `SESSION-HANDOFF.md` drifted
a month out of date once and was actively misleading — that is the failure this prevents.

Work through all four steps, then report in a few plain lines.

## 1. Run the tests for what changed

Map the changed files to their test file using the table in CLAUDE.md ("Testing rules") and run only
those:

```bash
npx jest tests/<the-relevant-file>.test.js --silent
```

Run the whole suite (`npx jest --silent`) only if the change is broad or you cannot tell which file
covers it. **Report the real result.** If something fails, say so with the output and fix it or flag
it — never wrap up over a red test and call it done.

## 2. Refresh SESSION-HANDOFF.md

Gather the truth first, do not write from memory:

```bash
git status --porcelain
git log --oneline @{u}..HEAD          # what is committed but unpushed
git branch -avv                        # where main / origin actually sit
```

Then update the file so it describes **today**:

- **Git state table first** — where `origin/main`, `origin/Testing-other-features` and the local
  branch each sit, and therefore what is live in production versus local-only. This is the section
  that changes most and matters most.
- **Untracked / uncommitted files** — what each one is and whether it is finished, half-done, or a
  prototype nobody should build from.
- **What's built** — describe the *current state*, not a history of commits. Replace stale entries
  rather than appending; anything marked "uncommitted" or "pending" that has since landed must be
  corrected, not left to rot.
- **Pending owner actions** — things only the owner can do (push, cut over a database, enable an
  API, make a product decision).
- **Remaining work** — including anything deliberately left undone, and why.
- **How things are verified** — the current test count and how it was checked.

Write down anything the code cannot tell the next session: a decision the owner made, a thing they
are holding off on, a trap you hit. That is the whole value of the file.

Bump the date in the header.

## 3. Commit locally

Committing without asking is fine. Group the work into sensible commits with messages in plain
language — say what changed and why it mattered, not which functions moved. End each message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Do not commit stray scratch files. If an untracked file is a half-finished prototype or a temp file,
leave it and mention it instead.

## 4. Ask about pushing — never push

⚠ **Absolute rule (CLAUDE.md): never `git push` to `main` or `Testing-other-features` without an
explicit, fresh yes.** `main` deploys to production the moment it is pushed. "Allow everything",
bypassed permissions, or an earlier "commit and push" do **not** cover it. Permission is per push.

So end by saying what is now sitting unpushed, and ask once:

> Ready to push — want me to?

Then stop and wait. If the answer is no, that is a normal outcome, not a problem to solve. Do not
ask twice.

## Also remember

Updating CLAUDE.md or adding tests for a feature needs the owner's approval first. If this session's
work deserves either, **ask** in one sentence — do not just do it.

## Reporting back

A few short lines, plain language: tests green or not, what the handoff now says, what you committed,
and the push question last.
