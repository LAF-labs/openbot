/**
 * The test run: in a database of its own, with a floor under each part of it.
 *
 * Two separate guarantees live here.
 *
 * **The run never touches the database the application is using.** The suite writes to a real
 * Postgres, and some of it deletes a row by identity rather than by what it created — the boundary
 * policy row (`policy-durability.integration.test.ts`). Pointed at a developer's own database that
 * deletion lands on their work, and nothing says so. So `DATABASE_URL` as given is read for its
 * server and its credentials and then never handed to a test: the tests run in `<name>_test` on the
 * same server, created here if it is absent and migrated exactly the way CI migrates.
 * `LAF_TEST_DB_SUFFIX` names a second one, so two worktrees can run the gate at the same time
 * without sharing a database.
 *
 * **A group of tests cannot go missing quietly.** A test file that throws while it is being
 * imported never runs its tests and never reports them as failures; the file is simply absent from
 * the totals. One floor over the whole monorepo could not see that at any useful resolution: at
 * ~1,330 tests, a floor with enough slack to survive a legitimate consolidation also had enough
 * slack to hide a whole mid-size server file. A floor per workspace is the same check at the size
 * of the thing being lost.
 *
 * The floors are floors and not exact numbers. Tests are added constantly, and a check that has to
 * be edited for every new test is a check people learn to edit without thinking.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob, SQL } from "bun";
import { fileVerdict } from "./test-ci-report";

const projectRoot = resolve(import.meta.dir, "..");

/**
 * THE FILES ARE COUNTED, NOT ONLY THE TESTS.
 *
 * MEASURED 2026-09-10 (audit A6, finding 4): `standing-approvals.integration.test.ts` — forty-one
 * tests, the largest integration file — was moved out of the tree and the gate passed, `server
 * 1770 / floor 1725`. The floors are 3% under what the tree measures, and 3% of the server suite is
 * more than any one of 141 of its 142 files. A floor catches a suite shrinking; it cannot see one
 * file going.
 *
 * So the files are listed. `scripts/test-manifest.json` is the committed list of every test file
 * the gate runs, and the two directions of disagreement are treated as the different things they are:
 *
 *  - A file in the list and not in the tree REFUSES THE RUN, before a database is touched. It was
 *    deleted or moved without anybody saying so — a rebase dropping it, most likely, since this
 *    repository stacks branches. Removing its line from the manifest, in the commit that removes the
 *    file, is how somebody says so; that line in the diff is the whole point.
 *  - A file in the tree and not in the list is a new test, and is ADDED to the manifest by the run,
 *    with a line saying to commit it. Adding a test is the common case, and a check that fails on the
 *    common case teaches everybody the command that makes it pass — which would be the same command
 *    that forgets a vanished file. Under CI the addition cannot be committed, so there it refuses.
 *
 * `bun scripts/test-ci.ts --update-manifest` rewrites the list from the tree in both directions, for
 * a deliberate rename of many files at once; it is the one command that forgets files, and it says so.
 *
 * And each file is checked to have run at least one test, off bun's own JUnit report: a file whose
 * tests were all removed, or that threw before registering any, is gone in every way that matters
 * and still present in every way the list can see. (A skipped test still counts as run: whether a
 * machine has Docker is not whether the file exists.) The report is read in `test-ci-report.ts`,
 * where `tests/test-ci-report.test.ts` holds that reading to a report bun writes.
 */
const MANIFEST = resolve(projectRoot, "scripts/test-manifest.json");

