# Hosted save confirmation in the WebOS fork

Host saves are asynchronous. Returning Ok from Services.host_save means dispatched,
not saved. The callback receives an opaque request id and the captured document
identity and revision. It must eventually deliver InboxEvent::HostSaved, or a
HostSaveFailed result whose uncertainty is explicit. The web shell uses the shared craft-web-host identified-save API and Saved{id} message.
Document saves send the captured document/revision, file.save or file.saveAs operation
and documentSave=true. Explicit failed/cancelled/conflict outcomes retain edits and
release the pending guard; unknown retains both edits and the guard. A framing page must send it only after
its storage authority confirms durable success.

The editor captures an immutable Arc snapshot at serialization. A matching reply
sets that originating document's saved snapshot, leaving later edits dirty and
preserving the active document. Missing, wrong, duplicate and closed-document
replies cannot mark another document saved. Save As changes identity only after
confirmation. Pending saves are bounded, and a document cannot repeat an
unresolved save. Timeout records an unknown outcome and keeps that guard until a
definitive result resolves it. Inspect ui.inspect.pendingSaves for the real id,
documentId, revision and pending/unknown state. Those are operation identities,
not authentication or authorization grants.

Save-and-close intent targets the original document and closes it only when the
acknowledged snapshot remains current. A File view's return-to-editor intent is
bound to the precise view lifetime; closing and reopening Save As cannot let an
old completion close the new view. Native and browser commands use the same
save implementation. Direct native filesystem saves retain their synchronous
writer path.

The WebOS desktop/account adapter is not enabled by this change. Export acknowledgements, account revision/resource
binding, disposal and delegated-agent authority still require integration and
acceptance. Synthetic acknowledgements in protocol tests are not server-backed
account persistence evidence.

## Assembly dependency

The web shell consumes the public `craft-web-host` crate from the assembly's
`libraries/craft-libs/crates/web-host` checkout. The parent pins its exact commit.
Initialize that sibling component before Cargo builds; other historical Craft
library and page-API pins remain unchanged. This does not grant access to another
component's internal state or to account files. Exports still use the existing
uncorrelated copy callback and are not confirmed account saves.

Revision: WEBOS-70 — shared captured-save wire and explicit non-success replies.
