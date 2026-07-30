/**
 * Compaction and summarization utilities.
 */

export * from "./branch-summarization.ts";
export * from "./cache-aware.ts";
export * from "./compaction.ts";
export * from "./summary-grounding.ts";
export * from "./utils.ts";
// Both utils.ts and prune.ts (via compaction.ts) export a headTailExcerpt;
// keep the barrel resolving to the shared utils implementation, as before
// the deep-modules split.
export { headTailExcerpt } from "./utils.ts";
