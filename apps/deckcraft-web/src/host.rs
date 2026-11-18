//! The host bridge, for pages that embed DeckCraft and keep its files (a Nextcloud app, a personal
//! file server). The messages and the two transports are `craft-web-host`'s
//! (storytold/craft-libs), the same contract as the other Craft apps' bridges, with the
//! `deckcraft:` prefix. This module is DeckCraft's part of it.
//!
//! - `?host=parent` (an `<iframe>`) talks to the same-origin parent over `postMessage`;
//!   `data-host="page"` on the canvas (the page's own document, no iframe) uses DOM
//!   `CustomEvent`s on the canvas instead. `?host=parent` wins when both are present. With no
//!   parent, or a parent on another origin, there is no bridge: the normal app with downloads.
//! - `deckcraft:ready` (to the host): sent once the app is running and listening; send a file now. DeckCraft
//!   reads bytes, so it says `file: false` and a host sends `bytes`. `openResult: true` advertises correlated adoption results.
//! - `deckcraft:open` (from the host): `{ id?, name, bytes }`, bytes an `ArrayBuffer` or
//!   `Uint8Array`, name a bare file name. It opens like a file picked with File › Open on the
//!   desktop: a presentation sent with its name (.pptx, .potx, .ppsx, .deckcraft) has that name
//!   as its file, so Save goes back to it; an outline (.txt, .md, .rtf), a file without a name and
//!   a damaged file open untitled.
//! - `deckcraft:save` (to the host): `{ name, saveAs, bytes }` (with the bytes as a transferred `ArrayBuffer` over `postMessage`) for
//!   every file DeckCraft would otherwise download. Document saves carry `id`, `documentId`, editor `revision`, `operation` and `documentSave: true`; the host
//!   answers `deckcraft:saved { id }` only after durable storage. Until confirmation the
//!   captured document remains unsaved. `deckcraft:save-failed` carries an explicit failed/cancelled/conflict/unknown outcome; unknown retains the no-retry guard. Exports remain copies. `saveAs` says whether the file becomes the presentation's file:
//!   - Save: `false`. It writes the opened file under its own name and format (a .pptx stays a
//!     .pptx), as the desktop app does. A name the parent never sent (an untitled presentation, an
//!     outline, a file sent without a name, a repaired copy of a damaged file, a file the user
//!     picked or dropped) is a new file: `true`, as for Save As, named `<title>.deckcraft` as
//!     Save suggests on the desktop.
//!   - Save As (File › Save As as .pptx or .deckcraft, Ctrl+Shift+S): `true`. The presentation is
//!     now that file; the next Save sends its name with `false`.
//!   - Export (PDF, pictures, outline, GIF, handouts, a Save As type that isn't a presentation)
//!     and Print: `false`. They are copies; the presentation's file stays the same.
//! - `deckcraft:dirty` whenever unsaved changes appear or go away, `deckcraft:failed` when the
//!   app couldn't start or refused a file of 2 GiB or larger.
//!
//! In host mode the app starts with an empty presentation instead of the sample, which gives way to
//! the first file the host sends; the host guards leaving the page, and `?author=` names the user
//! for comments.

use std::cell::RefCell;
use std::rc::Rc;

use craft_web_host::web::{FileData, Host, Message};
use craft_web_host::{OpenResult, SaveContext, SaveFailureKind};
use deckcraft_ui_egui::{HostSaveContext, Inbox, InboxEvent, Services, SlideApp};

/// The app id in the host messages (`deckcraft:ready`).
const APP: &str = "deckcraft";

/// The name `craft-web-host` gives an open request that carries none (it cleans a host's name and
/// falls back to this): no name is no file, so the presentation opens untitled.
const NAMELESS: &str = "document";

/// The largest file a host may send. File › Open on the desktop refuses anything over 2 GiB.
/// On wasm32 a `Vec` cannot hold 2 GiB (`isize::MAX` is one byte less), so a file of exactly
/// 2 GiB is refused too, before its bytes are copied.
const MAX_OPEN_BYTES: f64 = 2_147_483_648.0;

/// The longest user name taken from `?author=` (the preferences' own limit).
const MAX_AUTHOR_CHARS: usize = 256;

struct PendingOpen {
    id: Option<String>,
    name: Option<String>,
    bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct Bridge {
    host: Rc<Host>,
    /// Files the host sent (the name, if it sent one), waiting for the next frame.
    opened: Rc<RefCell<Vec<PendingOpen>>>,
}

impl Bridge {
    /// The bridge for this page, or `None` when DeckCraft isn't hosted: no `?host=parent` and no
    /// `data-host="page"` on the canvas, an unframed `?host=parent` page (it stays the normal app
    /// with downloads), or a parent on another origin.
    pub fn detect(canvas: &web_sys::HtmlCanvasElement) -> Option<Self> {
        let host = Host::connect(APP, canvas)?;
        // An opaque origin (a file:// page in some browsers) can't be a postMessage target.
        if host.mode() == craft_web_host::Mode::Parent && web_sys::window()?.location().origin().ok()? == "null" {
            return None;
        }
        Some(Self { host: Rc::new(host), opened: Rc::default() })
    }

