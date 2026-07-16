/**
 * Live E2E autoskip wrapper — re-export of the shared helper next to
 * packages/ai/test/oauth.ts so coding-agent live tests skip (instead of fail)
 * on invalid/revoked credentials. See packages/ai/test/live.ts for the
 * classifier and the CI / PIT_NO_E2E_AUTOSKIP escape hatches.
 */
export { describeAuthFailure, live, liveAutoskipEnabled } from "../../ai/test/live.js";
