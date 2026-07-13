# `/mcp` Inline Panel Design

## Goal

Replace the centered `/mcp` overlay with a compact management panel anchored immediately above the input editor. The panel must feel like part of Pit's command surface, preserve the current MCP actions, and avoid covering the transcript.

## Chosen approach

Add an opt-in `above-editor` placement to the existing custom-component UI path and use it only for `/mcp`. This keeps the editor visible at the bottom, gives the panel keyboard focus while open, and restores the editor unchanged on close. Existing overlays and custom components retain their current behavior.

## Layout

- Render the panel at the bottom of the TUI, directly above the editor and footer.
- Use the available editor width instead of a percentage-based centered box.
- Keep the title compact: `MCP servers`, with a muted count/status summary when useful.
- Render each server as a compact selectable row. The selected row receives an accent marker on the left; unselected rows remain neutral.
- Show status, server name, and a width-capped endpoint on the primary row.
- Show error text or discovered tools on an indented secondary row only when present.
- Keep the keyboard help on one muted footer line.
- Cap the panel height through the existing TUI layout; long content wraps or truncates within the available width and remains navigable by server.

## Interaction

- Preserve `Up/Down` and `j/k` navigation.
- Preserve `r` reconnect, `d` or `Space` enable/disable, and `Esc` close.
- Keep background reconnection and live status refresh unchanged.
- While the panel has focus, the editor remains visible but does not consume keystrokes.
- Closing the panel restores the editor text and focus without changing the transcript.

## Implementation boundaries

- Extend the custom UI options with an explicit inline placement rather than special-casing MCP inside `InteractiveMode`.
- Change `/mcp` from centered overlay mode to the new placement.
- Refine only `McpPanelComponent` presentation; do not change MCP connection, persistence, discovery, or retry behavior.
- Preserve every existing custom overlay and selector layout by default.

## Validation

- Component tests cover compact rows, selected-row accent, width safety, statuses, errors, tools, and key actions.
- Interactive-mode tests cover above-editor placement, editor preservation, focus restoration, and unchanged default custom-component behavior.
- MCP extension tests verify `/mcp` requests the inline placement instead of a centered overlay.
- Run focused tests plus the project static gate.
