//! Opt-in document host operations. The native presentation remains authoritative;
//! recovery serializes a disposable native value and never edits the live session.
use std::sync::Arc;

use serde_json::{Value, json};

use crate::SlideApp;

const MAX_RECOVERY_NOTES: usize = 1024 * 1024;

fn account_path(value: Option<&str>) -> Result<&str, String> {
    value
        .filter(|p| {
            !p.is_empty()
                && p.len() <= 2048
                && p.split('/').all(|s| !s.is_empty() && !s.starts_with('.') && !s.contains(['\\', '\0']) && !s.chars().any(char::is_control))
        })
        .ok_or_else(|| "An account-relative file path is required".into())
}

impl SlideApp {
    pub(crate) fn request_host_document(&mut self, command: &str, params: Value) -> Result<Value, String> {
        let d = self.session.doc().map_err(|e| e.to_string())?;
        let (uid, revision) = (d.uid, d.revision);
        let request = self.services.host_request.as_mut().ok_or("Document host request transport unavailable")?;
        request(command, params, uid, revision);
        Ok(json!({"requested": command}))
    }

    /// Saving commits the native notes draft through its ordinary command, preserving undo.
    pub(crate) fn flush_host_notes(&mut self) -> Result<(), String> {
        if self.notes_buf.2.edited && self.session.active().is_some_and(|d| d.uid == self.notes_buf.0) {
            self.session.execute("slide.notes", &json!({"body": self.notes_buf.2.body, "index": self.notes_buf.1})).map_err(|e| e.to_string())?;
            self.notes_buf.2.edited = false;
            self.recovered_notes_pending = false;
        }
        Ok(())
    }

