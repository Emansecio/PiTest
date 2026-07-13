# Minimal collapsed tool errors

## Objective

Keep failed tool activity compact in the interactive TUI. A collapsed failure renders only its existing red error header, such as `✗ $ Ran <command>`. Error output remains available through the existing manual expansion control (`Ctrl+O`).

## Scope

- Remove automatic error-body previews from collapsed `ActivityLineComponent` rows.
- Remove automatic error-body previews from collapsed `BashGroupComponent` rows.
- Preserve pending and successful rendering, status icons, colors, truncation, explicit expansion, and error result data.
- Do not change unrelated activity spacing or current workspace WIP.

## Validation

- Update focused component tests to assert that collapsed errors are header-only.
- Assert that explicit expansion still renders the complete error body.
- Run the focused activity component and spacing tests.

