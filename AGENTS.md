# AGENTS.md — LAF Agent

The project guide is [CLAUDE.md](CLAUDE.md): what this product is, how it is
deployed, the gate, and each rule with the thing that went wrong behind it. Read
it before changing anything. The decision records are in `docs/laf/`.

This file holds only what a reviewer must hold a change to. It says nothing
about formatting, lint, types or test counts: the gate and CI check those.

## Code Review Rules

### Correct here, though it would be wrong elsewhere

- Do not flag in-process state as unsafe across processes or replicas. A
  deployment is one person on one VM with one API server process
  (`docs/laf/deployment-model.md`): the approval registry, the repeat counter
  and the gateway's snapshot cache are in memory on purpose.
  Flag instead: state that must survive a restart and lives only in memory.
- Do not ask for multi-account or multi-Bot handling. One account per
  deployment and one Bot per person are enforced in code.
  Flag instead: a path that lets a second account or a second Bot in.

### Boundaries

- Flag anything that lets a Bot's action past without a person seeing it —
  a standing allowance, an auto-review instruction — unless one switch governs
  it, it records who decided and why, and a `deny` still means deny.
- Flag any path by which a Bot can write the rule that decides whether it gets
  asked. The Bot's own tools reach its profile and its routines, never the
  auto-review instruction.
- Flag a control that saves and reaches nothing. Safe path: when the
  deployment's model cannot do the thing, the control is not drawn.
- Flag code that stores, logs or sends a value somebody typed into the Bot's
  browser, passwords included. Safe path: record that typing happened and
  where, never what was typed.

### Reaching the Bot people actually use

- Every Bot a person makes is remote (`remote_ag_ui`) and answered by
  `agent-bot`; only Bots a package shipped are built in. Flag per-Bot behaviour
  wired only into the built-in configuration: it reaches nobody. Safe path:
  per-run settings travel as AG-UI `forwardedProps` through the one middleware
  every run passes, chat and routines alike.
- The Bot's computer takes the Bot from a request header and refuses without
  it. Flag a fallback Bot id anywhere on that path: a default answers as the
  blank page that belongs to nobody.
- Tools ride in front of every message a Bot answers. Flag a new core tool
  where a lower rung of CLAUDE.md's footprint ladder would do, and a tool that
  appears or disappears in the middle of a conversation.

### Words on the screen

- Flag a user-facing string that does not go through `t()` with its Korean
  entry added in the same change. The coverage test sees only literal
  `t("…")`: a table of strings read through a variable needs its own test
  walking the table.
- Flag prose written by the server reaching the screen. The server sends facts
  and codes; the surface owns the words.
- The first-run answer (학생 / 직장인 / 사장님 / 기타) is a hint that orders and
  words things. Flag code where it hides or shows a tab, screen, setting or
  feature, and copy that assumes everyone runs a shop (가게).

### Tests

- The tests share one database with each other. Flag a cleanup that is not
  scoped to the rows the test created, and a test that assumes a row exists
  because the app put it there.
- Flag a test weakened to make a change pass: a narrowed typecheck `include`,
  a lowered test floor with no reason given, an assertion on a field that no
  longer exists.
