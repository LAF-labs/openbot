## What this changes

<!-- What it does, and why it is worth doing. -->

## Where it runs

LAF Agent runs **one VM per person**, with **one API server process on it**. Every Bot somebody
makes shares that VM and that process, and nobody else's Bots are on it. That is a decision, not a
stage we are passing through — [`docs/laf/deployment-model.md`](../docs/laf/deployment-model.md) is
the record.

So in-process state is a correct answer here. The approval registry, the repeat counter and the
gateway's snapshot cache live in memory on purpose, and a review saying "this breaks across
processes" is answered by that document. What is *not* an answer is state that outlives a restart
living only in memory: the VM reboots, the image is upgraded, the process is killed by hand.

- [ ] **New state that outlives a request?** Say where it lives, and whether it must survive a
      restart. If it must, it is in Postgres.
- [ ] **New listener, port, or schedule?** Say how it is reached through the same ingress as the
      API, and what it does to a 1 vCPU / 6 GB VM already running Chromium.
- [ ] **Anything the deployment cannot honour?** Do not draw the control. A setting that saves and
      reaches nothing is worse than no setting.

## Boundary and audit

- [ ] Every acting call still goes through the gateway: resolve, decide, audit, then act.
- [ ] New refusals and new failures each write a row.
- [ ] Nothing new is trusted from the client that the server can resolve itself.
- [ ] Nothing new lets an action past a person without one switch governing it, a record of who
      decided and why, and a `deny` that still means deny.
- [ ] A Bot cannot write the rule that decides whether it gets asked about.
- [ ] Nothing new records a value somebody typed — that it was typed, and where, is the whole of it.

## Korean

- [ ] Every new user-facing string goes through `t()` with English as the key, and its Korean entry
      is in `app/src/lib/i18n-ko.ts` in this same change.
- [ ] Strings read through a variable (`t(someVariable)`) are invisible to the coverage test and
      carry their own test walking the table.
- [ ] The server sends facts; the surface owns the words. No server prose reaches the screen.

## The gate

```sh
bun run typecheck
bunx biome lint .
bun run format:check
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot bun run test:ci
```

- [ ] All four pass. If a test floor moved, say why.

## Proof

<!--
Say what you MEASURED, not that it typechecked. Everything that has ever shipped broken here
typechecked and passed tests. Open the page, press the button, read what the other service actually
received. "It answered normally" is what happens when a setting reaches nothing.
Screenshots or a recording for anything with a surface.
-->