    pub(crate) fn host_command(&mut self, id: &str, p: &Value) -> Result<Value, String> {
        if id == "host.configure" {
            if self.services.host_request.is_none() || self.session.documents().len() != 1 {
                return Err("Document hosting requires a fresh hosted document".into());
            }
            self.host_documents = true;
            return Ok(json!({"version": 1}));
        }
        if !self.host_documents {
            return Err("Document hosting is not configured".into());
        }
        if id == "host.pause" {
            let lease =
                p.get("lease").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 128).ok_or("A bounded pause lease is required")?;
            if p.get("paused").and_then(Value::as_bool) == Some(false) {
                if self.host_pause.as_deref() != Some(lease) {
                    return Err("Pause lease does not match".into());
                }
                self.host_pause = None;
            } else {
                let d = self.session.doc().map_err(|e| e.to_string())?;
                if self.host_pause.is_some()
                    || !self.pending_host_saves.is_empty()
                    || p.get("revision").and_then(Value::as_str) != Some(d.revision.to_string().as_str())
                    || p.get("pendingNotes").and_then(Value::as_str) != Some(self.notes_fingerprint().as_str())
                {
                    return Err("The document changed before finalization".into());
                }
                self.host_pause = Some(lease.to_string());
            }
            return Ok(json!({"paused": self.host_pause.is_some()}));
        }
        if self.host_pause.is_some() && !matches!(id, "host.snapshot" | "host.profile" | "host.finalizeClose") {
            return Err("The document is paused".into());
        }
        match id {
            "host.finalizeClose" => {
                if self.host_pause.as_deref() != p.get("lease").and_then(Value::as_str) || self.host_pause.is_none() {
                    return Err("A matching finalization lease is required".into());
                }
                self.show = None;
                self.media.stop_owned(crate::media::Owner::Show);
                self.media.stop_owned(crate::media::Owner::Editor);
                if let Some(presenter) = self.services.presenter.as_mut() {
                    presenter.close();
                }
                Ok(json!({"closed":true}))
            }
            "host.newInitial" => {
                let d = self.session.doc().map_err(|e| e.to_string())?;
                if self.session.documents().len() != 1 || d.is_dirty() || d.path.is_some() {
                    return Err("Initial document is no longer pristine".into());
                }
                let old = d.uid;
                if p.get("sample").and_then(Value::as_bool) == Some(true) {
                    deckcraft_engine::sample::open_sample(&mut self.session).map_err(|e| e.to_string())?;
                } else {
                    self.session.execute("file.new", p).map_err(|e| e.to_string())?;
                }
                if let Some(index) = self.session.documents().iter().position(|d| d.uid == old) {
                    self.session.close_document(index);
                }
                Ok(json!({"documentId": self.session.active().map(|d| d.uid.to_string())}))
            }
            "host.unbind" => {
                let d = self.session.active_mut().ok_or("No presentation")?;
                d.path = None;
                d.saved_doc = Arc::new((*d.doc).clone());
                Ok(json!({"unsaved": true}))
            }
            "host.bindRecovered" => {
                let path = account_path(p.get("path").and_then(Value::as_str))?.to_string();
                self.session.active_mut().ok_or("No presentation")?.path = Some(path.clone());
                self.note_recent(&path);
                Ok(json!({"path": path}))
            }
            "host.bind" => {
                let path = account_path(p.get("path").and_then(Value::as_str))?.to_string();
                let d = self.session.active_mut().ok_or("No presentation")?;
                if d.path.is_none() {
                    return Err("Imported or repaired presentations require Save As".into());
                }
                d.path = Some(path.clone());
                self.note_recent(&path);
                Ok(json!({"path": path}))
            }
            "host.autosave" => {
                let d = self.session.doc().map_err(|e| e.to_string())?;
                if p.get("path").and_then(Value::as_str) != d.path.as_deref() {
                    return Ok(json!({"status":"paused","reason":"Account resource changed"}));
                }
                if p.get("revision").and_then(Value::as_str) != Some(d.revision.to_string().as_str()) || !self.host_autosave_eligible() {
                    return Ok(json!({"status":"busy","reason":"Finish the native edit before AutoSave"}));
                }
                if !d.is_dirty() {
                    return Ok(json!({"status":"unchanged"}));
                }
                self.save_to_host_named(None, None)
            }
            "host.prepareSave" => {
                let path = p.get("path").and_then(Value::as_str).map(|s| account_path(Some(s))).transpose()?;
                if path.is_some_and(|path| {
                    !["pptx", "potx", "ppsx", "deckcraft"].iter().any(|ext| path.to_ascii_lowercase().ends_with(&format!(".{ext}")))
                }) {
                    return Err("Choose a presentation file extension".into());
                }
                self.save_to_host_named(None, path)
            }
            "host.acknowledgeSave" => {
                let ticket = p.get("id").and_then(Value::as_str).ok_or("Save ticket required")?;
                let path = account_path(p.get("path").and_then(Value::as_str))?;
                let pending = self.pending_host_saves.get_mut(ticket).ok_or("Unknown or settled save ticket")?;
                if deckcraft_engine::cmd::file::format_for_path(path) != deckcraft_engine::cmd::file::format_for_path(&pending.name) {
                    return Err("Confirmed path has a different serialized format".into());
                }
                pending.name = path.to_string();
                self.settle_host_save(ticket, None);
                if let Some(d) = self.session.active() {
                    if d.path.as_deref() != Some(path) {
                        return Err("The canonical save confirmation could not be applied".into());
                    }
                    return Ok(json!({"path": d.path, "dirty": d.is_dirty()}));
                }
                Err("Saved document is unavailable".into())
            }
            "host.snapshot" => {
                if self.dialog.as_ref().is_some_and(|dialog| dialog.id != "about") {
                    return Err("Finish the open native dialog before creating a recovery checkpoint".into());
                }
                let d = self.session.doc().map_err(|e| e.to_string())?;
                if d.doc.media.iter().any(|media| media.link.is_some() && media.data.is_empty()) {
                    return Err("Recovery requires embedded media; an external media resource is unavailable".into());
                }
                let notes_draft = if self.notes_buf.0 == d.uid && self.notes_buf.2.edited {
                    if self.notes_buf.1 >= d.doc.slides.len() {
                        return Err("Pending notes slide is unavailable".into());
                    }
                    let body = serde_json::to_string(&self.notes_buf.2.body).map_err(|e| e.to_string())?;
                    if body.len() > MAX_RECOVERY_NOTES {
                        return Err("Pending notes exceed the recovery size limit".into());
                    }
                    Some(json!({"slide": self.notes_buf.1, "body": body}))
                } else {
                    None
                };
                let bytes = deckcraft_engine::cmd::file::save_bytes(&d.doc, "deckcraft").map_err(|e| e.to_string())?;
                if bytes.len() > 128 * 1024 * 1024 {
                    return Err("Recovery snapshot exceeds 128 MiB".into());
                }
                Ok(json!({"version": 1, "revision": d.revision.to_string(), "data": deckcraft_engine::cmd::base64_encode(&bytes),
                    "notesDraft": notes_draft}))
            }
            "host.restore" => {
                let snapshot = p.get("snapshot").ok_or("Native snapshot required")?;
                if snapshot.get("version").and_then(Value::as_u64) != Some(1) {
                    return Err("Unsupported recovery version".into());
                }
                let data =
                    snapshot.get("data").and_then(Value::as_str).filter(|s| s.len() <= 178_956_972).ok_or("Bounded native snapshot required")?;
                let notes_draft = if let Some(draft) = snapshot.get("notesDraft").filter(|draft| !draft.is_null()) {
                    let slide =
                        draft.get("slide").and_then(Value::as_u64).and_then(|slide| usize::try_from(slide).ok()).ok_or("Invalid notes slide")?;
                    let body =
                        draft.get("body").and_then(Value::as_str).filter(|s| s.len() <= MAX_RECOVERY_NOTES).ok_or("Bounded notes body required")?;
                    let body: deckcraft_model::text::TextBody = serde_json::from_str(body).map_err(|e| e.to_string())?;
                    Some((slide, body))
                } else {
                    None
                };
                let bytes = deckcraft_engine::cmd::base64_decode(data).ok_or("Invalid native snapshot")?;
                let outcome = self.open_from_host_at(Some("Recovery.deckcraft"), &bytes, notes_draft.as_ref().map(|(slide, _)| *slide))?;
                let d = self.session.active_mut().ok_or("Recovered document unavailable")?;
                d.path = None;
                d.saved_doc = Arc::new((*d.doc).clone());
                d.revision = d.revision.saturating_add(1);
                if let Some((slide, body)) = notes_draft {
                    d.selection.slide = slide;
                    self.notes_buf = (d.uid, slide, crate::notes::Draft { text: body.text(), body, edited: true });
                    self.recovered_notes_pending = true;
                    self.ui.notes = true;
                    self.ui.view = crate::ViewMode::Normal;
                }
                Ok(json!({"documentId": outcome.document_id.to_string(), "revision": d.revision.to_string()}))
            }
            "host.profile" => Ok(json!({"version": 1, "ui": self.ui, "prefs": self.session.prefs})),
            "host.applyProfile" => {
                let ui = serde_json::from_value::<crate::UiState>(p.get("ui").cloned().ok_or("UI profile required")?).map_err(|e| e.to_string())?;
                let prefs = serde_json::from_value::<deckcraft_engine::Prefs>(p.get("prefs").cloned().ok_or("Preferences required")?)
                    .map_err(|e| e.to_string())?;
                self.ui = ui.sanitized();
                self.session.prefs = prefs.sanitized();
                self.restyle = true;
                Ok(json!({"version": 1}))
            }
            _ => Err("Unknown document host operation".into()),
        }
    }

    pub(crate) fn host_autosave_eligible(&self) -> bool {
        self.host_documents
            && self.host_pause.is_none()
            && self.dialog.is_none()
            && self.backstage.is_none()
            && self.pending_host_saves.is_empty()
            && !self.notes_buf.2.edited
            && self.ime_composition.is_none()
            && self.ime_terminal_pending.is_none()
            && self
                .session
                .active()
                .is_some_and(|d| d.path.is_some() && d.composition.is_none() && d.interaction.is_none() && d.selection.text.is_none())
    }

    pub(crate) fn notes_fingerprint(&self) -> String {
        if self.notes_buf.2.edited {
            json!([self.notes_buf.0.to_string(), self.notes_buf.1, self.notes_buf.2.body]).to_string()
        } else {
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::{Services, Session};

    fn hosted() -> SlideApp {
        let mut app = SlideApp::new(
            Session::new(),
            Services { host_request: Some(Box::new(|_, _, _, _| {})), host_save: Some(Box::new(|_, _, _, _| Ok(()))), ..Default::default() },
        );
        app.start_for_host().unwrap();
        app.run("host.configure", json!({})).unwrap();
        app.run("app.backstage", json!({"on":false})).unwrap();
        app
    }

    #[test]
    fn host_clean_blank_is_quiet_but_explicitly_saveable() {
        let mut app = hosted();
        assert!(!app.session.doc().unwrap().is_dirty());
        let result = app.run("host.prepareSave", json!({"path":"Documents/Blank.pptx"})).unwrap();
        assert_eq!(result["pending"], "save");
        assert!(!app.pending_host_saves.is_empty());
        // Generic delivery acknowledgements cannot finalize document-host writes.
        app.services.inbox = Some(Default::default());
        app.services.inbox.as_ref().unwrap().lock().unwrap().push(crate::InboxEvent::HostSaved { id: result["id"].as_str().unwrap().to_string() });
        app.drain_inbox();
        assert_eq!(app.pending_host_saves.len(), 1);
        app.run("host.acknowledgeSave", json!({"id":result["id"],"path":"Documents/Blank.pptx"})).unwrap();
        assert_eq!(app.session.doc().unwrap().path.as_deref(), Some("Documents/Blank.pptx"));
        assert!(!app.session.doc().unwrap().is_dirty());
        assert!(app.run("host.acknowledgeSave", json!({"id":result["id"],"path":"Documents/Blank.pptx"})).is_err());
    }

    #[test]
    fn host_canonical_save_keeps_later_edits_and_undo() {
        let mut app = hosted();
        app.run("slide.new", json!({})).unwrap();
        let result = app.run("host.prepareSave", json!({"path":"Talks/Two.pptx"})).unwrap();
        app.run("slide.new", json!({})).unwrap();
        app.run("host.acknowledgeSave", json!({"id":result["id"],"path":"Talks/Two.pptx"})).unwrap();
        assert_eq!(app.session.doc().unwrap().doc.slides.len(), 3);
        assert!(app.session.doc().unwrap().is_dirty());
        app.run("edit.undo", json!({})).unwrap();
        assert_eq!(app.session.doc().unwrap().doc.slides.len(), 2);
        assert!(!app.session.doc().unwrap().is_dirty());
        assert_eq!(app.session.doc().unwrap().path.as_deref(), Some("Talks/Two.pptx"));
    }

    #[test]
    fn host_recovery_keeps_pending_formatted_notes_and_media_without_changing_live_document() {
        let mut app = hosted();
        app.run("slide.new", json!({})).unwrap();
        let uid = app.session.doc().unwrap().uid;
        let body = deckcraft_model::text::TextBody {
            paragraphs: vec![deckcraft_model::text::Paragraph::new("Pending speaker notes")],
            ..Default::default()
        };
        app.notes_buf = (uid, 1, crate::notes::Draft { text: body.text(), body: body.clone(), edited: true });
        let _ = Arc::make_mut(&mut app.session.active_mut().unwrap().doc).add_media("original.png", "image/png", vec![1, 2, 3, 4]);
        let before = app.session.doc().unwrap().doc.clone();
        let revision = app.session.doc().unwrap().revision;
        let snapshot = app.run("host.snapshot", json!({})).unwrap();
        assert!(Arc::ptr_eq(&before, &app.session.doc().unwrap().doc));
        assert_eq!(app.session.doc().unwrap().revision, revision);
        assert!(app.notes_buf.2.edited);
        let bytes = deckcraft_engine::cmd::base64_decode(snapshot["data"].as_str().unwrap()).unwrap();
        let recovered = deckcraft_engine::cmd::file::loaded_file("recovered.deckcraft", &bytes).unwrap();
        assert_eq!(recovered.doc.slides.len(), 2);
        assert_eq!(recovered.doc.slides[1].notes.text(), "");
        assert_eq!(recovered.doc.media[0].data.as_slice(), &[1, 2, 3, 4]);
        assert_eq!(before.slides[1].notes.text(), "");
        let mut restored = hosted();
        let blank = restored.session.doc().unwrap().uid;
        let mut invalid = snapshot.clone();
        invalid["notesDraft"]["slide"] = json!(100);
        assert!(restored.run("host.restore", json!({"snapshot":invalid})).is_err());
        assert_eq!(restored.session.doc().unwrap().uid, blank);
        restored.run("host.restore", json!({"snapshot":snapshot})).unwrap();
        assert_eq!(restored.session.documents().len(), 1);
        assert!(restored.session.doc().unwrap().is_dirty());
        assert_eq!(restored.session.doc().unwrap().path, None);
        assert_eq!(restored.session.doc().unwrap().selection.slide, 1);
        let ctx = egui::Context::default();
        let mut frame = ctx.run_ui(egui::RawInput::default(), |ui| crate::status::notes_pane(&mut restored, ui));
        frame.textures_delta.clear(); // This headless test has no renderer.
        assert!(restored.notes_buf.2.edited);
        assert_eq!(restored.notes_buf.2.body, body);
        assert_eq!(restored.session.doc().unwrap().doc.slides[1].notes.text(), "");
        restored.flush_host_notes().unwrap();
        assert!(!restored.notes_buf.2.edited);
        assert_eq!(restored.session.doc().unwrap().doc.slides[1].notes, body);
    }

    #[test]
    fn host_pause_lease_rechecks_pending_notes_and_blocks_control_mutation() {
        let mut app = hosted();
        let revision = app.session.doc().unwrap().revision.to_string();
        assert!(app.run("host.pause", json!({"lease":"one","revision":revision,"pendingNotes":"stale"})).is_err());
        app.run("host.pause", json!({"lease":"one","revision":revision,"pendingNotes":""})).unwrap();
        assert!(app.run("slide.new", json!({})).is_err());
        let ctx = egui::Context::default();
        let (req, _) = crate::ControlRequest::new("ui.text", json!({"text":"blocked"}));
        let crate::control::Outcome::Done(response) = crate::control::handle(&mut app, &ctx, &req) else { panic!("Expected synchronous denial") };
        assert_eq!(response["ok"], false);
        assert!(app.run("host.pause", json!({"lease":"other","paused":false})).is_err());
        app.run("host.pause", json!({"lease":"one","paused":false})).unwrap();
        app.run("slide.new", json!({})).unwrap();
    }

    #[test]
    fn host_new_open_close_are_requests_and_keep_native_document() {
        let mut app = hosted();
        let uid = app.session.doc().unwrap().uid;
        for command in ["file.new", "file.open", "file.close", "app.openDialog", "app.saveAsDialog"] {
            let result = app.run(command, json!({})).unwrap();
            assert!(result.get("requested").is_some());
            assert_eq!(app.session.doc().unwrap().uid, uid);
            assert_eq!(app.session.documents().len(), 1);
        }
        assert!(app.run("view.newWindow", json!({})).is_err());
    }

    #[test]
    fn host_profile_is_explicit_native_schema_and_is_sanitized() {
        let mut app = hosted();
        let mut value = app.run("host.profile", json!({})).unwrap();
        value["prefs"]["undoLimit"] = json!(0);
        value["ui"]["recent"] = json!(["Documents/Own.pptx"]);
        app.run("host.applyProfile", value).unwrap();
        assert!(app.session.prefs.undo_limit > 0);
        assert_eq!(app.ui.recent, vec!["Documents/Own.pptx"]);
        assert!(hosted().ui.recent.is_empty());
    }

    #[test]
    fn host_two_slide_pptx_keeps_theme_text_image_and_notes() {
        use std::cell::RefCell;
        use std::rc::Rc;
        let mut app = hosted();
        let bytes = Rc::new(RefCell::new(Vec::new()));
        let sink = bytes.clone();
        app.services.host_save = Some(Box::new(move |_, data, _, _| {
            *sink.borrow_mut() = data.to_vec();
            Ok(())
        }));
        let chosen = deckcraft_model::theme::builtin_themes().get(1).unwrap().name.clone();
        app.run("design.theme", json!({"name": chosen})).unwrap();
        app.run("shape.insert", json!({"preset":"rect","rect":[60,60,600,100],"text":"A native presentation"})).unwrap();
        app.run("slide.new", json!({"layout":"blank"})).unwrap();
        app.run("shape.insert", json!({"preset":"rect","rect":[60,60,600,150],"text":"Second slide body"})).unwrap();
        let png = deckcraft_render::Image { width: 2, height: 2, pixels: [42, 90, 180, 255].repeat(4) }.to_png();
        app.run("insert.picture", json!({"name":"original.png","data":deckcraft_engine::cmd::base64_encode(&png),"rect":[80,250,160,160]})).unwrap();
        app.run("slide.notes", json!({"index":1,"text":"Explain the second slide"})).unwrap();
        app.run("host.prepareSave", json!({"path":"Talks/Two.pptx"})).unwrap();
        let reopened = deckcraft_engine::cmd::file::loaded_file("Two.pptx", &bytes.borrow()).unwrap();
        assert_eq!(reopened.doc.slides.len(), 2);
        assert_eq!(reopened.doc.masters[0].theme.name, chosen);
        for (index, expected) in [(0, "A native presentation"), (1, "Second slide body")] {
            assert!(reopened.doc.slides[index].shapes.iter().filter_map(|shape| shape.text.as_ref()).any(|body| body.text() == expected));
            let (rendered, width, height) = deckcraft_engine::cmd::file::render_png(&reopened.doc, index, 0.25, false);
            assert!(rendered.starts_with(b"\x89PNG"));
            assert!(width > 0 && height > 0);
        }
        assert_eq!(reopened.doc.slides[1].notes.text(), "Explain the second slide");
        assert!(reopened.doc.media.iter().any(|media| media.data.as_slice() == png.as_slice()));
    }

    #[test]
    fn host_snapshot_refuses_unsupported_dialogs_and_unavailable_external_media() {
        let mut app = hosted();
        app.dialog = Some(crate::dialogs::Dialog::new("pendingText"));
        assert!(app.run("host.snapshot", json!({})).unwrap_err().contains("Finish"));
        app.dialog = None;
        let doc = Arc::make_mut(&mut app.session.active_mut().unwrap().doc);
        let _ = doc.add_media("linked.mp4", "video/mp4", vec![]);
        doc.media[0].link = Some("/unavailable/local.mp4".into());
        assert!(app.run("host.snapshot", json!({})).unwrap_err().contains("embedded media"));
        assert!(app.run("file.recovery.open", json!({})).is_err());
    }

    #[test]
    fn host_autosave_never_settles_pending_native_typing_or_creates_unnamed_files() {
        let mut app = hosted();
        assert!(!app.host_autosave_eligible());
        app.run("slide.new", json!({})).unwrap();
        let saved = app.run("host.prepareSave", json!({"path":"Talks/Auto.pptx"})).unwrap();
        app.run("host.acknowledgeSave", json!({"id":saved["id"],"path":"Talks/Auto.pptx"})).unwrap();
        app.run("slide.new", json!({})).unwrap();
        let uid = app.session.doc().unwrap().uid;
        app.notes_buf = (uid, 0, crate::notes::Draft { edited: true, ..Default::default() });
        let revision = app.session.doc().unwrap().revision.to_string();
        assert!(!app.host_autosave_eligible());
        let blocked = app.run("host.autosave", json!({"revision":revision,"path":"Talks/Auto.pptx"})).unwrap();
        assert_eq!(blocked["status"], "busy");
        assert!(app.notes_buf.2.edited);
        assert_eq!(app.session.doc().unwrap().revision.to_string(), revision);
        assert!(app.pending_host_saves.is_empty());
        app.notes_buf.2.edited = false;
        let stale = app.run("host.autosave", json!({"revision":"0","path":"Talks/Auto.pptx"})).unwrap();
        assert_eq!(stale["status"], "busy");
        let prepared = app.run("host.autosave", json!({"revision":revision,"path":"Talks/Auto.pptx"})).unwrap();
        assert_eq!(prepared["pending"], "save");
    }

    #[test]
    fn host_close_finalizer_only_closes_view_owned_presenter_under_matching_lease() {
        use std::cell::Cell;
        use std::rc::Rc;
        struct Presenter(Rc<Cell<bool>>);
        impl crate::presenter::Host for Presenter {
            fn open(&mut self) -> Result<(), String> {
                Ok(())
            }
            fn is_open(&self) -> bool {
                !self.0.get()
            }
            fn commands(&mut self) -> Vec<crate::presenter::Command> {
                vec![]
            }
            fn update(&mut self, _: crate::presenter::Snapshot) {}
            fn close(&mut self) {
                self.0.set(true);
            }
        }
        let closed = Rc::new(Cell::new(false));
        let mut app = hosted();
        app.services.presenter = Some(Box::new(Presenter(closed.clone())));
        assert!(app.run("host.finalizeClose", json!({"lease":"one"})).is_err());
        assert!(!closed.get());
        let revision = app.session.doc().unwrap().revision.to_string();
        app.run("host.pause", json!({"lease":"one","revision":revision,"pendingNotes":""})).unwrap();
        assert!(app.run("host.finalizeClose", json!({"lease":"other"})).is_err());
        assert!(!closed.get());
        app.run("host.finalizeClose", json!({"lease":"one"})).unwrap();
        assert!(closed.get());
    }
}
