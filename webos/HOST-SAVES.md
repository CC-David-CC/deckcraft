# Hosted save confirmation in the WebOS fork

Host saves are asynchronous. Returning Ok from Services.host_save means dispatched,
not saved. The callback receives an opaque request id and the captured document
identity and revision. It must eventually deliver InboxEvent::HostSaved, or a
HostSaveFailed result whose uncertainty is explicit. The web shell reuses the
shared craft-web-host Saved{id} message. A framing page must send it only after
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

The WebOS desktop/account adapter is not enabled by this change. Immediate web
failure/uncertainty replies, export acknowledgements, account revision/resource
binding, disposal and delegated-agent authority still require integration and
acceptance. Synthetic acknowledgements in protocol tests are not server-backed
account persistence evidence.
