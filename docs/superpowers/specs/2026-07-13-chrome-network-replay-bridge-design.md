# Chrome Network Replay Bridge — Design

## Goal

Turn the native CDP network buffer into a deterministic security input without exposing raw secrets or adding a second browser stack.

## Scope

- Preserve redirect hops, initiator summaries, and request/response `ExtraInfo` headers.
- Expose one request in full through the existing `chrome_devtools_read_network` tool.
- Let the existing lazy `security_http_replay_diff` tool use a captured XHR `requestId` as its source.
- Keep all output bounded and redacted.

## Design

Each captured hop receives a stable `entryId` (`requestId#hop`). The latest hop remains addressable by the original CDP `requestId`, preserving existing body lookup behavior. Redirect responses finalize the previous hop before the next hop is created. `ExtraInfo` events are assigned in protocol order to the first hop that has not received the corresponding metadata; secrets and cookie values are never retained in exported entries.

`chrome_devtools_read_network` keeps its compact list mode. Supplying `requestId` returns the selected hop as redacted JSON, including headers, request body, timing, initiator, redirect metadata, and bounded response body when requested.

Browser replay is added as a second input form to `security_http_replay_diff`. It calls CDP `Network.replayXHR` for baseline/control/mutation. Optional control and mutation patches are applied transiently with the CDP Fetch domain, using the paused request's in-browser headers/body so credentials never cross into Pit output. Each replay is correlated to a newly captured entry, then converted to the existing comparison model. The mode is intentionally limited to XHR because that is the guarantee provided by `Network.replayXHR`; explicit HTTP replay remains the fallback for other resource types.

## Safety and failure behavior

- Every persisted or returned value passes the existing HTTP/secret redactors.
- Request/response bodies retain the existing size limits.
- Fetch interception is enabled only for one replay and disabled in `finally`.
- Non-target paused requests continue unchanged.
- Replay times out with a clear error and never leaves interception enabled.
- Existing explicit replay and compact network listing stay backward compatible.

