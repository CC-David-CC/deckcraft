# DeckCraft document host

Status: implementation candidate; native CI and actual-browser acceptance are pending.
The selected source remains the focused fork at
`45463e6ba33aea1cdd664a27c4afd017ba35275a`, retaining its five WebOS arcs. Its
recorded upstream `main` is `6c52db01727b4d3cfb2e122770ce76de6a6fa71e`;
47 upstream-only commits and five fork-only commits were inspected locally.
No broad upstream merge is part of this integration.

`@webos/deckcraft` exports synchronous `mount(host)`. The view returns `element`,
`ready`, `dispose`, `focus`, `inspect`, `execute`, `requestClose`, `lifecycle`,
`fileBinding`, `checkpoint`, and `retry`. Accounts supplies explicit instance,
session, principal authority and authorization; Storage supplies account file
reads/version/conditional writes. Desktop supplies `newDocument(params)`,
`openFile(file)`, `activateFile(file)`, `importDocument(input)` and `closeView()`.
Initial `template` is an optional native New params object (`theme`, `template`,
or `sample`); `imported` is `{name,data}` with bounded base64 presentation bytes.

The application owns Rust model commands, presentation codecs, notes drafts,
undo and exact native identities. Runtime owns journal mechanics through
`@webos/deckcraft/recovery`; parent composition supplies an issuer/account-scoped
journal, discovery/restoration and Desktop captions/layout. No JavaScript editable
presentation model or alternative account store is introduced.

Prepared saves capture a native Arc, revision and ticket. Durable confirmation
uses the private native `host.acknowledgeSave` operation with the canonical account
path. Ordinary generic `saved` delivery messages cannot finalize document-host
writes. Later edits and undo stay in the native session. Public commands require
exact instance/session/native document/account-resource targets and explicit
caller authority; private `host.*` operations are excluded. Delegated commands
remain unavailable rather than inheriting the retained human grant.

New/Open/Close requests retain the current editor and go to Desktop. Both Files
and native Open must activate an existing editor for the account resource. Save As
is conditional at the existing source and create-only elsewhere; copy exports
are create-only, preserve identity, and are never acknowledged as document saves.
Unknown outcomes retain the native pending guard. Print currently produces a PDF
copy; no graphical print-dialog qualification is claimed.

Native recovery version1 is a `.deckcraft` ZIP holding the full presentation,
embedded media and chart parts. Pending formatted notes are overlaid into a
disposable Rust presentation without altering the live buffer. Slide typing and
supported IME preedit already live in the native document. Recovery does not
reconstruct undo, selection, dialog state or platform IME ownership. An unresolved
external media resource or unfinished native edit dialog refuses a new checkpoint;
the previous committed journal record remains. Changed/unverifiable saved bases
require Save As to a different resource. Quiet untouched blanks remain explicitly
saveable.

Browser preferences and recent paths are persisted only under the explicit
issuer/account profile namespace; there is no global fallback. Existing browser
font additions are session-only and confined to their native iframe, and are not
claimed as persistent uploaded-font management. Current bundled fonts remain an
explicit pinned public input.

Finalization uses native pause leases after close decisions, with revision and
pending-notes rechecks. The native UI/control commands and binary adoption reject
mutations while paused. Desktop owns the single hosted navigation warning.
Closing the view ends its own presentation/playback/presenter popup; no external
shared service or job is owned by this adapter.

Restricted ArtCraft logo/mark files are removed under the fork terms. The generic
licensed DeckCraft app icon, About, community/source links and contributor/model
credits remain, as do plain-text upstream attribution and original mark terms.

## Portable browser build

Use a clean reviewed app source checkout after its native gates. The recipe takes
explicit clean font input at `webos/craft-fonts.rev`, three self-contained bare Git
providers, a separate compiler target and a new external artifact directory:

```sh
python3 webos/build.py --output "$ARTIFACT" --target-dir "$DECKCRAFT_TARGET" \
  --fonts "$CRAFT_FONTS" --craft-libs-origin "$CRAFT_LIBS_ORIGIN" \
  --egui-origin "$EGUI_ORIGIN" --winit-origin "$WINIT_ORIGIN" --jobs 8
```

Rust is pinned to nightly-2026-11-16; wasm-bindgen CLI must match lockfile0.2.129.
The recipe uses direct Cargo and wasm-bindgen, requires offline dependencies, and
packages the actual WASM/snippets/bootstrap/CSS graph and notices without changing
CSP. `craft-web-host` alone uses maintained commit
`94981849457596b032355f74144cdd91c04d5df5` from an explicit local provider; this is
not represented as a public upstream commit. Other historical library pins remain.
A component build receipt hashes the complete graph. Compiler and test outputs
must remain outside source and web roots.

## Qualification gates

`cargo xtask ci` is required before commits. Focused native tests cover canonical
save/undo/later edits, explicit clean blank Save, generic-ack rejection, recovery
with notes/media, pause leases, document requests and native profiles. Adapter
regressions run with `node --test webos/*.test.mjs`; their synthetic endpoint is
not native fidelity evidence.

Actual-browser acceptance must independently create two slides with theme,
title/body text, image and notes; Save/Save As/reopen/fresh-context retrieval;
Files and native Open activation; delayed/failed/conflicting/unknown writes;
refresh/minimized/orphan/account-switch recovery; close decisions and native
pause lease; then inspect actual rendered output and strict console/network
results. Presenter/fullscreen entry/exit is separate from authoring. No claim is
made about every media codec, transition, export format, or immersive mode.
