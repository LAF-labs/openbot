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
 *
 * `roots` is a partition of the repository rather than a filter: a test file under none of them
 * fails the run instead of going uncounted, which is the same silence this whole script exists to
 * break.
 */
const GROUPS = [
  { name: "server", floor: 2767, roots: ["server"] },
  { name: "app", floor: 1381, roots: ["app"] },
  { name: "agent-computer", floor: 288, roots: ["agent-computer"] },
  { name: "root", floor: 431, roots: ["tests", "agent-bot"] },
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