/**
 * One floor per workspace, each about 3% under what that workspace measures today.
 *
 * RE-RAISED 2026-09-03, on the run that typechecked the test directories. The four had been left
 * at what they measured on 2026-09-02 while five waves landed on top of them — settle, the Korean
 * question, the browser, the surface, the data lifecycle — and by this run the smallest gap was
 * agent-computer's 88 against 132, a floor that would have let a third of that workspace vanish
 * without the run going red. A floor whose margin has grown to 50% is not a floor, it is a number
 * in a comment.
 *
 * RE-RAISED AGAIN 2026-09-04, with the two partner connectors. 알림톡 and 세금계산서 brought
 * thirty-nine tests to `server` and eleven to `app` — three new files against fake vendors on
 * ephemeral ports, plus the partner half of `config` — and the two floors they landed on had drifted
 * to 14% under. `agent-computer` and `root` are untouched: neither grew.
 *
 * RE-RAISED AGAIN 2026-09-05, with the connection layer. Whether a connection still works, the
 * shell's own return page and the reason a connect failed brought thirty-four tests to `server`
 * (two new files and four on the callback), nine to `app` and three to `root`. `agent-computer` is
 * untouched: it did not grow.
 *
 * Measured on this tree, consecutive green runs of the whole gate agreeing exactly:
 *
 *     server           1,407 tests across 98 files   → 1,364
 *     app                289 tests across 39 files   →   280
 *     agent-computer     132 tests across  8 files   →   128
 *     root                78 tests across 12 files   →    75
 *                      ─────                            ─────
 *                      1,906                            1,847
 *
 * Each floor is 3% under, rounded down, which is the same margin they were introduced with: enough
 * that consolidating a handful of cases does not fail the run, small enough that a file which threw
 * on import and took its tests with it does. `root` counts its seven skipped tests and
 * `agent-computer` its two todos, because bun counts them and a floor that disagreed with the
 * number on the screen would be argued with rather than read.
 *
 * RAISED AGAIN 2026-09-05, with the 연결 screen. The rewrite brought twenty-eight tests: eighteen
 * to `app` (the overview query, what each kind of switch starts, and the source-walking guards that
 * keep a scope string and the word 관리자 off an owner's screen) and twelve to `server` (the
 * overview composition and turning a site off). Only `app` moved far enough to matter — its floor
 * had drifted to 9% under — so only `app` is re-raised:
 *
 *     app                298 tests across 42 files   →   289
 *
 * MEASURED TOGETHER 2026-09-05, once the 연결 screen and the connection-health work were on the
 * same branch: server 1419 → 1376, app 308 → 298 (3% under, rounded down); agent-computer and
 * root unchanged.
 *
 * LOWERED 2026-09-05, by the twenty-six tests 세금계산서(팝빌) took with it when the connector was
 * deleted (`partner-tax` 23, one listing case, two config cases): server 1376 → 1350, which is the
 * old floor minus exactly what was removed rather than a fresh 3% — a floor lowered further than
 * the deletion would forgive a file that threw on import in the same change.
 *
 * RAISED AGAIN 2026-09-05, with the Settings polish. Forty-four tests to `app`: the frame Settings
 * and Admin share (which link is lit, the width, and what the rail becomes below `lg`), the rows
 * that could not be acted on (a Notifications heading with no control, a Delete button live on one
 * character, a download that gave no sign of the press), and `PersonAvatar` — the first three
 * suites in this workspace that render React rather than walking source, because a picture URL
 * that 404s and a permission the browser will not re-prompt for are events, not markup:
 *
 *     app                352 tests across 44 files   →   341
 *
 * RAISED AGAIN 2026-09-05, with the generated Bot avatars. The thirty-five drawn mascots became a
 * seed grammar and a component, and twenty-four tests came with them: the round trip through the
 * grammar, four pinned hashes that say every existing Bot keeps its face, the markup the component
 * emits at every state and size, and the geometry that lets a `rounded-full` wrapper clip a face
 * without taking a bite out of it. `app` had drifted to 10% under; the other three did not grow.
 *
 *     app                332 tests across 43 files   →   322
 *
 * RAISED AGAIN 2026-09-06, with the first-task chips on a new Bot's empty conversation. Thirty-six
 * tests to `app`: which four sentences are offered for which connection state and which role, when
 * they are withheld, what a press reports, and a rendered press of each chip inside a memory-history
 * router — the first suite here that mounts a TanStack `Link`. `app` had drifted to 12% under; the
 * other three did not grow.
 *
 *     app                637 tests across 76 files   →   617
 *
 * MEASURED TOGETHER 2026-09-05, once 세금계산서 was gone and the Settings, avatar and Bot-creation
 * branches were on one branch: server 1395 → 1353, app 402 → 389 (3% under, rounded down);
 * agent-computer and root unchanged.
 *
 * MEASURED 2026-09-06, with the two i18n walks grown three tests: the tables `/admin` and the
 * audit trail read through `t(variable)`, and the gallery's card names, which no walk could see
 * before because `GALLERY_COMPONENTS` is built by `import.meta.glob` and is empty under bun.
 *
 *     app                403 tests across 49 files   →   390
 *
 * MEASURED 2026-09-06, after the Bots pane, Routines and Skills production pass: a josa helper with
 * its own walk of 받침/vowel/Latin/digit endings, the confirm dialog's contract, the routine form's
 * field order and day chips, the Skills failed-read state, and the page header the three sibling
 * pages now share.
 *
 *     app                459 tests across 55 files   →   445
 *
 * MEASURED 2026-09-06, with the production pass on the admin and 연결 screens. Forty-two tests to
 * `app`: how the audit trail collapses nine identical boot rows into one without ever folding a
 * refusal into the allows around it, the two label tables walked against the server's own event
 * list and the tool catalogue, the marks on 연결 walked against both catalogues in both directions,
 * the admin toggle groups' accessible state, the data functions' words, and the walk over the JSX
 * itself for English nobody ever asked the dictionary about. The
 * other three did not grow — the server work here was one prose string becoming a fact code, in a
 * test that already existed.
 *
 * Every wave lands on the same branch, so the floor is 3% under what all of them measure together
 * rather than under any one of them: the number in `GROUPS` is that combined measurement.
 *
 * MEASURED 2026-09-06, after the chat, rooms, roster and screen-pane pass: the group avatar's
 * geometry, the codes a failed turn is said in and their Korean, the room's empty state, the one
 * recipient picker, the roster's rail and row layout, the channel-events socket, the screen pane's
 * alignment and its frame decoding, and the approval and Home centring.
 *
 *     app                539 tests across 65 files   →   522
 *
 * MEASURED 2026-09-06, with all of the above on one branch and the admin/연결 pass rebased on top
 * of the chat one:
 *
 *     app                575 tests across 68 files   →   557
 *
 * MEASURED 2026-09-06, after the tool bridge (`shared/tools/bridge.ts`): what is never deferred
 * walked against every catalogue by name, `tool_search` over the adapters' own Korean, the
 * agent-bot loop's rounds and rewrites, and the eval harness reading a call the Bot service
 * answered itself. Thirty-five tests, all under root — the bridge is shared code and agent-bot.
 *
 *     root               113 tests across 14 files   →   109
 *
 * MEASURED 2026-09-06, with the log discipline (3-D) on top of the 1-B merge. The four had drifted
 * to between 6% and 26% under what the tree measures — `root` most, because the tool bridge and
 * the logger both landed there — so all four are re-raised to 3% under this run:
 *
 *     server           1,687 tests across 100 files  → 1,636
 *     app                601 tests across 70 files   →   582
 *     agent-computer     136 tests across  8 files   →   131
 *     root               147 tests across 18 files   →   142
 *
 * REBASED 2026-09-06 onto the first-task chips and 3-B: each floor is the higher of what the two
 * branches had measured, so `app` keeps the chips' 617 above rather than this run's 582.
 *
 * RAISED AGAIN 2026-09-06, with the help page and the 문의·의견 box, rebased onto 3-D and 2-B.
 * Twenty-eight tests to `server` (what the route keeps and refuses, the alert-webhook door and its
 * body, the feedback row's cascade, and the outbox's two rules about support rows) and thirty-seven
 * to `app` (the guide's five sections and every bold name against the dictionary, the body that
 * leaves the browser, the last failure a tab remembers). Measured on the rebased tree; `server` and
 * `app` are re-raised to 3% under, and the other two keep 3-D's floors, which are within 3% still:
 *
 *     server           1,775 tests across 139 files  → 1,721
 *     app                674 tests across 77 files   →   653
 *
 * The rule, unchanged: re-raise when the suite outgrows this one by the same margin.
 *
 * RE-RAISED 2026-09-06 after the 2-B follow-up (a hung site, partner grants for later Bots,
 * arguments checked before the approval, the screen pane's codes, the composer's caret) — measured
 * server 1,779 / app 661 / agent-computer 147 / root 156, each floor 3% under.
 *
 * RE-RAISED 2026-09-10, with the build and dependency audit (A7): the version route and its walk
 * of the footer, the Dockerfile digest pins, the server image's shape, what Dependabot watches,
 * the two overrides and the shell's version files. Measured server 1,808 / app 694 /
 * agent-computer 147 / root 176; `root` had drifted to 14% under and `server` and `app` past 3%,
 * so those three are re-raised to 3% under, and `agent-computer`, which did not grow, keeps its floor.
 *
 * RE-RAISED 2026-09-13, with the browser's sandbox, the navigation guard and the label hold (W1-d):
 * the sandbox's static half (launch args, `chromiumSandbox`, the image user, the compose profile and
 * volume hand-over), the per-hop floor and the name rules without a browser, and a real Chromium
 * refusing hops before they are sent, holding hops at a new host, holding a click to its label and
 * resetting a profile for good. Measured agent-computer 176, re-raised to 3% under; the other three
 * carry more than this wave's tests and are left to the measurement that has all of them.
 *
 * RE-RAISED 2026-09-13, with the app audit's fixes (W1-i): the retry that asks again in place, the
 * session door, the polls, the first screen, the live screen, a Bot's name in Korean and the
 * connection lines — rendered through the real route tree — and ten source walks rendered instead.
 * Measured app 768, re-raised to 3% under; the other three are not this change's to move.
 *
 * RE-RAISED 2026-09-16, after the full audit found every floor stale — 27% under `server`, 16%
 * under `app`, 30% under `agent-computer` and 48% under `root`, the last a hair from the "not a
 * floor" line above — and after that day's fixes landed (one account per deployment, the takeover's
 * typing, the outward-send preview, the Computers page, the routine's zone, the rollback line, the
 * development guard). Now that the manifest catches a vanished file, a floor is the only thing that
 * sees tests going missing INSIDE files, and at those margins a dozen gutted files passed. Measured
 * server 2,497 / app 932 / agent-computer 261 / root 350, each re-raised to 3% under.
 *
 * RAISED 2026-09-18, with 모두 멈추기 and today's trial usage: every run path stopping on a person's
 * word (the loop, a room, a routine queued or running, a coworker's answer, a chat on the wire and
 * one whose step is with a browser) and the door that stops them all brought thirty-two tests to
 * `server`; the dialog's arithmetic, the press order, and the meter and the 80% line brought
 * thirty-seven to `app`. Measured server 2,522 / app 966, each re-raised to 3% under; the other two
 * did not grow.
 *
 * RE-RAISED 2026-09-18, with the first run's two questions about the shop and what every Bot is
 * told about them: the catalogue and its doors, the prompt line and where it sits, what reaches the
 * endpoint on every kind of run, the store and its one route, the boundary never reading it, the
 * welcome and Settings screens pressed through, and the suggestions ordered by it. Fifty tests to
 * `server`, thirty-five to `app` and seventeen to `root`, measured on that branch alone at server
 * 2,540 / app 962 / agent-computer 261 / root 367. Rebased onto the stop-all branch above, each
 * floor is the higher of what the two branches set: `server` and `root` this one's, `app` that one's.
 *
 * MEASURED TOGETHER 2026-09-18, once the answer ratings, 모두 멈추기 and the shop questions were on
 * one tree: server 2,587 / app 1,024 / agent-computer 261 / root 367 — more than any of the three
 * measured alone, so the higher of the two floors above sat 4.8% under `server` and 8.5% under `app`.
 * Those two are re-raised to 3% under; `root` already is, and `agent-computer` did not grow.
 *
 * RE-RAISED 2026-09-18, with routines edited in place and paused when their results go unread,
 * rebased onto all three above: the edit's route, service and form, the Bot's lookup by id or name
 * and its list, the list and the export sending weekdays as a list, the rule's numbers and what it
 * counts — a stopped run among what it does not — the notice, and the banner's two answers. Measured
 * on the combined tree at server 2,636 / app 1,070 / agent-computer 261 / root 367; `server` and
 * `app` re-raised to 3% under, `agent-computer` and `root` did not grow.
 *
 * RAISED 2026-09-18, with 연결 점검: both socket doors answering a probe without registering or
 * opening anything, the check's vocabulary read on the way into a diagnostics bundle (thirteen to
 * `server`), and the check itself — every answer's mapping and every skip with fakes, the copy text
 * holding closed facts only, and the Korean screen reached four ways (thirty-six to `app`). Measured
 * on this branch at server 2,649 / app 1,106; those two re-raised to 3% under, and the other two did
 * not grow.
 *
 * RAISED AGAIN 2026-09-18, with the section boundaries and the screen-error reports rebased onto 연결
 * 점검: the report's route — who may send one, how big, how often, what shape — and its line followed
 * into the diagnostic details beside the window's connection check (thirty-one to `server`); the
 * boundary drawn, pressed and navigated, a roster and two pages broken under an open window in the
 * real route tree, the report built from an error holding a password and a Korean sentence, and the
 * route list held to the generated tree (twenty-five to `app`). Measured on the combined tree at
 * server 2,680 / app 1,131 / agent-computer 261 / root 367; `server` and `app` re-raised to 3%
 * under, the other two did not grow.
 *
 * RAISED 2026-09-18, with the React Compiler rebased onto both: the ceiling on the functions it
 * leaves uncompiled, the four fixtures that hold that check to what it must see, and `useNow`'s
 * minute — seven tests to `app`. Measured on the combined tree at server 2,680 / app 1,138 /
 * agent-computer 261 / root 367; `app` re-raised to 3% under, the other three did not grow.
 *
 * RAISED AGAIN 2026-09-18, with `ensure`, the `finally` that four components hand over so the
 * compiler can compile them: four tests to `app`, holding it to the statement it replaces. Measured
 * at server 2,680 / app 1,142 / agent-computer 261 / root 367; `app` re-raised to 3% under.
 *
 * RAISED 2026-09-18 with the dialog checklist (`docs/laf/dialogs.md`): the live region that is
 * mounted before it speaks, one press as `pressOnce` sees it, the confirm dialog pressed for real in
 * a process of its own and tried at every way out while it runs, the wheel on the Bot's screen
 * registered on the canvas and not passively, and the unread-pause banner's line that outlives it —
 * nineteen tests to `app`. Measured at server 2,680 / app 1,161; `app` re-raised to 3% under.
 *
 * RAISED 2026-09-21, with one honest reading of remote data on every main screen: the helper that
 * turns a query into loading / ready / empty / unavailable / failed — against a real `QueryObserver`
 * and against the refusal codes walked out of the server's own source — the line each state says,
 * the roster's, the routines list's and the screen card's verdicts as pure functions, and the main
 * screens drawn in each of those states. Fifty-nine tests to `app`, measured at server 2,680 /
 * app 1,220 / agent-computer 261 / root 367; `app` re-raised to 3% under, the other three did not
 * grow.
 *
 * RAISED 2026-09-21, with the room pass — a conversation between Bots read as a set of minutes and
 * went dead between speakers. Ten tests to `server` (the turn block in Korean with nothing English
 * left in it, the three reasons a member is asked and the particle on the colleague's name, the
 * wind-down asking for a close rather than for silence, an honorific making a name an address
 * wherever it sits, a list of names being asked together, and a very long paste still being read
 * cheaply) and eight to `app` (who has the floor as frames arrive, and a room's transcript drawn:
 * a face and a name per turn, the colleague that is working named on screen and announced).
 * Measured at server 2,690 / app 1,228 / agent-computer 261 / root 367; `server` and `app` had
 * drifted past 3% and are re-raised to 3% under, the other two did not grow.
 *
 * RAISED 2026-09-21, with the Bot's screen pane made foldable and the page it closed given words of
 * its own: the state a closed browser is in against one that was never used (measured against the
 * shipping computer image, which answers both with the same white frame), the one line a folded
 * pane keeps, the folded card rendered without its picture and still asking for a password, and the
 * width store — what a stored value that is not its shape reads as, a `localStorage` that throws in
 * either direction, and the clamp that decides a 390px phone. Twenty-eight tests to `app`. Measured
 * on the rebased tree, with the room pass above already in it, at server 2,690 / app 1,256 /
 * agent-computer 261 / root 367; `app` re-raised to 3% under, the other three did not grow.
 *
 * RAISED AGAIN 2026-09-21, with the Korean first keystroke and `@` naming more than one Bot: the
 * syllable being assembled in the composer, held to the node it lives in while the screen's own
 * sources arrive under it; Home's box, editable from the first paint and disabled only once the roster has
 * answered with nobody in it; the draft's recipients as a list, a Bot named twice counted once, and
 * the queue's audience — seven tests to `app`. Measured at server 2,680 / app 1,227 /
 * agent-computer 261 / root 367; `app` re-raised to 3% under, the other three did not grow.
 *
 * RAISED 2026-09-21 with both of the above in one tree, which is the number that counts: measured
 * at server 2,691 / app 1,263 / agent-computer 261 / root 367. `app` goes to 3% under that, which
 * supersedes the two floors the branches carried; the other three did not grow.
 *
 * RAISED 2026-09-24, with the room's cap on calling back: two Bots may call each other and call
 * back once a turn, and the next call between them pulls nobody in and ends the turn as
 * `back-and-forth`. Eleven tests to `server` (the cap, the call back it allows, a third member it
 * does not stop, the end reason, the orchestrator around it, and the room line telling a Bot not to
 * hand on what it does not know). Measured at server 2,702 / app 1,263 / agent-computer 260 / root
 * 367; `server` re-raised to 3% under, the other three did not grow.
 *
 * LOWERED 2026-09-24: rooms and multi-Bot removed 2026-09-24 on the owner's order ("봇은 하나다",
 * docs/laf/deployment-model.md). A person has one Bot, so the rooms, one Bot asking another, the
 * participants menu, `@` naming another Bot, duplicating a Bot and the preset gallery went with
 * their tests. main stood at about server 2,719 / app 1,285 (the two read-receipt commits after the
 * paragraph above added seventeen and twenty-two without raising a floor); this tree measures
 * server 2,539 / app 1,122 / agent-computer 261 / root 364. The old floor minus what was removed
 * would be 2,440 and 1,062, looser than a fresh 3% here, so both go to 3% under what this tree
 * measures instead — lower than that would forgive a file that threw on import in the same change.
 * `agent-computer` and `root` keep theirs; root lost three with the room's checks (the upgrade check's
 * room turn, the room's tool in the bridge) and is still above its floor.
 *
 * RAISED 2026-09-24 with the code-quality pass (seams for the Bot's browser banner and cards, a
 * screen error's components and the tool card's report, the profile page's reading, the sheet as a
 * modal, status regions): eleven tests to `app`, eight to `server` (the component list's refusals).
 * Measured at server 2,558 / app 1,108 / agent-computer 266 / root 364. A fresh 3% under would lower
 * both, so each floor rises by exactly what was added; the other two did not grow.
 *
 * RAISED 2026-09-24 with the approval card's words (UI/UX audit 0.5.3, item 3): thirteen tests to
 * `app` (why it asked, the line an answer leaves, the rule behind 자세히) and one to `server` (the
 * shipped rules' text, pinned). Each floor rises by exactly what was added.
 *
 * RAISED 2026-09-24 with the routine card and the person's line (UI/UX audit 0.5.3, item 8):
 * twelve tests to `app` (the card in the conversation, 고치기 as a sentence, the screen's fold, the
 * tool's field and its size) and three to `server` (the line kept, cleared when the routine it
 * describes changes, and carried by the routes). Each floor rises by exactly what was added.
 *
 * RAISED 2026-09-24 with Korean skill names (UI/UX audit 0.5.3, item 11): five tests to `app` (the
 * shape, one spelling, the refusal's words, the / menu, the one-Bot grant on save) and three to
 * `server` (written, granted, read and deleted by a Korean name; kept composed; still refused
 * where it cannot be called). Each floor rises by exactly what was added.
 *
 * RAISED 2026-09-24 with 0.5.3's package B, the Bot's computer: the words over the black frame, a
 * picture that does not come said after five seconds with 다시 연결 (the pane and the socket, the
 * socket let go of, the schedule a reopened pane starts from), the whole-window sheet a person drives
 * on and Escape as 다 했어요, no "이 작업 가르치기" while the Bot asks for help, no "제어" on any of
 * those screens, 다시 켜기 on a site that could not open, and the site rows said for one Bot.
 * Fourteen tests to `app`; its floor rises by exactly that, as the paragraphs above did.
 *
 * RAISED 2026-09-24 with the conversation's record (UI/UX audit 0.5.3, package A: items 1, 13, 5,
 * 6, 9 and the receiving half of 8): thirty-six tests to `app` (one card per turn and what the Bot
 * said inside it, the card's and the banner's names, the half answer and 다시 시도 under it, a
 * message the server never got kept and sent again, the offline line, `?draft=` in the composer, a
 * Korean skill's chip, a step's answer in 한 일) and five to `server` (the ledger telling a Bot that
 * stopped partway from one never reached, and naming the question — never a routine's). Each floor
 * rises by exactly what was added.
 *
 * RAISED 2026-09-24 with the person's clock and place ("날짜, 시간, 위치는 사용자의 정보를"): forty-
 * two to `server` (the three doors and what they refuse and never log, the run told the device's
 * zone over the kept one over the deployment's, the place never taken from a run's props, the
 * headers every computer call carries, the store on a real row, a routine written and fired at 07:30
 * on the person's zone, the export), five to `app` (가게 위치 shown, saved on its own press, cleared,
 * refused in the surface's words, and the device button drawn in a tab and not in the shell), seven
 * to `agent-computer` (a real Chromium on the person's zone and place, following a new place at once
 * and a new zone at the next start) and twenty-five to `root` (the place line, the clock line, what a
 * place may be). Each floor rises by exactly what was added.
 *
 * RAISED 2026-09-24 with the design update: thirteen tests to `app` for the Bot's colour as the
 * accent (every palette's button label, text, tint and ring at AA in both themes, the neutral
 * control before there is a Bot, the words around it), and thirteen for the header's pill (the
 * person's turn before the work, the turn's phase read from its thread, the phase store, the
 * labels in Korean), and six for the one-Bot sidebar (the Bot at the top as the way to its
 * profile, its conversation as the one row, the nav under it, the rail's names, and on a phone
 * the sheet and the button that opens it). The floor rises by exactly that.
 *
 * RAISED 2026-09-25 with the agent harness, phase 1 (epochs, reminders, `now`, the question's
 * bounds, the cache recorded): twenty-one to `server` (the front of every request byte for byte
 * while the minute moves, a new day, a moved place, a rename and somebody else's memory as
 * reminders, a forgotten memory as a new epoch, the model or a tool changing as one, a routine's
 * scheduled time, a restart sending the same bytes, the usage row's epoch, provider and dollars,
 * the break logged, the fleet's `people.cache`) and twelve to `root` (tools in one sorted order,
 * `now` answered in the person's zone, the session in hashes, GLM's own effort words, the steps
 * and dollars a question may take whatever the history weighs, the date and never the minute).
 * Each floor rises by exactly what was added.
 *
 * RAISED 2026-09-25 with the agent harness, phase 2 (results final when produced, one tool list,
 * compaction, Jev): fifty-three to `server` (upstream fast-jev-compaction's own twenty-three,
 * compaction applied byte for byte, the newest snapshot per tab, the blind drop and the excerpt
 * that fixes it, nothing typed in a judge's state, the threshold, the worth of a miss, Jev through
 * the SDK with no retries and a log that says only that it was consulted, allow-or-ask with the
 * calibrated bar, the privacy switch off unless `on`, a service connected as a reminder) and five
 * net to `root` (the loop's own retry and never a 429, routing keyed by model, the same tool list
 * whatever is connected, every result forwarded as it arrived — against the budget tests the cut
 * took with it). Each floor rises by exactly what was added.
 * RAISED 2026-09-25 with 오늘, the Bot's day in the sidebar: sixteen to `server` (the person's day
 * across midnight and a summer-time change, the chat label cut at forty code points without splitting
 * an emoji, a browsing turn folded into one row, and against real tables: somebody else's run and
 * another Bot's never, a silent routine silent with no message, the route's 404) and eight to `app`
 * (each kind of row and its mark, where a press goes, six then the rest, the next two routines, an
 * empty day and a new Bot's first things, the marks' Korean, the day's clock, the jump left for one
 * conversation). Each floor rises by exactly what was added.
 * RAISED 2026-09-25 with five small fixes: twenty-six to `app` (Korean emphasis drawn in both
 * modes and every renderer taking the plugins, a turn held until the Bot's tools are decided, a
 * 오늘 chip sent on the conversation already on screen), six to `server` (a read's range, reading on
 * not counted as repetition, the schema and its size) and two to `agent-computer` (a range past the
 * cut, in characters, and its bound). Each floor rises by exactly what was added.
 * RAISED 2026-09-25 with the performance fixes: six to `app` (a long conversation opens on a
 * window of its newest rows, draws the next page above on request and a row 오늘 asked for however
 * far back, redraws only the streaming message, and where the window starts), one to `server` (a turn over 500 messages reads a bounded
 * tail and rewrites nothing) and one to `root` (the server image runs its bundle). Each floor rises
 * by exactly what was added.
 * RAISED 2026-09-25 with the MiMo follow-ups: thirteen to `root` (agent-bot: ten on a tool-call
 * turn's reasoning going back with it, three on a deferred tool called before its schema was seen
 * and an object argument sent as a string) and five to `server` (the messages route and the merge
 * keeping that reasoning, a redacted typing losing it and an ordinary one keeping it, the server
 * model). Each floor rises by exactly what was added.
 * RAISED 2026-09-25 with browsing: fifteen to `server` (the snapshot as lines, the package's skills
 * parsed and kept small, and against real tables: written as the package's, a grant taken off
 * staying off, a changed body, a name somebody holds, a Bot made later, a skill no longer shipped,
 * the routes refusing an edit), eleven to `agent-computer` (short lines folded, an article read as
 * its story and whole when asked, a page that is not one read whole, a thumbnail as a small JPEG),
 * four to `root` (a screen frame in bytes) and one to `app` (the live screen taking bytes). Each
 * floor rises by exactly what was added.
 * RAISED 2026-09-25 with the 0.5.4 product QA: nine to `app` (a cut-off and an empty answer
 * drawn under what arrived, a browsing turn's failure and answer after its step, the package's
 * skills listed as built in, a held wheel told apart from a question, and two card titles) and two
 * to `server` (the login check reading the page whole, a reader cut never judged). Each floor rises
 * by exactly what was added.
 * RAISED 2026-09-25 with the defects that QA listed: five to `agent-computer` (a thumbnail as one
 * screencast frame, beside the live screen and against the scaled screenshot it replaced), nine to
 * `app` (a help card left by a reload, a No taken back, where a stored failure is drawn, a picture
 * asked for only where one was kept) and five to `server` (the No taken back through the registry
 * and the route, the kept pictures listed). Each floor rises by exactly what was added.
 * RAISED 2026-09-25 with 0.5.4 packages B and C: nine to `app` (a reload that cannot turn 멈춤
 * into 끝남, a site's refusal page, the five words and their reasons, 다시 해 보기 never for a No, 오늘
 * in the card's words, what a turn remembered on its row, the drawer beside the full sidebar) and two
 * to `server` (a refused site and a stopped step read from the real tables). Each floor rises by
 * exactly what was added.
 * RAISED 2026-09-25 with 0.5.4 package A (work survives the window): eighteen to `app` (a
 * button's name made readable, a question drawn from its record, a stranded step found, carried
 * and placed) and thirteen to `server` (a question's step, its holder, a withdrawal, the routes
 * and the matrix for them, a run's `waiting` and how it really ended). Each floor rises by
 * exactly what was added.
 * RAISED 2026-09-25 with 0.5.4 packages D and E: eight to `app` (an answer's pages from what the
 * browser read, a failed read kept out, one page once per turn, the connections list in the shop's
 * order and in the catalogue's without one, a queued correction's words and its Stop, and the idle
 * pill no longer sharing them), five to `server` (the owner's standing permissions listed, said to be
 * off, revoked as the boundary's revoke under who pressed it, another Bot's refused, a Bot not
 * theirs not here) and two to `root` (a miss with nothing connected not sending the Bot searching
 * again, the context layer saying its list is complete). Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with the 0.5.4 final QA: thirteen to `app` (a yes the approval wait wrote first
 * completed by the press that knew its width, and the width read off the server's record; a
 * reloaded remember line saying what it kept; a card cut off between steps reading 멈춤 or 못 끝냄
 * and offering 이어서 하기; a screen that only remounts keeping the wheel; the chosen state held
 * under dark mode) and four to `server` (a yes's width on the approval record, only what the
 * question could give, none on a No; a window that went quiet not read as holding). The control
 * poll's tests moved to a hand-turned clock without changing their number. Measured at server
 * 2,757 / app 1,351 / agent-computer 300 / root 459. Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with attachments (0.5.4 candidate 15): twenty-six to `server` (what a file is
 * by its bytes, the name it is kept under, a sheet and a PDF read for the model, the reference
 * expanded on the fetch for one Bot only, a file unable to close its own fence, the two doors, and
 * the service against the database),
 * eight to `app` (the message a file rides in, files parked with a correction, the composer's
 * refusals in Korean), one to `agent-computer` (the folder emptied when the account leaves) and
 * three to `root` (a photo handed on as `image_url`, words alone sent as they always were).
 * Measured at server 2,783 / app 1,359 / agent-computer 301 / root 462. Each floor rises by exactly
 * what was added.
 * RAISED 2026-09-26 with 수첩: sixteen to `server` (a correction on 수첩 reaching a conversation as
 * a reminder in the same epoch, a line the Bot wrote corrected before the next message, a confirm,
 * a cleared line still a new epoch; the forty-first line carried, owner and shop lines drawn first,
 * a soft edit and its chain, an edit that would not fit, a confirm, a line not written twice; the
 * owner's route and its refusals), three to `app` (no tool handler reaching `/notebook`, the Bot's
 * tool still on `/memories`, the shop lines' Korean) and two to `root` (the carry order, the
 * character bound). Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with the day epochs: nineteen to `server` (where a day's close cuts and never
 * between a call and its result; what the summariser is shown, nothing typed; a summary over its
 * bound losing its oldest lines; the close prepared at night, taken only by a person's new message,
 * outliving a later epoch, waiting on a busy Bot and on a short day, failing without harm, running
 * the existing compaction first, and read back whole after a restart, in memory and in Postgres;
 * the two switches; an attachment whose question is behind it becoming a note, in the store at the
 * threshold, and named in the summary). The floor rises by exactly what was added.
 * RAISED 2026-09-26 with the final QA's small issues: six to `server` (a joining window's replay
 * with a stopped run's error settled, what the stopped run left open closed and no call answered,
 * a live error left alone; a picture early for its result told from one for no call, in the route
 * and against the database; a kept picture told to the person's windows) and twelve to `app` (a
 * picture kept, early, held for the next turn, refused once, and a cut-off task's held; a kept
 * picture making its conversation's list stale; a turn's last task reading the turn's failure;
 * a step out elsewhere, said so, never for a person at the wheel, and 오늘 not saying 사장님 차례
 * without a question; a turn sent before the history arrived). Each floor rises by exactly what
 * was added.
 * RAISED 2026-09-26 with the memory package: twenty to `server` (the scrub's rule and its judge,
 * a forgotten memory leaving the next epoch's frozen layer and the summary line that said it, a
 * waiting close losing it, a later close told it and scrubbed anyway, the summariser told the rule
 * only when something is forgotten, a curation's drop and the
 * dream's guidance never breaking an epoch, where a line was learned and the jump to it, the
 * deletion on record, no Bot writing a forgotten line back, a revision's supersedes, the curation's
 * four verdicts and a judge that cannot answer, the dream refusing what is not a habit and never
 * bringing back what the owner removed) and one to `app` (the receipt row in 오늘, 밤사이 only
 * before six). Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with the standing spare's locked front door: two to `server` (the migrate
 * step's ledger read, pure and against a database of its own, applying once and skipping after)
 * and six to `root` (the lock first in the routes Caddy produces, in both states; every path 503
 * and the healthcheck 200 from a running Caddy; the lock first in the text; the fast health checks
 * while starting; the server's dependencies pinned for `--no-deps`; the lock passed to the front
 * door, open by default). Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with the 0.5.5 final QA's fixes: two to `app` (a retry in place retiring the
 * failure a task that died between two steps left; a failed turn marking the room read as it
 * ends). Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with the shell kept awake and reachable (P2): eight to `app` (every pill kind
 * folded into the tray's three codes and sent through the command; the update read back, refused
 * and listened for; the summon choices the shell lists all drawable, read only in the shell's
 * shape, and absent in a tab or an older shell) and three to `root` (the shell's commands handled,
 * declared and granted as one list; no capability granting a plugin that acts on the machine; the
 * window not suspended when put away). Each floor rises by exactly what was added.
 * RAISED 2026-09-26 with connection resilience (P1): six to `server` (a page's ping answered; a
 * page that answers still counted past the listening window; a silent page no longer counted while
 * its socket is open, then closed; the finished-run notice written when the only socket is silent;
 * a page from before the heartbeat held as before; the hub counting only what is listening) and
 * twenty-four to `app` (the page's heartbeat: the feed opened with it, pings kept and a silent
 * socket given up, the server's ping answered, a probe when looked at, an open that never comes,
 * the backoff reset only after a minute; the notice's grace and its thirty-second sentence; a chunk
 * in each engine's words, the reload once per build with what was typed, again for a new build,
 * never into an unreachable server or without storage, Vite's event taken at once; failures by
 * class — a dropped connection, a stale page, reported only when the reload was spent, the three
 * new facts in their shapes; the calm part that comes back with the socket, the loading one, the
 * one that offers the reload; the typed text back in its box on the next page). Each floor rises
 * by exactly what was added.
 * RAISED 2026-09-26 with the security package (sec3): ten new files — the host firewall's probe in
 * `agent-computer`; the task and today widths, the high-risk check through the gateway and on its
 * own, the withheld mail secrets (unit and plugin path), the vendor's echoed credential and the
 * converter's fresh child in `server`; the owner's view of a withheld code in `app` — and the
 * changed files around them. Each floor is set to the count this branch ran (server 2980, app
 * 1416, agent-computer 313, root 480): main's own counts already stood above its floors, so these
 * rise by more than the package added, and no further than what runs.
 * RAISED 2026-09-26 with turn measurement (P3): twenty-seven to `server` (the run meter's times,
 * steps, requests, retries, money, the person's tools and numbers-only output; every ending against
 * its facts and every code the one shape, a code taken out of a sentence; nine turns through the
 * real ledger into the turns section, with the owner's words planted beside them and found in
 * neither; a routine's ending written inside its transaction on a pool of one) and six to `root`
 * (a retry said on the wire, twice, in agent-bot; eval:from-failures rebuilding a saved answer
 * field by field, its week's numbers, its skeletons, and a file that is not an answer). Each floor
 * rises by exactly what was added.
 * RAISED 2026-09-27 with the server owning the turn: twenty-five to `server` (a chat turn's tools
 * carried out on the server and answered as the window answered them, a question held and waited on
 * there, a help request and its skip, a decision card answered from any window, manage_routine's
 * refusals; the live cursor, its snapshot and its log per turn; a turn run through the real thread
 * store and ledger with nobody watching, framed as one run, joined halfway, stopped from anywhere
 * and queued behind a routine with its record already open) and nine to `app` (what a window makes
 * of the frames: deltas, a join halfway, the server's own copies, replays, a failure, notices).
 * Each floor rises by exactly what was added.
 * RAISED 2026-09-27 with the review of the server-owned turn: nineteen to `server` (the lane let go
 * of while a turn waits on a person and taken back before it acts, a yes not spent on a page a
 * routine moved, a navigation still allowed, the wheel back told to look again; a stop while queued;
 * a routine behind a busy Bot not holding the clock; the turn door counted as a message; the hub's
 * numbers going on after a sweep; a correction taken the moment the end is heard; what broke logged
 * and handed on as a fact, the deadline's own fact; each request filed under its turn and the roster
 * seeing it; an account's deletion stopping its turns, and leaving anyway when it cannot; a tab by a
 * fraction and a file with no name refused, a path trimmed, a failed listing keeping the last tools;
 * the server's classifier reading the new facts) and one to `app` (its classifier reading them too).
 * Each floor rises by exactly what was added.
 * RAISED 2026-09-27: six to `root` — three for this week's Friday graded on a weekend's calendar
 * (evals), three for the upgrade e2e's chat turn through the front door (a turn that ends done with
 * its phrase, one that ends in error, a send the door refuses).
 * RAISED 2026-09-27 with 지원사업 비서: four to `server` (a tag nothing carries is an empty answer, not
 * a refusal; a field list; unknown codes dropped; the widening described), seven to `app` (the chip
 * offered only where the Bot holds the grant, its place in the row, its press reported, the day card
 * drawing it) and thirteen to `root` (the eval judge reading only what 기업마당 returned, and the
 * runner's awaited stubs, skills and round limit). Each floor rises by exactly what was added.
 * RAISED 2026-09-27 with the first session's polish: five to `server` (a call cut partway through
 * its arguments filed as the cut and the retry answering; five different reads not asked about and
 * five identical ones asked; a write still counted by its tool; a read's arguments keeping two
 * reads apart outside the fingerprint, and the tool alone without them), five to `app` (the step
 * labels' Korean, every core tool named, every catalogue tool never shown by its name, the walk's
 * two lines, the fallbacks) and three to `root` (a retry after a cut leaving the half call out and
 * routed afresh, only the cut calls left out, a turn of nothing but cut calls gone). Each floor
 * rises by exactly what was added.
 * RAISED 2026-09-27: one to `server` (a plain write beside a rolled-back transaction survives it —
 * the two-pool guard against Bun's pre-1.4 pool, `db/client.ts`) and one to `app` (a failed remember
 * line names what was tried).
 * RAISED 2026-09-27 with the answer's latency: two to `root` (no measured line orders what it
 * ignores, DeepSeek asks the fast endpoints first; each round's log line names the endpoint and its
 * output tokens). Each floor rises by exactly what was added.
 * RAISED 2026-09-27 with 아침 브리핑: ten to `app` (eleven added — which sections a Bot's reach puts
 * in the briefing and in what order, the cap on places, the instruction and the chip's line in
 * Korean, every key they can ask for, the chip saying what it will have, the place it needs for the
 * weather, a briefing already made — less the one that held the chip to repeating the first
 * sentence, which it no longer does) and fourteen to `root` (the briefing eval's judge failing a
 * padded, a repeated, another region's, an invented and a cursorless Monday, a Tuesday that says
 * 지원사업 or heads an empty inbox, and the scenarios sending the chip's own instruction).
 * RAISED 2026-09-27 with the first-hour walk: five to `app` (a routine run's answer drawn as prose
 * and a failed run's sentence left as it is; the Notebook's meter counting what is written; a
 * briefing made without a place still saying the weather needs one; 지금 실행 in words on its
 * button). Each floor rises by exactly what was added.
 * RAISED 2026-09-27 with the Bot speaking first (phase 1a/1b): twenty-one to `app` (the persona
 * tables walked and the rows each persona deals; the greeting pressed with no turn, its follow-ups
 * through the shop's and 수첩's own doors, and its head above a conversation) and twelve to `server`
 * (`PUT /api/me/persona`; the 호칭 on the profile and in the context layer only). Then four more to
 * each for the follow-up asked once: settled before its 수첩 line, not asked again on reload.
 * RAISED 2026-09-27 with grounded answers: thirty-two to `root` — twenty-nine for the judges of the
 * 세금노무 and relative-day scenarios (a small shop exempted by head count six ways and not exempted
 * seven, the payroll and 최저임금 verdicts, the official pages' browser, dates beside weekdays, the
 * walk's 모레 on the weather page) and three for the week line (seven days across a month's end, the
 * person's zone deciding the week, a new day's reminder carrying it). The floor rises by exactly
 * what was added.
 * RAISED 2026-09-27 with the phone and the words: six to `app` — seventeen added (a reply heard
 * without its markdown, five ways; the Bot's bubble on a phone and the person's; the suggestions'
 * line when nothing is connected; no 오늘 heading over only 다음; eight for a browsing card titled
 * with what the Bot looked up) and eleven taken with the person's sentence as that title, which it
 * no longer is.
 * RAISED 2026-09-27 with skills that need a tool: three to `server` (지원사업 names its tool and every
 * named tool is one a deployment can offer; `requires:` parsed or refused; a skill withheld where its
 * tool is not, and arriving and leaving with it).
 * RAISED 2026-09-27 with reply actions on touch: four to `app` (the row shown and in flow on a touch
 * screen and hover-only with a pointer; what 인용해 답하기 puts in the composer, three ways).
 * RAISED 2026-09-27 with the phone's bottom bar: seven to `app` — eight added (three labelled tabs
 * and where they go; off the PC app and tall enough; out of a keyboard's way and not a focused
 * composer's; the tab that is the page; the unread mark; 메뉴 holding the sidebar's own places, and
 * 관리 and 봇 프로필 where they belong; 소식 with a line for an empty day) and one of the two sheet
 * tests taken with the sheet (the other now says there is none).
 * RAISED 2026-09-27 with the persona wording sweep (phase 4): five to `server` (askChoice
 * `saves: "persona"` writes nothing on the Bot's call, writes the person's press, ignores an answer
 * outside the four and an ordinary choice; the write only after the wait, in the one turn file),
 * three to `app` (the card's four fixed answers whatever the Bot sent, and a plain question's own
 * options; no 사장님 as "you" anywhere in the dictionary) and two to `root` (no 사장님 in the tool
 * results, and one line of the base prompt naming it).
 * RAISED 2026-09-27 with 아이디어 (phase 5): nine to `server` (the same keys for every persona in
 * its own order; 사장님 by the shop answers; connect and ready and needs_login; what the deployment
 * offers no door to and a tool the Bot lacks left out; nothing needed is ready everywhere; 다음에
 * latched as idea:<key>; that latch never hiding a routine suggestion; the two doors) and twelve to
 * `app` (the catalogue's Korean, keys, categories and leads, its connections, a routine's time, the
 * seven categories; the same set in every order, each persona first, ready before connect; why a
 * card is there and its words; the compose screen taking `draft`).
 * RAISED 2026-09-27 with 만든 것 (phase 6): seven to `server` (the cards that reached the screen and
 * the written table, newest first; refused, thrown, unanswered and question cards left out; a
 * shelf; nobody else's; the pages walking back; the door's refusals) and nine to `app` (every
 * gallery card filed; the shelves' cards; a table's title four ways; the page's words, shelves,
 * kinds and stems).
 * RAISED 2026-09-27 with 소식 (phase 7): sixteen to `server` (a source only from this run's tools,
 * a navigation's page, a failed one not, addresses compared as pages; three a run, no repeats, the
 * shape; `feed_post` only where it was put; made once and kept `feed` through an edit; the list
 * showing its instruction; posts landing with a run that succeeded and no answer delivered; none
 * for a failed run and the answer for one that stopped for the person; the presses scoped to the
 * person; likes and hides carried to the next run; a quote read again by its id; unseen posts
 * pausing it) and eight to `app` (the topics, refusals and instruction; why a post is here; the
 * quote's part and its chip in the transcript; the chip making briefing and 소식 in one press).
 * RAISED 2026-09-27: two to `root` (the upgrade e2e reports a package's own skill rows, rewritten or
 * withheld at boot, instead of failing on them, and still watches a skill somebody wrote).
 * RAISED 2026-09-27 with 소식's cost: eight to `root` (the `feed-posts-only-from-tools` judge: the
 * fixture's snapshot and click, a good post passing, an address nobody returned, a listing cited as
 * the article, a number no page said, no post; a stale ref opening nothing; which listing a search
 * lands on).
 * RAISED 2026-09-27 with 목표 (phase 9): nine to `server` (saved only after a yes this turn —
 * none, another goal's card, one yes spent once; a malformed call not spending it; the active
 * limit; the chat turn carrying 예 to the save with the tools offered though no window declared
 * them; progress from chat by id and by title and nobody else's; a routine linked by name and its
 * run logging to that goal alone; the page's own reads, presses and deletion leaving the routine
 * unlinked), eight to `app` (momentum, status and refusal words; the seven categories' icons; the
 * sentence the sheet sends; a number to watch; the tools' step lines; a send taken once, never
 * from the address) and one to `root` (the offered list the same bytes with or without them).
 * RAISED 2026-09-27 by the code sprint's fixes: twelve to `server` (소식 sources only from what a
 * page or a service said; a goal's yes read from the card's headline; 다시 진행 under the cap; the
 * export's routine columns; unknown field codes refused; a yes not carried out after 멈춤), two to
 * `app` (a resumed snapshot brings the stored answer over a streamed half) and two to `root` (a cut
 * conversation's retry starts further down the provider order).
 *
 * RAISED 2026-10-02 with the file card (phase 8, first slice — the Bot hands a file to the person):
 * thirty-one to `server` (a file's bytes read by the client, exactly and to a bound; the three doors
 * a person has into the Bot's folder and what a file leaves this origin wearing; the card confirmed
 * only for a file that is there), sixteen to `app` (the card: a link for a file that is there, a
 * sentence and no button for one that is not, a path asked about once it has stopped being written;
 * 파일 a filter only once there is a file), twenty-seven to `agent-computer` (a file's facts and its
 * bytes through the workspace's confinement and the container's own door) and ten to `root` (the
 * server's real client against the container's real routes over a socket, which neither half's own
 * tests can see).
 *
 * RAISED AGAIN 2026-10-02, on the gate that ran the merged tree, each by exactly what was added:
 * forty to `server` (the web search's transport — what goes out, each kind of no, the day's cap —
 * and every deployment-key entry reconciled together; a connect card waited on and answered from
 * 연결, never from a window; the core search tool offered as the server knows it), twenty-one to
 * `app` (a pointer's buttons and a keyboard's keys on the live screen, always let go of, and a
 * double-click counted; the connect card answering once a switch turns on; a search's results as an
 * answer's sources) and eleven to `agent-computer` (a hover that is not a drag and what is held
 * being released, against Chromium itself). `root` did not grow.
 *
 * RAISED 2026-10-02 with the weather, to what the gate measured: 134 to `server` (기상청's three
 * operations summarised from its own bodies, each kind of no, the key in nothing that comes back;
 * the grid and the table of places, the names people say for them; the entry the fleet's key opens
 * and the one reader that makes "오늘 날씨" the person's own place's; the owner's sentence redacted
 * before the high-risk judge reads it) and three to `root` (the place line sending the weather to
 * the tool first; what an eval report's two hashes are taken over). `app` and `agent-computer` did
 * not grow.
 *
 * RAISED 2026-10-02 with the first move (`turns/first-move.ts`): eighteen to `server` — what is
 * never sent and to whom, the two bars, a move with no argument, the trail's row; the engine
 * filing the server's call as the Bot's before its model is asked; the switch's three words and
 * what it says at boot when it can do nothing.
 *
 * RAISED 2026-10-02 with three protocol fixes read off upstream: eighteen to `server` — an MCP
 * answer that arrives as `structuredContent`, as an embedded resource or as a resource link is
 * read rather than called nothing (`mcp-result.test.ts`, the first tests `resultText` has had), and
 * a Drive shortcut is followed to its file, once.
 *
 * RAISED 2026-10-02 with the take-over keyboard, each by exactly what was added: twenty-three to
 * `agent-computer` (every written character arriving as its own key and no other — a full stop was
 * Delete and `$` Shift+Home; Enter sending a form and breaking a line; ⌘ as Control and a shortcut
 * writing nothing; against Chromium itself, two of them only where it is the Bot's own) and ten to
 * `app` (the number this browser gives a key, sent with it; ⌘V left to the browser that has the
 * clipboard; text that arrives with no key sent on and not kept; the Enter that accepts a Korean
 * syllable not saving a line of 수첩).
 *
 * RAISED 2026-10-02 by one in `agent-computer`: the test that fails where a run says the browser is
 * required and Playwright has none. A FLOOR CANNOT SEE A SKIP — it counts what bun counts, and bun
 * counts a skipped test — which is how CI ran green for four weeks with every browser suite skipped
 * (`.github/workflows/checks.yml`). The floor is still the right check for a file that vanished;
 * for a suite that stopped running where it stood, it is that test.
 *
 * RAISED 2026-10-02 with sound text (`shared/sound-text.ts`), each by exactly what was added: eleven
 * to `server` (a turn whose tool answered with half an emoji or a NUL kept whole, against a running
 * database, and a trail row with such a name written; a tool's answer filed sound; a result, a
 * vendor's sentence and a link's name cut between characters; a preview and a name that do not end
 * on half a flag), two to `agent-computer` (a name cut between characters; an emoji across a
 * range's edge read once) and sixteen to `root` (the cuts and the mending themselves; a spilled
 * result's head; nothing in a request the Bots' model refuses). And one more to `agent-computer`
 * the same day: a half-ticked box read as not ticked.
 *
 * RAISED 2026-10-02 with the rest of what the sweep of upstream found in `server`, thirty-nine, each
 * reproduced before it was ported: a Drive file read by its opening and the download ended, shared
 * drives reached and the trash left out; the trail paged from a row's own microsecond; a
 * connector's and a skill's grants removed with them; a stored OAuth client that is not one
 * refused without being quoted; the connection test reading an opening and not a run; a key that
 * cannot be sent as a header refused when it is typed.
 *
 * RAISED AGAIN 2026-10-02 with the sweep's other half, each reproduced first: thirty-two to
 * `agent-computer` (a reset that has the profile to itself, against a real Chromium; an ask nobody
 * answered let go of after the Bot's own wait and never inside it; a proxy's password out of its
 * label; a frame that is not a person's input stopped at the live screen's door), six to `app`
 * (the skill panel saying a failed read failed; a refused card not drawn) and three to `server`
 * (the wait and the ask's time read from one number; a cut result under the bound with its note).
 *
 * RAISED 2026-10-02 by one in `server`: a navigation's trail row saying nothing about an element —
 * it had said the Bot acted on one "not in the current snapshot", and 14 of the fleet's 18 failure
 * signals that week were navigations that had worked.
 *
 * RAISED 2026-10-02 by eight in `root`: the bridge asked for a tool the Bot already holds — by its
 * exact name, by a bare one, in words, beside one that is behind the bridge, and called through
 * `tool_call` — answering that it is in the list, where it used to answer that there was no such
 * tool and a Bot opened its browser instead (`tests/tool-bridge.test.ts`, the bot's deferral tests).
 *
 * RAISED 2026-10-02 by five in `server`, from the refactoring review of the turn's path: a turn
 * whose last write is refused for a moment written again, and one that cannot be written ended as
 * a failure and not as `done`; what a turn has made flushed before the process leaves; a tool
 * whose handler throws answered as a failed step with a code. (The lane test gained no test, only
 * what it asserts: a turn waiting for the Bot again says `queued`.)
 *
 * RAISED 2026-10-02 by twenty-four in `app` and three in `root`, from pressing things in the
 * installed app: a download that ended said on screen, saved or not (`download-notice.test.tsx`,
 * the bridge's half in `shell-awake.test.ts`); a file let go anywhere on the window attached once,
 * and one nothing took refused at the window (`composer-drop.test.tsx`); and in
 * `desktop-shell.test.ts`, the window built by the shell from its config with a download handler,
 * drops left to the page, and a development launch that is not the installed app.
 *
 * RAISED AGAIN 2026-10-02 by fifty-one in `app`, the first tests to mount the conversation people
 * actually use (`ServerChannelChat`; the harness is `tests/support/turn-server.ts`): a history
 * that could not be read said so and read again (13); a turn waiting for the Bot saying so, after
 * two seconds and never for a moment (14); what was queued mid-turn kept on the device, still
 * waiting after a reload and gone in the order typed when the turn ends (19); and words that did
 * not leave handed over once, and by themselves only when the connection is back (5).
 *
 * RAISED AGAIN 2026-10-02 from pressing the conversation itself: fifteen in `app` (words typed and
 * not sent back in the box, 6; the thinking line between steps and a finished look-up leaving no
 * line, 9), two in `server` (a file write saying the person has not been handed the file, where a
 * card could hand it) and three in `root` (the screen's cards found from Korean, and the one that
 * hands a file over in the schema).
 *
 * RAISED 2026-10-02 by seventeen in `app`: what the Bot is doing, said on the screens that are not
 * its conversation — the pill's order and the decision behind it (9), and the app mounted with a
 * turn going and the conversation left (8: three of them the review's — a list already on its way,
 * a turn the conversation saw end, a conversation that left before it had heard — and one from
 * pressing it, a conversation that has not heard yet).
 *
 * RAISED 2026-10-02 by fifty-six in `app`: a question the Bot stops on, known on every screen —
 * the shell's watch with the server's record handed to it, one question on two lines and a
 * transcript's own calls (15), the app mounted on a screen that is not the conversation, with what
 * it draws and when it interrupts (26), and the notice's decision with where the card is (15).
 * Twenty-nine of them are the review's: a second conversation with the same Bot, the approval's
 * own page, a first read the server did not answer, a frame read before the record, the notices
 * that never reach the store, a frame that arrives before the first read, a request that arrives
 * before the list of conversations, a row the first read returned whose frame arrives after it, a
 * question whose notice was pressed and not answered, a routine's question in the Bot's only
 * conversation, and the sidebar's row for a question raised in another conversation.
 *
 * MEASURED TOGETHER 2026-10-03, to what the gate counts once two days of pull requests had landed.
 * Each had left this line alone, or raised it by its own tests only, so as not to meet the others
 * on it — and a floor that far under the count lets an area go without the run failing, which is
 * what it is for: `server` 3418 to 3431, `app` 1764 to 2081 (the kept conversation and its model,
 * a typed answer to a card, 새 메시지, the tilde, the copy button, a card asked with nothing in it,
 * the engine's update notice), `root` 608 to 610 (the shell's floor, and the tray's words held to
 * the dictionary).
 *
 * RAISED 2026-10-03 with the Bot's browser refusing the deployment's own app, each by exactly what
 * was added: fourteen to `server` (the floor's table for a deployment's own addresses, and the
 * client refusing where the Bot names one, where the browser landed on one and where the container
 * stopped the hop), eight to `agent-computer` (the guard on a stand-in for Chromium's session, and
 * four against a real Chromium with a second local server standing for the app), one to `root`
 * (compose handing the browser the server's own four variables).
 *
 * RAISED 2026-10-04 with the names the page gives the controls the tree left nameless, by exactly
 * what was added: nine to `agent-computer` (four on the parser's unnamed refs and the names put in
 * their place, four against a real Chromium holding each shape to the role engine and keeping a
 * field's contents out, and the button around a search box through the routes).
 *
 * RAISED 2026-10-04 with the reader keeping a page's notice, each by exactly what was added:
 * thirteen to `agent-computer` (the reader's string answer, two; a page that replaced `Map` as
 * 고용24 does, one that makes the reader throw, one that takes `innerText` itself and frames that do
 * either, four in a page and two through `/navigate`; and the extract declined for a short page, a
 * footer outside the `<article>` that is all the page calls one and a wall of links, with a story
 * inside the element and one beside it still the article, five), two to `root` (a navigation's
 * notes reaching a chat's model, and only when there are some). And four more to `agent-computer`
 * from its review: a throw inside the page said by a name from our own list, a renderer that
 * crashed still the browser's failure under both of its names, and the one line a fallback leaves.
 *
 * RAISED 2026-10-05 with the days past the 단기예보, by exactly what was added: forty-five to `server`
 * (thirty-one on 중기예보 — its issuances, the days two rows hold, what a Bot is handed with the
 * portal's key and without it, and every way the portal does not answer; thirteen on which of
 * 기상청's regions a place is in, the shipped table's every row among them; and one on a deployment
 * handing the weather the portal's key).
 *
 * RAISED 2026-10-05 with the help card reading its own Bot, by exactly what was added: four to `app`
 * (a card that was waiting on the person when its conversation is drawn again — from another place,
 * and under a screen that stayed, for a hand and for a secret — and the activity card asking only
 * for the Bot its conversation names).
 *
 * RAISED 2026-10-05 with `eval:browse` run through the product's own loop, by exactly what was
 * added: thirteen to `root` (the judges of a browsing run — the prompt its second arm reads, the
 * sentence where it would ship and nowhere else, two; a thread read into the rounds the model
 * asked for its steps in, the batched ones, the steps a round's stop left unreached and a press
 * that went through before the rest, five; and a form judged by what the site says it received —
 * its sends counted, and passed only when sent once from a clean tab exactly as asked, six).
 *
 * RAISED 2026-10-05 with the paragraph about several steps in one reply, by exactly what was added:
 * five to `root` (the paragraph held to the bytes that were measured, the other arm made by taking
 * it out — three where two were; and the answer judges on two stored answers, a short one and the
 * count itself, four).
 *
 * LOWERED 2026-10-05 in `app` by seventy, and RAISED in `server` by fifteen, with the window-driven
 * chat path deleted — each by exactly what went, less what was carried over. The window that ran a
 * turn itself (`ChannelChat`, `SERVER_TURNS=off`) was removed, and the tests of that mechanism went
 * with it: the in-mount queue's reducer (fifteen), the history repair (seven), the stored-history
 * mapping and its read (four), the watcher of a step another window took (three), the calls a
 * window may carry on and where their results go (five), words kept for a card settled by the
 * window (twelve), a turn as several runs and a send ordered behind the window's own history read
 * (three), the playground card's refusal recorded by the window's handler (two), and the retry that
 * merged a replayed run (one). Eighteen more in `app` were the tool handler's (`routineAction`
 * over the routes): sixteen were carried to the server's own `routineAction` and two were already
 * held there or by the shared sentence, which is the sixteen `server` gains — with one for
 * `SERVER_TURNS=off` refusing to start, less two for the step lease's routes. Nothing that
 * describes the product went: the tests that had mounted the window to check something else — the
 * greeting, the first screen, a draft handed over, a routine's failure line, the polling budget, a
 * half answer's notice, 다시 시도, words the server never got, an answer's rating — were moved onto
 * the turns the server owns, in their own files, and count as before.
 *
 * RAISED 2026-10-05 by two in `app`, with the row for a code a mail held reading its own Bot: it
 * asks for the Bot the conversation names now and not the one its renderer was registered for, and
 * for nobody before a conversation has named one.
 *
 * RAISED 2026-10-05 by nine in `app`, with the Bot's own lines and its cards reading how their call
 * ended: a routine, a profile, a skill and a look at the clock the server refused or a stop cut
 * short each say so (five, one of them the three ways a routine edit does not happen), an authored
 * card refused at call time is the refusal and not the card (one), and a gallery card's call drawn
 * by the function its renderer is (three). And by one more in `app`: the same words queued twice
 * are two messages, and taking one back leaves the other to go — the one rule of the deleted
 * in-mount queue's reducer that nothing held for the outbox. And by one in `server`: compose
 * still hands on `SERVER_TURNS`, retired, so that a stale `off` reaches the refusal.
 *
 * RAISED 2026-10-05 with a crashed tab let go of, by exactly what was added: ten to `agent-computer`
 * (a navigation's failure told apart as the renderer's death or the site's, one; and nine against a
 * real Chromium behind the real door — the next address opening, every look and a click answered
 * about the tab that took its place, a crash while a page is opening answered as the browser's, the
 * one line in the log with the origin and nothing else of the page, another Bot's tab untouched, a
 * popup dropped and its refs retired, a tab that will not close handed to nobody, the live screen
 * moved to the new tab, and every renderer ended at once with each Bot left a tab of its own).
 *
 * RAISED AGAIN 2026-10-05 with nothing acting on a tab a Bot was put on and has not seen, each by
 * exactly what was added: fifteen to `agent-computer` (five on the wheel's state — an ask whose tab
 * is gone ending as nobody's answer, a person keeping the wheel, the next ask waited on afresh; four
 * on the tab bookkeeping without a browser — the crash line bounded to one a minute with its count,
 * a loss said only for the tab the Bot was on, a death counted once, a tab dead before adoption
 * adopted by nobody; and six against a real Chromium — a value typed after its tab died and after
 * its site closed it reaching no page, no answer and no log line, no key, scroll, switch or file
 * before a look, the loss said once on the first look, a tab dead before it was owned handed to
 * nobody, and a death nothing heard learned from the call that failed on it), two to `server` (a
 * hand and a value asked for on a tab that is gone, each answered as nobody having come).
 *
 * RAISED AGAIN 2026-10-05 with a look being the Bot's own, each by exactly what was added: seven to
 * `agent-computer` (a value that could not be put in its field closing its ask as nobody's answer,
 * on the wheel's state and through the door; and five against a real Chromium — a person's read,
 * snapshot and opened page not counted as the Bot's look, the loss said on the page a navigation
 * lands on and not on a hop held on the way, a stale ref refused for a value after a look, crash
 * words thrown by a page not closing its tab, and a failure on one tab letting go of that tab and
 * not the one the Bot moved to), five to `server` (the client saying whose look each look is, a
 * turn's and a routine's looks said to be the Bot's, a value that could not be put in its field
 * answered as not entered, and its failure leaving no supplied row), one to `root` (the lost tab's
 * site put beside its sentence, and no other fact's), one to `app` (the card still saying why a
 * value did not go through after its box has gone).
 *
 * LOWERED 2026-10-05 in `agent-computer` by three, with the name the list used to guess for a
 * control the tree printed without one deleted (`nameFromWithin`) — by exactly what went, less
 * what was added. The look had replaced that name on every control it was made for since
 * 572a3eab, so five tests held only the guess and went with it, by title: the words a link took
 * from inside it, those words found through nameless wrappers one space apart, an address and a
 * frame's contents left out of them, the name they gave the control around a labelled field, and
 * where they were cut. Two were added: whatever is beneath such a control gives it no name here,
 * and the control around a field, or around text that can be edited, carries what was typed there
 * in neither a name nor a value. Nothing that describes the list a Bot is shown went — the tests that had read the guess
 * to say something else now say it of the tree's list and the look's: which controls the page is
 * asked to name, that such a control has no name until it answers and no value ever, and that a
 * field's contents are nobody's name.
 *
 * RAISED AGAIN 2026-10-05 with a Bot's tabs kept to a number, each by exactly what was added:
 * fifteen to `agent-computer` (six on the tab bookkeeping without a browser — the tab used longest
 * ago closed and each Bot's number its own, the opener of the tab the Bot is on kept, a held tab
 * kept and the Bot over its number when nothing may go, the line bounded to one a minute with an
 * origin only, an index read before a close refused until the list is read again, a closed tab
 * handed to nobody; one on what a session holds open — the cast, a value's tab, the wheel's tab;
 * and eight against a real Chromium behind the real door — the count that stops growing, which had
 * gone 2 to 31 in thirty opens, the oldest tab closed and another Bot's left alone, a stale index
 * refused with the Bot not frozen, the fact said once on the Bot's own list, the one line in the
 * log, the tab a value was asked for on kept, the tab a person holds the wheel on kept, and ten
 * idle minutes still closing everything), one to `root` (the closed tab's site put beside its
 * sentence, which does not say the Bot's own tab went).
 *
 * RAISED AGAIN 2026-10-05 after that change's review, each by exactly what was added: three to
 * `agent-computer` (a tab that is nobody's closed by the sweep after a minute, on the bookkeeping
 * and against a real Chromium, with the browser's last tab left as the spare; and a page kept under
 * its sign-in window and two more above it, behind the real door), four to `server` (a snapshot
 * saying old tabs were closed and a routine's read saying its tab went each ending the round for
 * the switch and the key after it in the same reply, a look saying neither ending nothing, and the
 * rule read on its own).
 *
 * RAISED AGAIN 2026-10-05 with a ceiling over the cap, by exactly what was added: four to
 * `agent-computer` (a chain of windows each opened by the last stopping at twice the cap, on the
 * bookkeeping and against a real Chromium, where it had gone 2 to 19 in eighteen windows; a tab
 * that opens when every other is held at the ceiling not taken; and a tab the browser never
 * answered about asked about again, and not kept past the ceiling).
 *
 * LOWERED 2026-10-05, `agent-computer` from 537 to 495, by exactly the forty-two tests that held a
 * person's typing in an editable region out of what the Bot reads: the owner chose the same day to
 * take that back (a person and the Bot write one page together, and the Bot has to read what is
 * there), so the tests went with the code they described. A value typed into an ordinary field is
 * still kept from the Bot, and the tests that hold that are all still counted.
 *
 * RAISED 2026-10-05 with the first move on unless a deployment says off, by exactly what was added:
 * four to `server` (a decision that left the step to the Bot leaves a row saying why and how sure,
 * and a message never asked about leaves none; the default on where it can do nothing is said once
 * and is not a warning; a boot asks once, of a sentence nobody sent; and it asks nothing with the
 * move off, nobody to ask or a spent day, and a failure is only said).
 *
 * RAISED 2026-10-05 with the calendar's and the mail's first moves, by exactly what was added:
 * thirteen to `server` — eleven in `first-move.test.ts` (the two tools are the catalogue's own,
 * read-only and unguarded; one request a message with only the kinds whose words it has; a clear
 * yes is a constant whatever the decisions model said; a hair under either bar is no move; without
 * the connection or the grant nobody is asked; two kinds clearing is no move; a connection that
 * stopped working is none and a weather question reads none; the rows say which kinds and never the
 * message; no log line holds a word of it; what a boot can say of a person's kinds; a boot warms
 * every kind that is on) and two in `config.test.ts` (`FIRST_MOVE` as a comma list, and a word that
 * is not a kind refused) — and seven to `root`, the eval's own rules held without a network
 * (`tests/eval-first-move.test.ts`).
 *
 * RAISED AGAIN 2026-10-05 after that change's review, by exactly what was added: twelve to `server`
 * — six in `first-move.test.ts` (a word only near a schedule or the mail is not sent; a change to
 * the calendar or something done with mail is decided by rule; what people do say is still sent; a
 * message that leans on the one before it is not asked about; the two rows have the shape the rate
 * is counted from; a named kind that cannot be made is said per kind), five in
 * `plugin-rest-adapters.test.ts` (a mail search's first line says what was searched for; the
 * calendar's `day: today` at nine in the evening is the whole local day; without `day` it is still
 * from now on and says so; an empty day says which day; the day is the person's zone's and a day
 * that is none is refused) and one in `plugin-mail-secrets.integration.test.ts` (the transport is
 * handed the person's zone) — and two to `root` (ordinary chat that wants none of it is sent under
 * 3% for the calendar and the mail; a rate is counted per kind).
 *
 * RAISED AGAIN 2026-10-05, by exactly what was added: one to `server`, the hashes of the calendar's
 * and the mail's tool definitions pinned (`plugin-rest-adapters.test.ts`) — a definition that
 * changes is paused for review for everyone who has it connected, so changing one is a line here.
 *
 * RAISED 2026-10-05 with the wait measured as the person has it, by exactly what was added:
 * twenty-four to `server` — five in `run-meter.test.ts` (the first word is the first text with
 * something in it, counted from acceptance when nothing else is, and the clock is not read once
 * it is stamped; a call before the words is the first sign; a first move's step is the first
 * sign, and the model's first output is still counted from the Bot's start; a run that only acted
 * has a sign and no word; a decision left to the Bot is kept without a kind or a call), nine in
 * `turn-engine.integration.test.ts` (words only; what the engine does with a message before its
 * run starts is in the two new waits and in none of the numbers that were there before; a call
 * first; opened by a first move; a move's call has a time whatever came back, and none only when
 * it never left; a decision that left the step to the Bot, and a message nobody was asked about;
 * a turn that said nothing; a turn the person stopped; nothing the row measured holds a word of
 * the message), the nine of the new `turn-wait.integration.test.ts` (the row holds what the meter
 * read; an ending written after the fact keeps it; a first move is written from the two closed
 * lists or not at all; the section's cells; a turn that asked its person about an action before
 * its first word is not read as a slow Bot; the counts per kind; the median and the ninetieth
 * percentile by nearest rank, held to the database's own; a section from before reads as not
 * measured; no word reaches a column or the section) and one in `first-move.test.ts` (the turn is
 * told what was decided as well as the move) — and one to `root`, in `eval-from-failures.test.ts`
 * (the week's lines say the wait and the moves where the answer measured them, and nowhere else).
 *
 * RAISED 2026-10-05 with Seoul until the person says where, by exactly what was added: two to
 * `server`, both in `kma-weather-rest.test.ts` (the fallback is the shipped table's own row for
 * 서울특별시 and has a 중기예보 region; what the person said outranks where their device is, words the
 * table cannot read fall to the device, and alone are refused rather than answered for Seoul) —
 * seven to `app`: one in `weather-card.test.tsx` (Seoul that nobody chose says so on the line that
 * names it) and the six of the new `device-place.test.ts` (the decision table for asking a browser
 * where it is, once per device; marked before it is asked and saved with the words the account
 * holds; a browser that already said yes is read once too; refused, unknowable, held or in the
 * shell is left alone; storage that cannot keep the once; a dismissed prompt, a failed save and a
 * race) — and two to `root`, in `person-prompt.test.ts` (a place the person says is theirs is
 * saved unasked in every chat and one only asked about is not; the place line is held to a length).
 *
 * RAISED AGAIN 2026-10-05 after that change's review, by exactly what was added: nine to `server`
 * — four in `kma-weather-rest.test.ts` (what a call with no argument is for, in the tool's own
 * words; a saved name two places share falls to the device and is refused only without one; a
 * saved name the table has no row for does the same; a name the call gave is refused at once), two
 * in `person-context.test.ts` (coordinates with no words are given the table's name for where they
 * fall; the name reaches the place line a run is told), and one each in
 * `whereabouts-routes.test.ts` (coordinates with no `place` key do not touch the words),
 * `whereabouts.integration.test.ts` (the same, on the real row) and `built-in-skills.test.ts`
 * (아침 브리핑 looks at Seoul's weather for a person whose place is not known) — sixteen to `app`:
 * the seven of the new `device-place-gate.test.tsx` (on the mounted routes: the first-run screen
 * and the screen that asks again for the agreement ask nothing of the browser; once agreed, the
 * screen landed on asks once and sends coordinates alone; a said place is not asked about;
 * coordinates held spend the once; a browser that has not decided and one that said no), five more
 * in `device-place.test.ts` (who may be asked about; not before agreeing; a said place keeps the
 * once; coordinates held spend it; words said meanwhile are not this door's to send), two in
 * `settings-shop-location.test.tsx` (a cleared place does not come back at the next open;
 * clearing words alone spends nothing) and two in `greeting-head.test.tsx` (the neighbourhood
 * field stays under the person when their device answers; somebody the device already placed is
 * not asked) — and seven to `root`: six in `eval-weather.test.ts` (the answer is what follows the
 * last call, three ways; the fixture says nothing of a card to a routine and marks Seoul as
 * nobody's; the scenario pack loads) and one in `person-prompt.test.ts`, where four tests were
 * rewritten and five stand in their place (the device's coordinates with their name; what a region
 * answers is Seoul's; what is near the person is asked about; what is saved and what is not; the
 * line's exact lengths).
 *
 * RAISED AGAIN 2026-10-05 after that review's second reading, by exactly what was added: two to
 * `server`, both in `person-context.test.ts` (a cell with no row of its own is named by its
 * neighbour and the line says 부근 once; a run that holds the weather tool is not told what to do
 * without it) — and three to `root`: two in `person-prompt.test.ts` (the road for a deployment
 * without the weather tool is drawn only where the run may be without it; one 부근) and one in
 * `eval-report-hashes.test.ts` (the eval's prompt is told whether the scenario's Bot holds the
 * weather tool, as the server's is).
 *
 * LOWERED 2026-10-06, `app` from 2051 to 2043, by exactly the eight tests that held code only
 * tests called. The window-driven chat left the app on 2026-10-05 and a chain behind it that
 * nothing in the product reached: the window's own call to a connected service
 * (`callPluginTool`), its wait on a question (`waitForApproval`, with the hold and the release
 * under it) and the reader of a pause reply (`pauseFrom`). Gone with them: four in
 * `connect-outcome.test.ts` and two in `plugin-refusals.test.ts` (what the window made, for the
 * model, of a refused or failed `/api/plugins/call`), one in `approval-pause.test.ts` (a body
 * that is not a pause read as none) and one in `approval-decision.test.tsx` (the window's wait
 * giving up on a question nobody answered). Eight more that state a fact the product still has
 * were moved onto what the product calls, and are counted as before: six about a pause reply
 * read the server's record instead (`questionFromRecord`), and two about an answer given in
 * another window read it off the shell's watch.
 *
 * LOWERED AGAIN 2026-10-06, `app` from 2043 to 2037, by exactly the six tests of
 * `stopped-turn.test.ts`: the sentence for a turn that stopped (`stoppedReason`, and the table
 * under it) has had no caller in the product since 2026-09-25, and went. Three were about the
 * function itself — what ended a turn passed on in its own words, an Error read the same way,
 * nothing reported said plainly — and have nothing left to describe. Three were about its table —
 * every code a sentence, each with Korean, a rate limit told from an outage — and
 * `turn-failure.test.ts` holds those for the table the chat reads.
 *
 * RAISED 2026-10-06 after that change's review, by exactly what was added: thirteen to `server`,
 * the new `chat-plugin-call.test.ts`. The six tests of the window's plugin call that went above
 * stated facts the server owns now — what a Bot is told when a call to a connected service is
 * refused, fails or stops to ask — and nothing held them where the call is carried out
 * (`turns/chat-tools.ts`). There: a call carried out is the service's answer, and its own error is
 * marked as one; a refusal is the words for its fact, never the sentence the error carries; a
 * lapsed connection is the Korean for connecting again; the boundary's no, a server that is gone,
 * a definition held for review and a Bot that is not this person's are each their own words; a
 * refusal with no fact of ours says only that the tool is not allowed here; a vendor's failure is
 * a failure, never the vendor's text and not a refusal; and a call a person is asked about first
 * — answered yes and sent once more with the answer on it, answered no, nobody answering, a yes
 * the call still stops on, a refusal or a failure after the yes, a stop while the person decides,
 * and a yes and a stop together.
 *
 * RAISED 2026-10-06 with the connect card offered for an account nobody connected, by exactly what
 * was added: fifteen to `server` — nine in `chat-tools.test.ts` (a person's accounts are written on
 * the connect card a turn hands on, and nothing else of the window's card is touched; every lookup
 * then ends on what could be connected and how to raise the card; with no read of them the card is
 * the window's own; an account that is on and brought no tools is answered as that when its card is
 * raised, and when it lands during the wait only once its listing has had its time; tools that
 * arrive a poll after the switch are waited for; once connected at the card, the lookup that
 * follows does not offer that account again, and one that turned on with nothing to use is on with
 * no tools there; and none of that is what an account with tools or a site is), three in
 * `connections-overview.test.ts` (a turn's one-query reading of a person's accounts is the
 * screen's, needing reconnection included, and asks nothing else), one each in
 * `tool-exposure.test.ts` (목표 and what runs on the fleet's keys are nobody's connection),
 * `unattended-bridge.test.ts` (a routine is handed no card and told nothing of connecting) and
 * `conversation-epochs.test.ts` (the one sentence about connecting rides only while an account is
 * open, and its going is a reminder) — seven to `app`: four in `typed-answer.test.ts` (the connect
 * card words are typed under, apart from the choice), two in the new `connect-typed.test.tsx`
 * (typed under a waiting connect card, words tell it not now and go as the next message; where the
 * door does not take that, they wait as before) and one in `connection-card.test.tsx` (on with
 * nothing to use is still drawn 연결됨) — and sixty to `root`: thirty-seven in the new
 * `eval-connect.test.ts` (the judges of the connect scenarios judged — a claim that nothing is
 * there is not owning up — and their fixtures held to what a turn hands a Bot, a person with one
 * unrelated service connected and one who connects at the card, with tools and with none, among
 * them), eighteen in `tool-bridge.test.ts` (the one short line every lookup ends on, whatever the
 * words and whatever was found; the same bytes for the same accounts; a connected stranger's weak
 * hit does not silence it; an account whose tools the list now holds is not named; the card
 * callable from it; an account that is on with no tools; the one sentence under the names; the
 * accounts read back off the card) and five in agent-bot's `deferral.test.ts` (the lookup's answer
 * makes the next call the card, with no schema handed over; with no line given the card is answered
 * with its schema like any tool nobody described; a provider is never sent anybody's accounts).
 *
 * RAISED 2026-10-06 with the server's judges said once, by exactly what was added: eight to
 * `server`, the new `server-model-calls.test.ts`, written before the arrangement changed and
 * passing on both sides of it (with Jev off each of the four judges asks the server model alone,
 * inside its own bound, and files the tokens under its own name; a server model that takes no
 * effort is sent none; an address that could serve Jev does not turn it on; with Jev on each asks
 * Jev first, inside its own bound and under its own purpose, and nobody else when Jev answers; each
 * falls to the server model, inside the stand-in's bound, when Jev cannot answer; the decisions
 * model is named as the high-risk check's; the day's summary waits two minutes under its own name;
 * the dream is handed the server model, its effort and its own name).
 *
 * RAISED AGAIN 2026-10-06 with one way of asking for four doors, by exactly what was added: six to
 * `app`, the new `request-refusals.test.ts`, written while the goals, 소식, the routines and their
 * suggestions each had a copy of the request and passing unchanged once they shared one (every
 * request carries the session, and a content type only with a body; an answer is the body as it
 * came; a refusal is the door's own table's sentence with the status and the code beside it; a
 * code no table has is the general sentence, and still travels; a body with no code is the general
 * sentence and none; a suggestion is refused in a routine's words where the refusal is a
 * routine's, and no other door borrows a table).
 *
 * RAISED AGAIN 2026-10-06 after that change's review, by exactly what was added: two to `server`,
 * in `daily-budget-server-calls.test.ts`, written after the change and for a gap it did not make
 * (on a trial's spent day the mail's second look is not asked and says so with the fact a run ends
 * on; the high-risk check's judge is not asked and throws the word its miss is filed under; with
 * room left each is asked). No test asked either judge on a day that had a budget, so the guard in
 * front of each could have been deleted unnoticed.
 *
 * RAISED 2026-10-05 with the device's place in the installed app, and a place that follows its
 * device, by exactly what was added: twenty-seven to `app` — fourteen in `device-place.test.ts`,
 * which holds twenty-five where it held eleven (the table reads a mark of four kinds rather than a
 * yes or a no; the place follows a device that already said yes and no other; a place cleared on
 * this device is never read by itself; a mark from before "cleared" existed is read by what the
 * account holds; only the one ask shows anybody anything; allowed, held and moved is saved, and
 * the same writes nothing; a said place is not followed; a device that has not said yes is shown
 * nothing over a place held; a first answer that was lost is read at the next open; 지우기 or
 * words said while a following device was answering stand; and the shell's rows — its word on
 * being asked is one of the table's four answers, a shell that cannot read the device cannot be
 * asked and draws no control, its place is rounded again here and told whether it may show
 * anything, and every reason it has no place is said in the surface's words), eight in
 * `device-place-gate.test.tsx` (on the mounted routes: a browser that already said yes is read
 * again and the place moves; one that has not moved writes nothing; a said place is not followed;
 * a place cleared here is not read back even after another device gives one; an old mark stays
 * quiet over nothing and follows over coordinates; the installed app asks its shell once and
 * follows it after; the first-run screen and the screen that asks again for the agreement ask the
 * shell nothing either; a shell that cannot read the device is left alone — and the test over
 * coordinates held is now a browser that has NOT said yes, which is the only one still left
 * unread), four in `settings-shop-location.test.tsx` (a device that answers by itself while the
 * screen is open is what the screen shows and what a typed save sends; the device's button takes
 * a cleared place back; the installed app offers the device through its shell; a device that
 * said no there answers the press in words — and the test that the shell draws no button now
 * holds only the shells that cannot read the device) and one in `shell-bridge.test.ts` (the two
 * commands, and only their own words heard) — and two to `root`, both in `desktop-shell.test.ts`
 * (the bundle says why it reads the device's location and a signed build is entitled to; the
 * shell's words about the device's place are the page's own lists, rounded where the fix arrives
 * and never printed).
 *
 * RAISED AGAIN 2026-10-06 after that change's review, by exactly what was added: thirteen to
 * `app` — five more in `device-place.test.ts`, which holds thirty (a device read within the hour
 * is left alone; a question nobody answered spends nothing and is asked again; a no or a closed
 * prompt is the person's answer; a fix too vague to name the town is not kept for somebody who
 * pressed nothing; the one cell beside is not a move; a browser's fix carries how far off it is
 * and its refusals are the person's answers — and the two tests about a mark from before
 * "cleared" existed are gone with that mark, which no device ever held), six more in
 * `device-place-gate.test.tsx`, which holds twenty-one (the page looked at again follows, and
 * twice in an hour reads once; a page that is not being looked at asks nothing until it is; a
 * vague fix is not kept by itself; a device whose person decided before and that says yes is
 * read; in the installed app a question never answered spends nothing and the next look asks
 * again, a second look during an open ask starts nothing, and bringing the window back is a look
 * — where the old-mark test stood) and two more in `settings-shop-location.test.tsx`, which
 * holds thirteen (지우기 marks before its request goes and takes the mark off if the server does
 * not take the clear; a question nobody answers gives the button back and a second press asks
 * again — and the test that a press takes a cleared place back is now that SAVING what the
 * button gave does) — and one to `root`, in `desktop-shell.test.ts` (each thing the shell asks of
 * the system has a bound, and a bound that passes with nobody having decided is not a refusal).
 *
 * RAISED AGAIN 2026-10-06 after the owner pressed the button and could not tell that it had
 * worked, by exactly what was added: three to `server`, all in `whereabouts-routes.test.ts` (every
 * answer about a person's whereabouts names where the device's coordinates fall, from the table;
 * no name without coordinates, beside words, abroad or after a clear; a name in a request is not
 * kept) — and seven to `app`: four more in `settings-shop-location.test.tsx`, which holds
 * seventeen (with nothing kept the sentence says Seoul; one press of the device's button reads,
 * saves and names the place, with no number drawn; over words on the account that one press sends
 * the device and takes the words away; a press refused, unanswered or not taken by the server
 * changes nothing and says why; typed words take the device's place and its line goes; the place
 * is said to be around its name, once; words are the one source wherever coordinates are held
 * beside them — where the tests of the form that waited for a second press stood), one more in
 * `device-place.test.ts`, which holds thirty-one, and one more in `device-place-gate.test.tsx`,
 * which holds twenty-two (in a browser tab the once is spent when the question is put, so an
 * ignored prompt is not shown again at the next load; only the installed app's unanswered
 * question spends nothing), and one in `weather-card-transcript.test.tsx` (the card's note that
 * the place is nobody's own is the way to where a place is given).
 *
 * RAISED AGAIN 2026-10-06 with the reason a connection did not finish, by exactly what was added:
 * ten to `app`, all in the new `connect-outcome-screen.test.tsx`, mounted through the real route
 * and looked at once the address has lost what the redirect carried (each of the callback's five
 * reasons is told in its own words and they stay; a reason this build does not know, no reason at
 * all — which is all the installed app's link back carries — and a reason that is a number or is
 * given twice are each told as the general sentence, with the word drawn nowhere; a consent that
 * finished is told by the vendor's name, and that stays too).
 *
 * RAISED 2026-10-06 ahead of sixteen doors closing, `server` from 3627 to 3631, by exactly the four
 * written where a Bot's turn carries out what four tests of those doors held, in
 * `chat-tools.test.ts`, passing with the doors and without them: what a Bot was typing is not in
 * the row its refusal leaves; a file write is governed, and its refusal names the file and never
 * its contents; a card that reads data is drawn when its data may be read too; and it is refused,
 * with the missing grant named in the row, when it may not.
 *
 * LOWERED 2026-10-06, `server` from 3631 to 3616, by exactly the fifteen tests that held doors
 * nobody knocks on. The window that carried out a Bot's tool calls left the app on 2026-10-05,
 * and sixteen doors of the server that nothing else calls went after it: nine of the computer's
 * (`status`, `type`, `key`, `scroll`, `tabs/switch`, `upload`, and a Bot's three file tools by
 * request), the plugin call and a skill's view, a component's decision, a Bot's `hide` and
 * `unhide`, and an administrator's `status` and credential `rotate`. Gone with them: two in
 * `computer-routes.test.ts` (a file write stopped by a rule at its route; a file call decided
 * before any page was looked at), two in `computer-routes-codes.test.ts` (a missing file and a
 * path out of the folder, as the two file doors answered them), one in
 * `security-middleware.test.ts` (the larger body only the file-write door was allowed), one in
 * `drawn-on.test.ts` (the call door saying its answer is a line of the conversation), one in
 * `plugin-call-preview.integration.test.ts` (the call door's reply carrying the preview), three
 * in `skill-ownership.integration.test.ts` (a skill read, and refused, through the view door; and
 * the store's own refusal of somebody else's Bot, which the test beside it is now) and five in
 * `component-decision.test.ts` (what the decision door answered: a card that names no data, one
 * whose data may be read, one whose data may not, one of several withheld, and a list that is not
 * names). What the product still does is held where it does it: the four above; and
 * `computer-gateway.test.ts` holds a file call decided without a page; the person's file doors
 * and the turn hold the two file failures; the registry's record holds the preview;
 * `skill-view.integration.test.ts` holds a Bot reading a skill; the turn holds a card that reads
 * nothing. Every other test that pressed one of the sixteen to state such a fact was moved onto a
 * door that stays or onto the store, and is counted as before.
 *
 * RAISED AGAIN 2026-10-06 with a file over a megabyte, by exactly what was added: two to `server`.
 * One in `attachments.test.ts` sends a sheet through the upload door WHERE IT STANDS, behind the
 * server's own body limit — over a megabyte it lands, the largest the picker allows still fits, and
 * one past the door's ceiling is stopped before the service sees it. One in
 * `security-middleware.test.ts` holds the table's row: the door's own ceiling for a declared
 * length, the megabyte for its neighbours and for a body that does not say how long it is. Until
 * then each side was asked alone, and a person's every file over a megabyte was refused in the app.
 *
 * RAISED AGAIN 2026-10-06 with a sign-out that failed, by exactly what was added: two to `app`, in
 * the new `sign-out-failure.test.tsx`, mounted on the settings screen (refused by the server, and
 * the request never arriving, are each told in the app's own sentence, with no status and none of
 * the thrown English on the page, and nobody is sent to the door as though it had worked).
 *
 * RAISED 2026-10-06 ahead of the run door closing, `server` from 3618 to 3621, by exactly the three
 * of the new `turn-doors-scope.integration.test.ts`: on every door a window uses on a turn,
 * somebody else's conversation is not there and nothing of it is reached; a person's own is read
 * and holds nothing of anybody else's; a thread with no owner row is refused rather than read.
 * The facts were held for the runtime's thread routes, which are about to go; the doors a turn has
 * now had no test of whose conversation they open.
 *
 * LOWERED 2026-10-06, `server` from 3621 to 3586, by exactly the thirty-five tests that held the
 * AG-UI run door and what was reached only through it. `POST /api/copilotkit/agent/:id/run` was
 * how a window drove a chat turn; the server runs the turn (`turns/engine.ts`), the window-driven
 * path left the app on 2026-10-05, and nothing opened the door. It is closed, with the runtime's
 * other routes, and the runner behind it is reduced to what boot still needs of it. Gone with it:
 * the six of `chat-stop.integration.test.ts` (a run on the wire stopped; a step handed to a
 * browser listed, stopped and carried on; a run `waiting` on its window and each way that ended),
 * the six of `thread-scope.integration.test.ts` (the runtime's thread list and the priming read,
 * per person — the two facts of it a turn's doors still owe are the three above), the six of
 * `thread-priming.test.ts` (the middleware in front of the runtime's thread routes, and a
 * message's reasoning put back on the route that dropped it), the four of
 * `runner-replay.test.ts` (a window joining a thread shown its past runs as closed), the six of
 * `run-outcome.test.ts` (a run's ending read off the events the runner teed) and the five of
 * `snapshot-merge.test.ts` (the runner's in-memory copy merged with the store's); one in
 * `thread-secret-absence.integration.test.ts` (a restart told the runner's live copy from the row
 * — a turn keeps no copy, and the four beside it now write as a turn writes and read as a turn and
 * a window read) and one in `daily-budget.integration.test.ts` (one usage row for a turn driven
 * through the runner, the path that could have counted twice; `daily-budget-seam.test.ts` holds
 * one row for a turn, a routine and a toolless routine). What a stop, an ending and a restart are
 * for a turn the server owns is held where it runs: `turn-engine.integration.test.ts`,
 * `stop-all.test.ts`, `restart-recovery.integration.test.ts`.
 *
 * RAISED 2026-10-06 with that change, `server` from 3586 to 3589, by exactly the three written on
 * the runtime's real handler, in `copilot.test.ts`: `info` answers with the roster and runs
 * nobody; every other route the runtime's own router knows — nineteen spellings, a doubled slash
 * among them — is a path nothing is mounted on and reaches no Bot; a path the runtime does not
 * know is still its own answer.
 *
 * RAISED 2026-10-06 after that change's review, `server` from 3589 to 3590, by exactly the one of
 * the new `stop-all-turn.integration.test.ts`: one press of 모두 멈추기 stops a turn in flight on a
 * real engine, and the turn ends as one the person stopped. The paragraph above names
 * `stop-all.test.ts` for a turn's stop, and that file presses doubles; `chat-stop` had held the
 * press reaching real work for the window's runner, and nothing held it for a turn — with the
 * engine's listing of itself taken out, the one file that ran a real engine and the one that
 * pressed the door both still passed.
 *
 * RAISED 2026-10-06 with it, `server` from 3590 to 3591, by exactly one more in
 * `turn-doors-scope.integration.test.ts`, for the seventh of a turn's doors: 건너뛰기 names a Bot
 * and no conversation, so it is held by whose Bot it is — somebody else's, and one that is not
 * there, answer alike and skip nothing; the owner's own is skipped. The three raised first hold
 * the six doors that name a conversation, and the file's header said "every door".
 *
 * RAISED AGAIN 2026-10-06 with the limits of doors that exist, by exactly one to `server`, in
 * `security-middleware.test.ts`. The test of the 32 MB a window's run was allowed became two: the
 * property it held — somebody signed in is read whole, an anonymous caller is refused without a
 * byte read — is held for the upload door, which is the larger body there is now; and the closed
 * runtime's doors are held to the megabyte like any other. The rate tests knock where a message
 * goes, and hold that a knock on the closed run door spends none of the count.
 *
 * RAISED AGAIN 2026-10-06 with a definition that ships with the build, `server` by exactly eight:
 * five written in `plugin-consent.integration.test.ts` against a real database — a shipped
 * adapter's changed definition and its new tool are taken as they arrive, each with one trail row
 * of its own kind that names the deployment; one left waiting by an earlier build is taken at the
 * next refresh; the pass at boot brings every shipped service up to this build without asking a
 * vendor's server anything; that pass leaves alone a service the deployment cannot serve right now;
 * and a grant left pointing at nothing is written when its tool goes and not at every refresh
 * after — three in the new `plugin-transport-shipped.test.ts`, the catalogue written out entry by
 * entry as ours or a vendor's, a server added by address, and a transport that declares nothing —
 * one in `boot-background.test.ts`, that the pass waits for the keys' reconciliation and never
 * runs beside it — and one gone from `public-data-rest.test.ts`, which held the same acceptance
 * where it used to be written, in the deployment keys' own reconciliation.
 *
 * LOWERED 2026-10-06, `server` from 3600 to 3553, by exactly the forty-seven tests that held a door
 * no deployment ever opened: `GET /api/admin/metrics/insights`, the fleet's read of a VM's counts
 * over HTTPS, mounted only where `LAF_FLEET_METRICS_TOKEN` was set — and the provisioner never
 * wrote that line, so it was mounted nowhere; the fleet reads the same counts over SSH with its own
 * statements. The door went with what only it used (`insights/routes.ts`, `insights/read.ts`, nine
 * of the report's ten section shapes, the token in the configuration). Gone with them: the
 * thirty-one of `insights-routes.test.ts` (ten for the bearer — the token in the Bearer scheme,
 * and nine headers that are not it; ten for `?days=` — the default and the bounds, and nine
 * values refused rather than clamped; three for the door — the report for the window asked and
 * `no-store`, 401 with a code before anything is read, 400 with the bounds; three for the mount —
 * 404 without a token, 404 without a reader, the bearer and not an administrator's session; five
 * for the token in the configuration — unset, carried as written, and three shapes that refused to
 * start), the fifteen of `insights-read.integration.test.ts` (thirteen for the ten statements on
 * the real schema — every section over its window, each section's counts, the prompt cache by
 * provider, none of the content planted beside a counted row coming back, a wider window — and two
 * for how a section was read: one failing read as null beside the others, in a transaction that
 * cannot write) and one in `authorization-matrix.integration.test.ts` (the door answering 401 to
 * every session, an administrator's included — the matrix enumerates the routes the app mounts,
 * and this one is no longer among them). What stays is held where it is: the turns statement and
 * its reading, kept for `eval:from-failures` and for the fleet to copy, by
 * `turns.integration.test.ts` and `turn-wait.integration.test.ts` — both plant a sentence beside
 * the measured columns and search the section for it — and the shape of a catalogue key by
 * `help-opened-route.test.ts`, on the one route that still asks it.
 *
 * RAISED 2026-10-06 with the commit a page carries, `app` from 2109 to 2111 and `root` from 718 to
 * 719, by exactly the three written for it. The bundle was the one part of a deployment that could
 * not say which build it was: the workflow passed `REVISION` to the web image and its Dockerfile
 * never declared it. Two in the new `revision-tag.test.ts` (a build told its commit writes one
 * tag into the document's head; one told nothing, or something that is no commit, writes none)
 * and one for `root` in `dockerfiles.test.ts` (the web image sets the commit before the bundle is
 * built, in the stage that builds, and the build's config writes it into the page).
 *
 * RAISED 2026-10-06 with the notice of a newer version, `app` from 2111 to 2143, by exactly the
 * thirty-two written for it. Nothing had compared the page's build with the server's, so a window
 * left open across an upgrade kept the old bundle — in the installed app, for days. Twenty-two in
 * the new `build-watch.test.ts`: the decision as a table (the same build, another build, a server
 * that has not said, a page with no commit, mid-turn, a newer shell in hand, and a build already
 * reloaded for), the commit read back from the page's own document, every moment the page looks
 * and does not (not as it begins; in sight or focused; never while hidden; once in half a
 * minute; every few minutes; when the connection returns; a failed read as silence; a server
 * gone back; a page with no commit never asking; nothing once stopped), the press (the one
 * reload there is, with what was typed kept; a reload that did not bring the build not offered
 * twice) and the shell's half (the held update read as the watch begins and when the shell says
 * so; nothing in a browser tab). Eight in the new `update-notice.test.tsx`, the control mounted
 * and pressed: its words in Korean; nothing drawn and nothing asked on an ordinary day; one row
 * and a press that reloads with the draft kept; unpressable mid-turn and saying why, then
 * pressable; a newer shell said by the same row and restarted through the shell; a refused
 * restart said; a restart withheld mid-turn; the icon alone in the rail. And one each in
 * `sidebar-rail.test.tsx` and `phone-nav.test.tsx`, for where it stands: a row over the foot's
 * one button, and a row over the phone's tabs.
 *
 * RAISED AGAIN 2026-10-06 from the independent read of that notice, `app` from 2143 to 2146, by
 * exactly three: in `build-watch.test.ts`, a reload that did not help is offered again when the
 * connection returns (the fleet replaces the server first and the front door last, and a press in
 * between used to silence the control for the whole release); in `update-notice.test.tsx`, a Bot
 * waiting on the person does not hold the control; and the new `build-watch-starts.test.tsx`,
 * which mounts the real route tree and holds the one line that starts the watch at all.
 *
 * RAISED 2026-10-06 with a tool nobody consented to staying one, `server` from 3553 to 3554, by
 * exactly the one written in `plugin-consent.integration.test.ts`: a vendor's tool that appeared
 * after registration and changes again before anybody reviewed it still waits as "appeared after
 * registration" — the refresh had rewritten it to "definition changed", the reason that means its
 * name was consented to.
 *
 * RAISED 2026-10-06 with a paused tool that says nothing of its own, `server` from 3554 to 3564
 * and `root` from 719 to 720, by exactly the eleven written for it. A vendor's tool waiting for
 * review could not be called, and its changed description and schema were still handed to the
 * model, which also found tools by those words (the review of #110). Ten in the new
 * `plugin-paused-text.integration.test.ts`, against a real database with a sentinel planted in a
 * changed description, another in a changed schema's field and a third in a new tool's name:
 * registration offering the vendor's own words; the change and the new tool leaving none of the
 * three in anything a model is given — a turn with no window, with a window that read its list
 * now and with one that read it before the fix, a routine, and the window's route, each put
 * through the Bot service's own schema, context names, lookups and calls by name; the changed
 * tool still offered under its name with this deployment's description and an empty schema; a
 * lookup for the vendor's words not finding it and one for its name finding it described as
 * paused, with the new tool's exact name answered as a name that does not exist; the call
 * refused with its row and its sentence, and an unoffered name answered as no tool; a routine's
 * Bot looking for the tool and calling it over the real wire, with every request the provider
 * was sent searched whole; a tool nobody consented to left out when it changes again; a paused
 * row with an unknown reason not offered; the bookkeeping still seeing every grant, so a boot
 * grants nothing again; and after approval the vendor's words offered again. One for `root` in
 * `owner-words-prompt.test.ts`: the description that stands in, pinned whole, naming nobody and
 * carrying no slot for a vendor's text.
 *
 * RAISED 2026-10-06 with a waiting tool that is said to be waiting, `server` from 3564 to 3571 and
 * `root` from 720 to 725, by exactly the twelve written for it. The change above left a tool that
 * appeared after registration out of every list, and so out of everything the Bot could say: a
 * person who filled 카카오's toolbox and asked for a tool in it was told the connection had brought
 * none (the review of that change). The listing counts what it does not list, the run carries the
 * count beside its tools, and a lookup ends on it. Seven for `server`. Three in
 * `plugin-paused-text.integration.test.ts`, on a real database: a toolbox filled after its
 * account was connected is counted by server on the store's read, the window's route, a turn's
 * toolkit, a routine's and through each of the three hands a routine's toolkit passes, with no
 * name or word of the vendor's in any of it; a routine's Bot over the real wire is told how many
 * wait in each lookup's answer while every request's tools are the same bytes as a control run
 * told nothing, then one tool is reviewed and one still counted, then none; and a tool looked up
 * while it waited is called — the call reaches the store and is refused with its row — then
 * reviewed, and the next call is handed the real schema before one goes through. Two in
 * `chat-tools.test.ts` (the turn carries the count and its lookup says it in place of "brought
 * none"; a listing that fails keeps the last count with the last list), one in
 * `turn-engine.integration.test.ts` (the turn forwards it on every request, beside the device),
 * one in `copilot.test.ts` (it reaches the endpoint, and the prompt and the tools are the same
 * bytes with it or without). Five for `root`. Four in `tool-bridge.test.ts`: every answer ending
 * on the count, found or not, and the same bytes as before where nothing waits; an account whose
 * tools all wait not said to have brought none; what crossed the wire read in a closed shape; and
 * a stand-in's line counting as the schema only while the tool still stands in. One in
 * `owner-words-prompt.test.ts`: the line's words, pinned whole around their one slot.
 *
 * RAISED AGAIN 2026-10-06 from the independent read of that change and a press of it on the real
 * stack, `server` from 3571 to 3575 and `root` from 725 to 728, by exactly the seven added. The
 * press found that the line above was never read: it stood at the end of a lookup's answer, the
 * paragraph naming what is behind the bridge tells a Bot not to look for anything it does not
 * name, and a Bot asked for a tool in a toolbox whose tools all waited made no lookup at all. So
 * the line stands in that paragraph now — the context layer, which a Bot reads without doing
 * anything — and a lookup says nothing of it. Several of the tests in the paragraph above hold
 * that instead of what they held, in place and under new names: in `tool-bridge.test.ts` the
 * paragraph ending on the count (alone where nothing is behind the bridge) and a lookup's answer
 * being the bytes it is with nothing waiting; in `chat-tools.test.ts` and
 * `plugin-paused-text.integration.test.ts` the paragraph drawn for each toolkit, and the run over
 * the wire now made through the prompt middleware, where the provider's system message is a
 * control's with that one line and its tools and static layer are the control's bytes; in
 * `copilot.test.ts` the same for a chat and a routine, and a forged count drawn as nothing. Four
 * new for `server`: in `conversation-epochs.test.ts`, a count that appears or changes is a
 * reminder on the person's next message with the epoch, the tools and the frozen layer as they
 * were, and a conversation or a routine that begins while tools wait reads the line in its layer;
 * in `plugin-paused-text.integration.test.ts`, three messages and two definitions of one tool — a
 * schema handed over before the vendor changed it is not the schema it has after a review, so the
 * call made while it waits is refused with its row and the next is handed the reviewed schema
 * first; in `chat-tools.test.ts`, a window still declaring the stand-in for a tool that has been
 * reviewed is offered the server's reviewed definition; in `plugin-consent.integration.test.ts`,
 * the trail's note for a vendor's withdrawn tool says it waits for review if it comes back, and it
 * does. Three for `root`: two in `tool-bridge.test.ts` (the lookup's silence, split from the
 * paragraph's test; the older definition's line not counting, with the connect card's line still
 * counting whatever accounts are written on it) and one in agent-bot's `deferral.test.ts` (through
 * the service itself, the forwarded count keeps a lookup from saying an account whose tools wait
 * "brought none", with the provider sent the same tools either way).
 *
 * AND ONCE MORE THE SAME DAY, `root` from 728 to 729, from the second read: one in
 * `tool-bridge.test.ts` — a service an administrator named `constructor` is called that in the
 * line and in the two other places a key becomes a name. The table of names was read as
 * `TABLE[key]`, which every object answers for that one key with a function, and the function's
 * text stood in the paragraph a Bot reads.
 *
 * RAISED 2026-10-06 with the server's own two file calls on the Bot's computer — a file taken
 * whole (`/files/bytes`) and bytes put where nothing is (`/files/put`) — by exactly what was added:
 * `agent-computer` from 495 to 526, `server` from 3575 to 3582, `root` from 729 to 733.
 * Thirty-one to `agent-computer`: eighteen in `workspace.test.ts` (a whole read under a bound of
 * its own, the largest file a person may attach by default, and refused as every reading is; a put
 * that lands bytes as given in folders made on the way, a body of nothing, never over a file, a
 * folder or a link, refused unread by what was declared and one piece past the bound otherwise,
 * its default bound, six escapes and a linked folder, a file where a folder has to be, and a body
 * that breaks off leaving nothing) and thirteen in `file-handoff.test.ts` (the four refusals every
 * file route answers, now for `/files/bytes` too; three for a whole file on the wire; six for a
 * put on the wire — the path in its header, a taken path, both ways of being too large, a header
 * that names nothing, a path out, and the door). Seven to `server`: six in
 * `computer-client.test.ts` (each call as the computer's route is, the Bot named; the whole
 * read's bound and a flood let go of; a refusal on either as the container's own fact; a put over
 * the bound never sent; a whole file that breaks off) and the one `computer-routes-codes.test.ts`
 * writes for every answer the container can send, for the new `laf:file_exists`. Four to `root`,
 * in `tests/file-handoff.test.ts`: the server's real client against the container's real routes
 * over a real socket — which is where a put first failed, on a request body the pinned Bun would
 * not iterate once it had come off a socket, while every test that built its own request passed.
 *
 * RAISED AGAIN 2026-10-06 after that change's independent read, by exactly the four written before
 * their fixes: `agent-computer` from 526 to 529 (a NUL refused as a path whichever way a file is
 * reached, and a name longer than a name may be, in `workspace.test.ts`; an unforeseen failure
 * logged by its kind and never by the name it happened to, in `file-handoff.test.ts`) and `root`
 * from 733 to 734 (the sentence for a file that is too large true of a read as well as a write,
 * with the read answering that code through the server's client, in `tests/file-handoff.test.ts`).
 *
 * AND TWO MORE THAT EVENING, `root` from 734 to 736, in the same file: a file's type read by the
 * table's own names (`report.constructor` was served as content type "function Object() { [native
 * code] }" and called a picture by its name), and a code with no sentence said as itself whatever
 * it is called.
 *
 * RAISED 2026-10-07, `app` from 2146 to 2151 and `root` from 736 to 737: the same hole in the
 * app, where the second read of the byte routes found it live — a connected service's answer can
 * carry any `code`, and four readers indexed a table of sentences with it bare. The first sweep
 * took the lookups whose key was called `code`; a reader who had not written it found the same
 * answer under seven other names and in `t()` itself, so the rule is by type: a table declared
 * with `string` keys is read through `own()` — 63 reads in 39 files with the few the walk cannot
 * see. Five for `app`, in `own-keys.test.ts`: what `own()` answers; every reader saying an
 * inherited name as it says a word it has never heard of; `t()` finding Korean only where the
 * dictionary holds it; a walk of `src/` that finds every string-keyed table by its declaration
 * and fails on a bare read; and a card's badge drawn plain for a tone no table holds (a model's
 * argument, typed and unchecked). One for `root`, in `tool-bridge.test.ts`: a search whose words
 * include `constructor` is a search, where it was a throw.
 *
 * RAISED AGAIN 2026-10-07 with a hosted deployment taking no endpoint of a person's own for a
 * Bot, by exactly what was added: `server` from 3582 to 3611 and `app` from 2151 to 2156.
 * Twenty-nine to `server`. Seventeen in `agent-routes.test.ts`: the form refused by a code of its
 * own with an address, a key for one, or both — eight shapes of it — and read as it always was
 * with neither, or with an empty one — four; a developer's stack taking both, checked as they
 * were; create and the edit form's save refused before the store is asked; the ordinary save
 * going through; the connection test dialling nothing; and the app told no address and no key of
 * a Bot there. Eight in `runtime-agents.integration.test.ts`: a Bot whose row holds another
 * address dialled at the deployment's own agent with no key of the person's, the vault never
 * asked and the row left as it was; the same Bot dialled where its row says, with its key, on a
 * developer's stack; a Bot nobody pointed anywhere dialled at home either way; three shapes of a
 * row that names nothing a run could dial — nothing, something that is no address, an address
 * nothing dials — running at home on a hosted deployment and skipped on a developer's stack as
 * they always were; a rename leaving the row's configuration as it was; and the Bots held
 * elsewhere found by id, the live ones only. Two in the new `boot-line.test.ts`: the count said
 * at boot, zero included, and nothing said where no Bot is brought anywhere. One in
 * `guards.test.ts`: the fact the app reads, under both settings. And one in
 * `log-hygiene.integration.test.ts`, through the real `main.ts`: a Bot whose row was pointed at
 * a name that resolves nowhere is answered by this deployment's own Bot service, its row
 * unchanged and the address in neither process's log — the one argument that every test of the
 * loader passes without. Five to `app`, in the new `admin-bot-endpoints.test.tsx`: the page
 * listed by none of the rail, the row that stands in for it and the index where the server takes
 * no endpoint, and where it does not say; the page itself a title and one sentence, with no
 * field and no button; that sentence the refusal's own, said in Korean; and a developer's stack
 * as it was. Nothing was deleted: the tests that took an endpoint on the default setting take it
 * on the developer's now, in place (`agent-endpoint.test.ts`, two in `agent-routes.test.ts`),
 * and `POST /api/agents/test-connection` left the matrix's list of what a colleague reaches,
 * since on the matrix's deployment it answers everybody 400 with a code.
 *
 * AND AGAIN THE SAME DAY from the independent read of that change, by exactly the eleven added:
 * `server` from 3611 to 3620 and `app` from 2156 to 2158. Nine to `server`. Five in the new
 * `private-hosts-refusal.test.ts`: the switch that marks a stack as a developer's was only read,
 * and production refuses to start with it now, by name — with a computer configured, and with
 * none, where the line opens nothing yet; everywhere that is not production it is allowed; only
 * the word turns it on, so only the word is refused; and the refusal's sentence is whole in the
 * one line a crash writes — started as production through the real entry point, the first
 * wording was cut off at 200 characters, before what to do about it. Two more in
 * `boot-line.test.ts`, which holds four things where it held two: the switch itself said on
 * every boot by the name the app is told; the count on a hosted boot, zero included; a count
 * that could not be read said as `null` — there, and not a number; and no count at all on a
 * developer's stack whatever it is handed, so that a missing field means one thing. One in
 * `runtime-agents.integration.test.ts`: a loader is not built without saying where Bots run —
 * the compiler refuses the call (a `@ts-expect-error`, which an argument made optional again
 * turns into an unused directive) and so does the loader, for anything that is neither answer.
 * And one in `log-hygiene.integration.test.ts`: a second real server, started with the opt-in
 * beside the first, says `botEndpoints: true` on its boot line and to the app, with no count,
 * while the first still says the other thing — the developer's setting through the real
 * `main.ts`. The loader's other tests, and the three files that build one for memory and the
 * shop's profile, say which setting they mean in place. Two to `app`, in
 * `admin-bot-endpoints.test.tsx`: on the credentials page a key stored for a Bot's own server
 * says "not used here" where nothing reads it, with its Revoke button still to press and a
 * retired key and a model's key as they were; and "in use" on a developer's stack.
 *
 * `roots` is a partition of the repository rather than a filter: a test file under none of them
 * fails the run instead of going uncounted, which is the same silence this whole script exists to
 * break.
 */
