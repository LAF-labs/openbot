# Review rules — LAF Agent

[CLAUDE.md](../CLAUDE.md) is the project guide and the review rules. Read it
whole before reading the diff, then `.github/pull_request_template.md`. The
decision records it cites are in `docs/laf/`.

None of it is repeated here, on purpose: a copy is a second place for every
rule to go stale. What follows is only how to review.

## What to hold the change to

- All of CLAUDE.md — every section, each rule together with its exceptions —
  and every line of the pull request template's checklist.
- CLAUDE.md records decisions that would be mistakes somewhere else; "The
  deployment decides the architecture" lists the ones a reviewer meets first
  (one VM, one server process, one person, one Bot; state held in the process).
  Do not flag a decision for being one. Flag a change that breaks it.
- Formatting, lint, types and test counts belong to the gate and CI, not to
  the review.
- A review reads a diff: it cannot see what was pressed or measured. Where the
  pull request's "Proof" does not say, say that it does not, rather than assume
  either way.

## What is a finding

- A defect traced to a call path that is reached. "What if this were null" is
  a finding once the path that makes it null is shown, not before.
- A test that cannot fail: one that would still pass with the line it guards
  reverted.
- A model instruction (a prompt, a tool description, a fixture) that holds an
  evaluation's own answers.
- Not a finding: "I would have written it differently", a rename, a refactor
  the change did not need, a restatement of what the pull request already says
  it left.

Read these every time, however many passes there have been: security, sign-in
and sessions, money, data loss and migrations, privacy.

From the third pass on one pull request, a finding that matches a pattern in
`docs/laf/review-triage.md` is not raised again.

## How to write one

- One finding, one defect: the file and line, the input or state that reaches
  it, what goes wrong, in that order. Say what you read and what you inferred.
- Fewer and certain beats many and possible. If nothing is wrong, say so.
- This repository is public. For a weakness somebody could use, name the place
  and the kind of fault and stop there: no working input, no steps.