    /// Hand saved and exported files to the host instead of downloading them, and hear the files
    /// it sends.
    pub fn connect(&self, services: &mut Services, ctx: egui::Context) {
        let inbox = services.inbox.clone().unwrap_or_default();
        services.inbox = Some(inbox.clone());
        self.listen(ctx, inbox);
        services.host_request = Some(Box::new(move |command, params, uid, revision| {
            let value = serde_json::json!({"type": "deckcraft:document-request", "command": command, "params": params, "documentId": uid.to_string(), "revision": revision.to_string()});
            if let Some(window) = web_sys::window()
                && let Ok(Some(parent)) = window.parent()
                && let Ok(origin) = window.location().origin()
                && let Ok(value) = js_sys::JSON::parse(&value.to_string())
            {
                let _ = parent.post_message(&value, &origin);
            }
        }));
        let bridge = self.clone();
        services.host_save = Some(Box::new(move |name: &str, bytes: &[u8], save_as: bool, context: &HostSaveContext| {
            let document_id = context.document.to_string();
            let revision = context.revision.to_string();
            let captured = SaveContext {
                id: &context.id,
                document_id: &document_id,
                revision: &revision,
                operation: if save_as { "file.saveAs" } else { "file.save" },
                document_save: true,
            };
            bridge.post_identified_save(name, bytes, save_as, &captured)
        }));
        // Exports and Print are copies.
        let bridge = self.clone();
        services.download = Some(Box::new(move |name: &str, bytes: &[u8]| {
            if let Err(e) = bridge.post_save(name, bytes, false, None) {
                log::error!("couldn't hand {name} to the page: {e}");
            }
        }));
    }

    /// `?author=`: the host's name for the user signs new comments.
    pub fn set_author(app: &mut SlideApp, author: &str) {
        let author: String = author.trim().chars().take(MAX_AUTHOR_CHARS).collect();
        if !author.is_empty() {
            app.session.prefs.author = author;
        }
    }

    pub fn post_ready(&self) {
        let _ = self.host.post_ready_with_open_results(env!("CARGO_PKG_VERSION"), false);
    }

    /// The app couldn't start (no WebGPU or WebGL2, for example): let the host say so.
    pub fn post_failed(&self, error: &str) {
        let _ = self.host.post_failed(error, None);
    }

    /// Before each frame: open the files the host sent.
    pub fn open_files(&self, app: &mut SlideApp) {
        let opened = std::mem::take(&mut *self.opened.borrow_mut());
        for pending in opened {
            match app.open_from_host(pending.name.as_deref(), &pending.bytes) {
                Ok(outcome) => {
                    if let Some(id) = pending.id.as_deref() {
                        let document_id = outcome.document_id.to_string();
                        let revision = outcome.revision.to_string();
                        let result =
                            OpenResult { id, document_id: &document_id, revision: &revision, source_retained: outcome.source_path.is_some() };
                        if let Err(error) = self.host.post_opened(&result) {
                            log::warn!("couldn't report opened document: {error}");
                        }
                    }
                }
                Err(error) => {
                    let _ = self.host.post_failed(&error, pending.id.as_deref());
                }
            }
        }
    }

    /// After each frame: tell the host when unsaved changes appear or go away (the crate does not
    /// repeat a state it already reported).
    pub fn report_dirty(&self, app: &SlideApp) {
        self.host.post_dirty(app.session.documents().iter().any(|d| d.is_dirty()));
    }

    fn post_save(&self, path: &str, bytes: &[u8], save_as: bool, id: Option<&str>) -> Result<(), String> {
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        self.host.post_save(&name, bytes, id, save_as)
    }

    fn post_identified_save(&self, path: &str, bytes: &[u8], save_as: bool, context: &SaveContext<'_>) -> Result<(), String> {
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        self.host.post_identified_save(&name, bytes, save_as, context)
    }

    /// Hear `deckcraft:open` and queue the file for the next frame.
    fn listen(&self, ctx: egui::Context, inbox: Inbox) {
        let opened = self.opened.clone();
        let host = self.host.clone();
        self.host.listen(move |message| {
            let (id, name, data) = match message {
                Message::Saved { id } => {
                    match inbox.lock() {
                        Ok(mut events) => events.push(InboxEvent::HostSaved { id }),
                        Err(poisoned) => poisoned.into_inner().push(InboxEvent::HostSaved { id }),
                    }
                    ctx.request_repaint();
                    return;
                }
                Message::SaveFailed { id, outcome, error } => {
                    let event = InboxEvent::HostSaveFailed { id, error, uncertain: outcome == SaveFailureKind::Unknown };
                    match inbox.lock() {
                        Ok(mut events) => events.push(event),
                        Err(poisoned) => poisoned.into_inner().push(event),
                    }
                    ctx.request_repaint();
                    return;
                }
                Message::Open { name, data } => (None, name, data),
                Message::IdentifiedOpen { id, name, data } => (Some(id), name, data),
                _ => return,
            };
            if data.size() >= MAX_OPEN_BYTES {
                log::warn!("host file {name} is 2 GiB or larger; not opened");
                let _ = host.post_failed(&format!("{name} is 2 GiB or larger, which DeckCraft's web build cannot open"), id.as_deref());
                return;
            }
            let FileData::Bytes(array) = data else {
                log::warn!("host file {name} came as a File; DeckCraft reads bytes only; not opened");
                let _ = host.post_failed("DeckCraft requires transferred bytes for this open", id.as_deref());
                return;
            };
            // Bound queued copies before allocating another native byte buffer.
            if opened.borrow().len() >= 8 {
                let _ = host.post_failed("Too many host opens are pending", id.as_deref());
                return;
            }
            // No name is no file: the presentation opens untitled, never under an invented name.
            let name = (name != NAMELESS).then_some(name);
            opened.borrow_mut().push(PendingOpen { id, name, bytes: array.to_vec() });
            ctx.request_repaint();
        });
    }
}