const GROUPS = [
  { name: "server", floor: 3620, roots: ["server"] },
  { name: "app", floor: 2158, roots: ["app"] },
  { name: "agent-computer", floor: 529, roots: ["agent-computer"] },
  { name: "root", floor: 737, roots: ["tests", "agent-bot"] },
] as const;

/** The file names Bun itself treats as tests, so discovery here and discovery there agree. */
const TEST_FILE_GLOBS = [
  "**/*.{test,spec}.{js,jsx,ts,tsx}",
  "**/*_{test,spec}.{js,jsx,ts,tsx}",
];

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Never print a connection string with the password still in it; CI logs are readable. */
function redacted(url: URL): string {
  const copy = new URL(url);
  copy.password = "";
  return copy.toString();
}

// --- which files are tests, and whether they are all still here --------------------------------

/** Every test file in the tree, by the same names bun would find them under. */
async function discoverTestFiles(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const pattern of TEST_FILE_GLOBS) {
    for await (const path of new Glob(pattern).scan({
      cwd: projectRoot,
      onlyFiles: true,
    })) {
      // Agent worktrees under .claude/ are whole checkouts; their tests are counted in their own runs.
      const parts = path.split("/");
      if (!parts.includes("node_modules") && !parts.includes(".claude"))
        found.add(path);
    }
  }
  return found;
}

