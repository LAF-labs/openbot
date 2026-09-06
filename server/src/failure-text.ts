/**
 * Where `describeFailure` was, kept as its address.
 *
 * The implementation moved to `shared/failure-text.ts` the day `agent-bot` needed it for its own
 * log line: that service's image carries `shared/` and nothing under `server/`. Every server sink
 * imports it from here as before, so the move is invisible to them and to the test that pins the
 * behaviour.
 */
export {
  describeFailure,
  describeProviderFailure,
  noAnswerFact,
  providerStatusFact,
} from "../../shared/failure-text";
