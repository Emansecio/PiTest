# Pit Transcript Mouse Selection

## Goal

Keep Pit mouse interactions enabled while allowing plain left-button dragging over
the conversation transcript to select text and copy it automatically on release,
matching the practical Claude Code behavior.

## Interaction contract

- Existing interactive targets keep priority: editor cursor placement and selection,
  lists, overlays, buttons, and other mouse-aware components continue to receive
  their mouse events.
- An unclaimed left press over committed transcript content starts an in-app text
  selection.
- Dragging updates a reverse-video highlight in either direction and across lines.
- Releasing the left button copies the selected plain text automatically.
- Right-clicking a completed selection copies it again.
- A collapsed selection copies nothing.
- Scrolling, disabling mouse tracking, resizing, or changing the underlying frame
  invalidates a stale selection.
- `Shift+drag` remains the terminal-native escape hatch.
- `PIT_NO_MOUSE=1` remains a supported kill switch, but is not required for normal
  selection after this feature is active.

## Architecture and data flow

`@pit/tui` owns the selection gesture, screen-to-frame coordinate conversion,
highlight rendering, and conversion from styled terminal cells to plain text. It
exposes the completed selection through a callback and does not depend on any
platform clipboard implementation.

`@pit/coding-agent` receives the selected text, writes it through the existing
clipboard helper, and reports success or failure through the normal dense status
line. Clipboard failures must not become unhandled promise rejections or report a
false success.

The committed frame is the selection source of truth. Selection coordinates use
visible terminal columns, not JavaScript string offsets, so ANSI styling and
wide/combined Unicode characters do not corrupt the copied range.

## Validation

- Pure coverage for ANSI removal and selection highlighting.
- TUI-path coverage for single-line, multiline, reverse-direction, collapsed, and
  stale-frame selections.
- Regression coverage proving interactive components retain priority over
  transcript selection.
- Clipboard success and failure coverage at the coding-agent boundary.
- Focused `@pit/tui` and coding-agent tests, type checking, and a real Windows
  terminal run that verifies click interactions plus drag-to-copy in one session.

## Non-goals

- Native terminal selection without a modifier while SGR mouse capture is enabled.
- Auto-scrolling the transcript while a selection drag crosses the viewport edge.
- Double-click word selection or triple-click line selection.
- Refactoring unrelated TUI rendering, mouse routing, or clipboard code.

## Activation

After the tests and real-terminal check pass, remove the user-level
`PIT_NO_MOUSE=1` override and restart Pit. Mouse tracking remains enabled by Pit's
normal persisted setting, so both clicking and transcript drag-to-copy work without
external configuration.
