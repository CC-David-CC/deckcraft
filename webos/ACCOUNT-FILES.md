# Account file binding domain — work in progress

`createFileSession` owns only native-document to account-resource/server-SHA
bindings. It does not own a document model, authentication or a second store.
Every open/save supplies its caller authority explicitly. `authorize` receives
captured instance/session/document identity, operation, source/destination
resource and expected server revision. UI visibility grants nothing.

`open(resource, caller, adopt)` reads and verifies the captured server revision,
then awaits a correlated native adoption result. `adopt(name, bytes)` must resolve
that operation's real `documentId`, editor `revision` and `sourceRetained`.
A later active-document query is not a substitute. Converted/repaired/unnamed
source-less results become drafts and cannot overwrite the imported account file.

`save(nativeMessage, caller)` accepts identified native document saves, captures
immutable bytes before awaiting authorization, and passes the expected server SHA
to Storage. Ordinary Save preserves the bound name; changing it requires Save As.
Save As creates a new destination without overwriting an existing file. Only a
valid durable server reply installs the new binding and returns `committed:true`.
Conflict/definitive failure retain the old binding. Unknown outcomes block retries;
automatic retry or reopening a view is not proof that the earlier write failed.
No reconciliation interface is implemented yet.

The view adapter must send the native saved acknowledgement only after this
result, or send the appropriate failed/conflict/unknown outcome. It must preserve
native request IDs, refuse uncorrelated exports, and not attribute an agent-triggered
save to a retained human grant. Export origin/caller correlation and authenticated
agent transport remain separate work. Disposing does not claim server cancellation.

Ten domain tests use fake Storage and no network. These are not real account
persistence/browser tests. The new synchronous view adapter is exercised in isolated browser fixtures and is not enabled in the assembled desktop;
no upstream Rust core, deployment or selected parent pin changes follow from it.
Run `node --test webos/account-files.test.mjs` for these checks. All required
repository CI must pass before committing. The synchronous mount, correlated transport, save completion and close guards pass an actual-WASM fixture. A separate Login/Accounts/UserFiles fixture passes real disk-backed saves, content reopening in a fresh browser context, stale-write conflict, other-account denial and logout fencing. These results do not qualify parent Desktop/Files composition, exports, delegated agents, physical second-machine operation or deployment.

The standalone inline bootstrap is blocked by the existing account-server CSP.
`node webos/package-browser.mjs BUILT_BINDGEN_SITE NEW_OUTPUT` externalizes only
that explicit bootstrap and preserves all native runtime payloads and notices.
It refuses output collisions, symlinks, missing notices and changed bootstrap
HTML; it returns per-input/output digests. Input must be the verified explicit
Cargo/wasm-bindgen site (not arbitrary Trunk output). It does not compile Rust,
prove source provenance, run wasm-opt or establish deployment readiness. The
parent still must verify the selected source and artifact receipt.

Five packaging tests plus ten account-domain tests pass. Run:

```sh
node --test webos/account-files.test.mjs webos/package-browser.test.mjs
```

The browser regression reproduces Save during a paused initial account read:
the previous adapter dispatched a Storage write. The guarded view rejects it
before Storage and keeps the native frame inert until initialization completes.
The identical regression then passes, including completion of the paused open.
The full real signed-account fixture passes again with this guard and the owned
external-bootstrap packager, under unchanged CSP. Screenshots were inspected.

This view admits only the explicit human capability until native invocation and
delegated storage authority can be correlated. Its domain methods accept caller
authority explicitly; no agent inherits the view's human capability. Closing a
multi-document view does not silently focus/save background documents: other
unsaved documents must be saved in the native app, or explicitly discarded after
state comparison. Unknown saves block closing/retry; reconciliation remains open.
Exports are uncorrelated copies and are not connected to account storage.
Parent Desktop/Files composition, exports, authenticated agent transport,
physical second-machine acceptance and deployment remain open.

Revision: WEBOS-77 — synchronous account view, startup-save gate, owned CSP packaging.
