//! Identity is returned by the creating operation, not inferred from later focus or indices.
use crate::{Session, cmd};
use serde_json::{Value, json};

fn bytes() -> Vec<u8> {
    cmd::file::save_bytes(&Session::with_new().doc().unwrap().doc, "deckcraft").unwrap()
}
fn adopt(session: &mut Session, name: &str, data: &[u8]) -> Value {
    let file = cmd::file::loaded_file(name, data).unwrap();
    let token = session.stage_loaded(file);
    session.execute("file.adopt", &json!({"path":name,"token":token})).unwrap()
}
fn identity(session: &Session, value: &Value) {
    let state = session.doc().unwrap();
    assert_eq!(value["documentId"], state.uid.to_string());
    assert_eq!(value["revision"], state.revision.to_string());
    assert_eq!(value["path"], json!(state.path));
}

#[test]
fn created_identity_survives_focus_changes_and_document_index_shifts() {
    let mut session = Session::with_new();
    let created = session.execute("file.new", &json!({})).unwrap();
    identity(&session, &created);
    let uid = session.doc().unwrap().uid;
    let other = session.execute("file.new", &json!({})).unwrap();
    identity(&session, &other);
    session.close_document(0);
    assert_ne!(session.doc().unwrap().uid, uid);
    assert_eq!(created["documentId"], uid.to_string());
    assert_eq!(session.documents()[0].uid, uid, "A stable identity is not the old list index");
    assert_eq!(created["path"], Value::Null);
}

#[test]
fn adopted_identity_includes_retained_source_and_real_revision() {
    let mut session = Session::with_new();
    let opened = adopt(&mut session, "Account.deckcraft", &bytes());
    identity(&session, &opened);
    assert_eq!(opened["path"], "Account.deckcraft");
    let uid = session.doc().unwrap().uid;
    session.execute("file.new", &json!({})).unwrap();
    session.close_document(0);
    assert_eq!(session.documents()[0].uid, uid);
    assert_eq!(opened["documentId"], uid.to_string());
}

#[test]
fn raw_bytes_open_returns_identity_but_does_not_adopt_a_source_path() {
    let mut session = Session::with_new();
    let opened = session.execute("file.openBytes", &json!({"name":"Copy.deckcraft","data":cmd::base64_encode(&bytes())})).unwrap();
    identity(&session, &opened);
    assert_eq!(opened["path"], Value::Null);
}

#[test]
fn converted_adoption_returns_an_identity_without_overwrite_authority() {
    let mut session = Session::with_new();
    let opened = adopt(&mut session, "Source.md", b"# One\n\n# Two\n");
    identity(&session, &opened);
    assert_eq!(opened["path"], Value::Null);
    assert_eq!(session.doc().unwrap().doc.slides.len(), 2);
}

#[test]
fn repaired_adoption_returns_identity_and_preserves_the_original_source() {
    let mut document = crate::model::Presentation::default();
    document.add_media("image.png", "image/png", b"OWNED-TEST-MEDIA-0123456789".to_vec());
    let mut data = cmd::file::save_bytes(&document, "deckcraft").unwrap();
    let marker = b"OWNED-TEST-MEDIA-";
    let at = data.windows(marker.len()).position(|v| v == marker).unwrap();
    data[at] ^= 0xff;
    let mut session = Session::with_new();
    let opened = adopt(&mut session, "Original.deckcraft", &data);
    identity(&session, &opened);
    assert_eq!(opened["path"], Value::Null);
    assert!(!opened["damagedMedia"].as_array().unwrap().is_empty());
    assert!(session.doc().unwrap().title().ends_with("(Repaired)"));
}