const discovered = await discoverTestFiles();

/** The manifest, written the way `biome format` would leave it, so the gate's own write is clean. */
function writeManifest(paths: Iterable<string>): void {
  writeFileSync(
    MANIFEST,
    `${JSON.stringify([...new Set(paths)].sort(), null, 2)}\n`,
  );
}

if (process.argv.includes("--update-manifest")) {
  writeManifest(discovered);
  console.error(
    `${discovered.size} test files written to scripts/test-manifest.json, from the tree.\n` +
      "Any file that was listed and is not in the tree has been forgotten: read the diff before committing it.",
  );
  process.exit(0);
}

/*
 * Before the database is touched: a file that has gone missing is known from the tree alone, and a
 * run that will refuse anyway has no business creating databases first.
 */
let listed: string[];
try {
  listed = JSON.parse(readFileSync(MANIFEST, "utf8")) as string[];
} catch (error) {
  fail(
    `scripts/test-manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}\n\n` +
      "Write it with `bun scripts/test-ci.ts --update-manifest`.",
  );
}
const listedSet = new Set(listed);
const vanished = listed.filter((path) => !discovered.has(path)).sort();
const unlisted = [...discovered].filter((path) => !listedSet.has(path)).sort();
if (vanished.length > 0) {
  fail(
    `${vanished.length} test file(s) are in scripts/test-manifest.json and not in the tree:\n` +
      `${vanished.map((path) => `  ${path}`).join("\n")}\n\n` +
      "A test file that disappears takes its tests with it, and the count floors cannot see one file\n" +
      "go. If it was deleted or renamed on purpose, remove its line from scripts/test-manifest.json in\n" +
      "the same commit. If it was not, it is missing: a rebase or a move dropped it.",
  );
}
if (unlisted.length > 0) {
  const listing = unlisted.map((path) => `  ${path}`).join("\n");
  if (process.env.CI) {
    fail(
      `${unlisted.length} test file(s) are in the tree and not in scripts/test-manifest.json:\n${listing}\n\n` +
        "A local run of the gate adds them; commit the manifest with the tests. A file the manifest\n" +
        "does not list is a file it cannot protect.",
    );
  }
  writeManifest([...listed, ...unlisted]);
  console.error(
    `\nAdded to scripts/test-manifest.json — commit it with the tests:\n${listing}\n`,
  );
}

