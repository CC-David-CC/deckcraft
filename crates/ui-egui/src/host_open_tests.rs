//! Correlated host outcomes use the same adoption and blank-cleanup path as old opens.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use crate::{Services, Session, SlideApp};
use serde_json::json;
fn data() -> Vec<u8> {
    deckcraft_engine::cmd::file::save_bytes(&Session::with_new().doc().unwrap().doc, "deckcraft").unwrap()
}
fn app() -> SlideApp {
    let mut app = SlideApp::new(Session::new(), Services::default());
    app.start_for_host().unwrap();
    app
}

#[test]
fn host_outcome_identifies_the_loaded_document_after_blank_removal_and_later_focus() {
    let mut app = app();
    let blank = app.session.doc().unwrap().uid;
    let opened = app.open_from_host(Some("Account.deckcraft"), &data()).unwrap();
    assert_eq!(app.session.documents().len(), 1);
    assert_ne!(opened.document_id, blank);
    assert_eq!(opened.document_id, app.session.doc().unwrap().uid);
    assert_eq!(opened.revision, app.session.doc().unwrap().revision);
    assert_eq!(opened.source_path.as_deref(), Some("Account.deckcraft"));
    app.run("file.new", json!({})).unwrap();
    assert_ne!(opened.document_id, app.session.doc().unwrap().uid);
    assert!(app.session.documents().iter().any(|d| d.uid == opened.document_id && d.path == opened.source_path));
}
#[test]
fn an_edited_initial_blank_is_not_discarded_by_account_adoption() {
    let mut app = app();
    let blank = app.session.doc().unwrap().uid;
    app.run("slide.new", json!({})).unwrap();
    let opened = app.open_from_host(Some("Account.deckcraft"), &data()).unwrap();
    assert_eq!(app.session.documents().len(), 2);
    assert!(app.session.documents().iter().any(|d| d.uid == blank && d.is_dirty()));
    assert_ne!(opened.document_id, blank);
}
#[test]
fn failed_open_does_not_consume_the_untouched_startup_blank() {
    let mut app = app();
    let blank = app.session.doc().unwrap().uid;
    assert!(app.open_from_host(Some("Broken.deckcraft"), &[0, 1, 2]).is_err());
    assert_eq!(app.session.documents().len(), 1);
    assert_eq!(app.session.doc().unwrap().uid, blank);
    let opened = app.open_from_host(Some("Account.deckcraft"), &data()).unwrap();
    assert_eq!(app.session.documents().len(), 1);
    assert_ne!(opened.document_id, blank);
}
#[test]
fn unnamed_and_converted_inputs_report_source_less_outcomes() {
    let mut app = app();
    let unnamed = app.open_from_host(None, &data()).unwrap();
    assert_eq!(unnamed.source_path, None);
    let converted = app.open_from_host(Some("Source.md"), b"# One\n\n# Two\n").unwrap();
    assert_eq!(converted.source_path, None);
    assert_eq!(converted.document_id, app.session.doc().unwrap().uid);
}
