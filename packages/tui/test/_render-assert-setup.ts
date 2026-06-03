// Test setup (loaded via `node --test --import`): turn the per-component render
// width guard ON for the whole TUI suite. Any component that emits a line wider
// than the width it was given then fails its test by name (see
// assertComponentWidth), catching the overflow class at the component boundary
// in CI — the same class that once crashed a session via TUI.doRender.
//
// Tests that intentionally feed over-wide content to exercise downstream
// truncation/recovery opt out locally with setRenderAssertEnabled(false) (see
// overlay-options.test.ts "width overflow protection"). The filename has no
// ".test" segment, so the runner does not collect it as a suite.
import { setRenderAssertEnabled } from "../src/tui.js";

setRenderAssertEnabled(true);
