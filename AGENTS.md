# AGENTS.md — LAF Agent

[CLAUDE.md](CLAUDE.md) is the project guide and the review rules. Read it
whole before reviewing or changing anything. The decision records it cites are
in `docs/laf/`.

None of it is repeated here, on purpose. A copy is a second place for every
rule to go stale, and a shorter copy reads as the whole contract while leaving
part of it out.

## Code Review Rules

- Hold the change to all of CLAUDE.md — every section, each rule together
  with its exceptions — and to every line of the checklist in
  `.github/pull_request_template.md`. Read both before the diff.
- CLAUDE.md records decisions that would be mistakes somewhere else; "The
  deployment decides the architecture" lists the ones a reviewer meets first.
  Do not flag a decision for being one. Flag a change that breaks it.
- Formatting, lint, types and test counts belong to the gate and CI, not to
  the review.
- A review reads a diff: it cannot see what was pressed or measured. Where the
  pull request's "Proof" does not say, say that it does not, rather than
  assume either way.