// --- where the tests are allowed to write ------------------------------------------------------

const configuredDatabaseUrl = process.env.DATABASE_URL;
if (!configuredDatabaseUrl) {
  fail(
    "DATABASE_URL is not set. It is read for the server and the credentials only — the tests run in\n" +
      "a database derived from it, never in it. Set it to the database you develop against.",
  );
}
if (!URL.canParse(configuredDatabaseUrl)) {
  fail(
    "DATABASE_URL is not a URL, so no test database can be derived from it.",
  );
}

const sourceUrl = new URL(configuredDatabaseUrl);
const sourceDatabase = decodeURIComponent(sourceUrl.pathname.slice(1));
if (!sourceDatabase) {
  fail(
    "DATABASE_URL names no database, so no test database can be derived from it.",
  );
}

/*
 * The suffix reaches `CREATE DATABASE` as an identifier, so it is checked rather than trusted, and
 * held to the characters that need no thought about quoting.
 */
const suffix = process.env.LAF_TEST_DB_SUFFIX?.trim();
if (suffix && !/^[A-Za-z0-9_]+$/.test(suffix)) {
  fail(
    `LAF_TEST_DB_SUFFIX is "${suffix}". It becomes part of a database name, so it may only contain\n` +
      "letters, digits and underscores.",
  );
}

