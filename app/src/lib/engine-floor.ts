/**
 * WHETHER THE ENGINE UNDER THIS PAGE CAN DRAW A CONVERSATION, ASKED BEFORE THE APP STARTS.
 *
 * The app runs in a webview before it runs in a browser, and the webview's engine is whatever the
 * person's system ships. Measured 2026-10-03 on a production build made to behave like one: a
 * WebKit older than Safari 16.4 — what macOS has before 13.3 and iOS before 16.4 — cannot build a
 * pattern that looks behind, and the library that reads a reply's markdown builds one for every
 * reply (`mdast-util-gfm-autolink-literal`, through remark-gfm; its newest release still does,
 * and the lock file has named that release since v0.3.0). So a conversation fell to "this part of
 * the screen" the moment it held a Bot's reply, and nothing told the person why or what to do
 * about it.
 *
 * WHAT IS ASKED IS THE THING THAT BREAKS, not a version read out of a user agent: a webview names
 * no browser, and an engine that gains the look-behind some other way is an engine this runs on.
 * Nothing else is asked. An engine that draws the colours less well (no `color-mix`) still works,
 * and somebody who can use the app is not turned away from it.
 *
 * Built with the constructor, from a string: written as a literal it would stop an old engine
 * reading this file at all.
 */
export function isEngineTooOld(): boolean {
  try {
    // biome-ignore lint/complexity/useRegexLiterals: a literal is a syntax error on the engines this asks.
    new RegExp("(?<=a)b");
    return false;
  } catch {
    return true;
  }
}
