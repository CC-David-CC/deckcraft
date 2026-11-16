//! Saved revisions must follow the captured document rather than the active view.
#![allow(clippy::unwrap_used)]
use crate::{
    Session,
    cmd::file::{capture_save, confirm_saved},
};
use serde_json::json;

#[test]
fn host_acknowledgement_marks_only_the_serialized_version_saved() {
    let mut session = Session::with_new();
    session.execute("slide.new", &json!({})).unwrap();
    let snapshot = capture_save(&session).unwrap();
    session.execute("slide.new", &json!({})).unwrap();
    assert!(confirm_saved(&mut session, &snapshot, "saved.deckcraft".into()).unwrap());
    let doc = session.doc().unwrap();
    assert!(doc.is_dirty(), "the later edit has not been saved");
    assert_eq!(doc.saved_doc.slides.len() + 1, doc.doc.slides.len());
    assert_eq!(doc.path.as_deref(), Some("saved.deckcraft"));
}

#[test]
fn host_acknowledgement_does_not_follow_a_document_switch() {
    let mut session = Session::with_new();
    session.execute("slide.new", &json!({})).unwrap();
    let snapshot = capture_save(&session).unwrap();
    session.execute("file.new", &json!({})).unwrap();
    let other = session.doc().unwrap().uid;
    assert!(confirm_saved(&mut session, &snapshot, "first.deckcraft".into()).unwrap());
    assert_eq!(session.doc().unwrap().uid, other);
    assert_eq!(session.doc().unwrap().path, None);
    let first = session.documents().iter().find(|d| d.uid == snapshot.document_id()).unwrap();
    assert!(!first.is_dirty());
    assert_eq!(first.path.as_deref(), Some("first.deckcraft"));
}

#[test]
fn a_closed_document_and_a_changed_source_are_not_retargeted() {
    let mut session = Session::with_new();
    let snapshot = capture_save(&session).unwrap();
    session.doc_mut().unwrap().path = Some("different.deckcraft".into());
    assert!(confirm_saved(&mut session, &snapshot, "old.deckcraft".into()).is_err());
    assert_eq!(session.doc().unwrap().path.as_deref(), Some("different.deckcraft"));
    session.close_document(0);
    session.execute("file.new", &json!({})).unwrap();
    assert!(!confirm_saved(&mut session, &snapshot, "old.deckcraft".into()).unwrap());
    assert_eq!(session.doc().unwrap().path, None);
}

#[test]
fn closing_an_explicit_document_preserves_the_other_active_document() {
    let mut session = Session::with_new();
    let first = session.doc().unwrap().uid;
    session.execute("file.new", &json!({})).unwrap();
    let other = session.doc().unwrap().uid;
    session.execute("file.close", &json!({"documentId": first.to_string()})).unwrap();
    assert_eq!(session.doc().unwrap().uid, other);
    assert!(session.execute("file.close", &json!({"documentId": first.to_string()})).is_err());
    assert_eq!(session.doc().unwrap().uid, other);
}