const testDatabase = `${sourceDatabase}_test${suffix ? `_${suffix}` : ""}`;
/*
 * PostgreSQL truncates an identifier at 63 bytes without complaining. Two worktrees whose suffixes
 * differ only past that point would silently share one database, which is the one thing the suffix
 * exists to prevent, so the truncation is refused instead of absorbed.
 */
if (new TextEncoder().encode(testDatabase).length > 63) {
  fail(
    `The test database would be named "${testDatabase}", which PostgreSQL would truncate to 63\n` +
      "bytes. Shorten LAF_TEST_DB_SUFFIX.",
  );
}

const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${encodeURIComponent(testDatabase)}`;

/** `postgres` is the database that is always there, and the only one another can be made from. */
const maintenanceUrl = new URL(sourceUrl);
maintenanceUrl.pathname = "/postgres";

const admin = new SQL(maintenanceUrl.toString(), { max: 1 });
try {
  const existing =
    await admin`select 1 from pg_database where datname = ${testDatabase}`;
  if (existing.length === 0) {
    // Quoted so a name with a hyphen or a capital works, and the quotes doubled because the name
    // comes out of DATABASE_URL rather than out of this file.
    await admin.unsafe(
      `create database "${testDatabase.replaceAll('"', '""')}"`,
    );
    console.error(`Created ${testDatabase}.`);
  }
  await admin.close();
} catch (error) {
  fail(
    `Could not reach ${redacted(maintenanceUrl)} to prepare the test database.\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      "The gate needs a running PostgreSQL: `docker compose up -d postgres`.",
  );
}

/*
 * The same command CI runs, in the same directory, for the same reason it runs that one: the
 * `db:migrate` script loads ../.env, which does not exist in CI, and drizzle.config.ts already
 * reads DATABASE_URL.
 */
const migration = Bun.spawn(
  ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
  {
    cwd: resolve(projectRoot, "server"),
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await migration.exited) !== 0) {
  fail(`Migrating ${testDatabase} failed, so no tests were run.`);
}

// --- which tests belong under which floor ------------------------------------------------------

const owns = (roots: readonly string[], path: string) =>
  roots.some((root) => path.startsWith(`${root}/`));

const unclaimed = [...discovered]
  .filter((path) => !GROUPS.some((group) => owns(group.roots, path)))
  .sort();
if (unclaimed.length > 0) {
  fail(
    `${unclaimed.length} test file(s) belong to no group, so no floor is watching them:\n` +
      `${unclaimed.map((path) => `  ${path}`).join("\n")}\n\n` +
      "Add the directory to a group's `roots` in scripts/test-ci.ts.",
  );
}

// --- the runs ----------------------------------------------------------------------------------

type Outcome = {
  name: string;
  floor: number;
  count: number | null;
  status: number;
  /** The files in this group that the JUnit report says ran no test at all. */
  emptyFiles: string[];
  /** How many tests the JUnit report puts against this group's files. */
  accounted: number;
};

const outcomes: Outcome[] = [];

/** Where bun writes each group's JUnit report; read once, then left for the OS to sweep. */
const reports = mkdtempSync(join(tmpdir(), "laf-test-ci-"));

/** The files under any of `roots`, sorted. Out here rather than in the loop below: see the loop. */
function filesOwnedBy(
  roots: readonly string[],
  paths: Iterable<string>,
): string[] {
  const owned: string[] = [];
  for (const path of paths) if (owns(roots, path)) owned.push(path);
  return owned.sort();
}

/** A path as the tree names it, made absolute. Out here rather than in the loop below: see the loop. */
const absolute = (path: string) => resolve(projectRoot, path);

/*
 * One group at a time. The groups share the one test database, and the deletions described at the
 * top of this file are exactly as destructive between two parallel groups as they were against a
 * developer's own database.
 *
 * Absolute paths, because Bun matches a positional argument as a substring of the file path and
 * `tests/workspace.test.ts` is a substring of `agent-computer/tests/workspace.test.ts`. Anchoring
 * at the repository root is what makes a group's file list mean only that group's files.
 */
for (const group of GROUPS) {
  /*
   * NOTHING IN THIS LOOP MAKES A FUNCTION. The group's files and the verdict on its report come from
   * functions defined outside it, handed what they need as arguments.
   *
   * MEASURED 2026-09-14. Under Bun 1.3.11, once a group's run has held this loop at an `await` for
   * about half a minute, a closure made in a later pass can read an EARLIER pass's variables while
   * the loop body beside it reads its own. The gate said "agent-computer: 18 test file(s) ran no
   * test at all", and the same of root's 28, while bun ran 222 and 304 tests and both reports were
   * whole: `owned.filter((path) => (perFile.get(path) ?? 0) === 0)` was looking their files up in
   * the FIRST pass's `perFile`, server's. Shown with each run replaced by a sleep and a copy of a
   * saved report, misread in: 0 of 10 runs waiting 20 s or less, 21 of 23 waiting 30 s or more;
   * 0 of 4 with the JIT off, 0 of 3 with only the baseline JIT; 0 of 7 once server's report also
   * listed those files. The real groups take 26, 33 and 50 s, so it came and went between runs of
   * one tree. The same waits against this loop as it is now: 12 of 12 read right. The note that
   * stood here from 2026-09-13 — a filter taken again after the run made `root` own app's 92 files
   * — was this bug reading `group`; taking that list before the run moved it, and did not end it.
   */
  const owned = filesOwnedBy(group.roots, discovered);
  const files = owned.map(absolute);

  console.error(`\n=== ${group.name} (${files.length} files) ===`);

  // `bun run test` rather than `bun test`, so the pretest hook fires and the generated application
  // config exists before route imports need it. `--silent` keeps a file list this long out of the
  // log without hiding anything bun itself reports. The JUnit report is written beside the console
  // output, not instead of it: bun keeps printing its summary, which is what the floors read.
  const report = join(reports, `${group.name}.xml`);
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--silent",
      "test",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...files,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      stdout: "inherit",
      stderr: "pipe",
    },
  );

  // Bun writes its summary to stderr, so it is captured and echoed rather than inherited.
  const stderr = await new Response(proc.stderr).text();
  process.stderr.write(stderr);

  const status = await proc.exited;
  const ran = stderr.match(/Ran (\d+) tests? across/);

  let reportText: string | null = null;
  try {
    reportText = readFileSync(report, "utf8");
  } catch {
    // No report at all is the same verdict for every file in the group, made below.
  }
  const verdict = fileVerdict(owned, reportText);

  outcomes.push({
    name: group.name,
    floor: group.floor,
    count: ran ? Number.parseInt(ran[1] as string, 10) : null,
    status,
    emptyFiles: verdict.ranNothing,
    accounted: verdict.accounted,
  });
}

// --- the verdict -------------------------------------------------------------------------------

const problems: string[] = [];
for (const outcome of outcomes) {
  if (outcome.status !== 0) {
    problems.push(`${outcome.name}: tests failed (exit ${outcome.status}).`);
    continue;
  }
  if (outcome.count === null) {
    problems.push(
      `${outcome.name}: could not read how many tests ran from bun's output. Refusing to report a\n` +
        "  pass on a run that cannot be counted.",
    );
    continue;
  }
  if (outcome.count < outcome.floor) {
    problems.push(
      `${outcome.name}: ${outcome.count} tests ran, and at least ${outcome.floor} were expected.`,
    );
  }
  /*
   * The report is held to bun's own count before a single file is judged by it. A report read
   * short, or keyed by paths other than the ones asked about, names every file in the group as
   * having run nothing — the very message a misreading printed on 2026-09-14 (see the loop above) —
   * so a report that disagrees with the count is said to be one, and no file is named off it.
   */
  if (outcome.accounted !== outcome.count) {
    problems.push(
      `${outcome.name}: bun counted ${outcome.count} tests and its JUnit report accounts for ${outcome.accounted}, so\n` +
        "  the report was not read whole, and no file is judged by it.",
    );
    continue;
  }
  if (outcome.emptyFiles.length > 0) {
    problems.push(
      `${outcome.name}: ${outcome.emptyFiles.length} test file(s) ran no test at all:\n` +
        `${outcome.emptyFiles.map((path) => `    ${path}`).join("\n")}\n` +
        "  A file with nothing in it is gone in every way that matters. Give it a test or delete it\n" +
        "  and update the manifest.",
    );
  }
}

const table = outcomes
  .map(
    (outcome) =>
      `  ${outcome.name.padEnd(16)}${String(outcome.count ?? "?").padStart(5)} / floor ${outcome.floor}`,
  )
  .join("\n");

if (problems.length > 0) {
  console.error(
    `\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\n${table}\n\n` +
      "A group under its floor with every test passing is not a failing test, it is a suite that got\n" +
      "smaller. The usual cause is a file that threw while being imported, which takes its tests with\n" +
      "it and reports nothing. Run `bun test` over that workspace and look for an unhandled error\n" +
      "between the file groups.\n\n" +
      "If tests were deliberately removed, lower that group's floor in scripts/test-ci.ts and say why.",
  );
  process.exit(1);
}

const total = outcomes.reduce((sum, outcome) => sum + (outcome.count ?? 0), 0);
console.error(`\n${total} tests ran in ${testDatabase}.\n${table}`);
