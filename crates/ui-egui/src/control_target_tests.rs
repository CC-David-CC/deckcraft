//! Exact document preconditions are checked when a queued operation is dispatched.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::{Services, Session, SlideApp, control};
use serde_json::{Value, json};

fn call(app: &mut SlideApp, method: &str, params: Value) -> Value {
    let (request, _reply) = control::ControlRequest::new(method, params);
    match control::handle(app, &egui::Context::default(), &request) {
        control::Outcome::Done(answer) => answer,
        _ => panic!("this test does not request a screenshot"),
    }
}

#[test]
fn queued_explicit_target_cannot_follow_focus_into_another_document() {
    let mut app = SlideApp::new(Session::with_new(), Services::default());
    let origin = app.session.doc().unwrap().uid.to_string();
    let (request, _reply) = control::ControlRequest::new(
        "engine.execute",
        json!({
            "documentId":origin, "command":"shape.insert", "params":{"preset":"rect","rect":[10,10,100,50]}
        }),
    );
    app.run("file.new", json!({})).unwrap();
    let before = app.session.documents().iter().map(|d| (d.uid, d.revision, d.doc.slides[0].shapes.len())).collect::<Vec<_>>();
    let active = app.session.doc().unwrap().uid;
    let control::Outcome::Done(answer) = control::handle(&mut app, &egui::Context::default(), &request) else { panic!("a command result") };
    assert_eq!(answer["ok"], false, "a captured target must not be silently replaced by current focus");
    assert_eq!(app.session.doc().unwrap().uid, active);
    assert_eq!(app.session.documents().iter().map(|d| (d.uid, d.revision, d.doc.slides[0].shapes.len())).collect::<Vec<_>>(), before);
}

#[test]
fn malformed_unknown_and_conflicting_targets_do_not_run_commands_or_inspections() {
    let mut app = SlideApp::new(Session::with_new(), Services::default());
    let uid = app.session.doc().unwrap().uid.to_string();
    for target in [
        Value::Null,
        json!(7),
        json!(true),
        json!(""),
        json!("+1"),
        json!("0".to_owned() + &uid),
        json!("x".repeat(4096)),
        json!("18446744073709551616"),
    ] {
        for method in ["engine.execute", "ui.menu.invoke", "command", "document.inspect"] {
            let answer =
                call(&mut app, method, json!({"documentId":target,"command":"shape.insert","params":{"preset":"rect","rect":[10,10,100,50]}}));
            assert_eq!(answer["ok"], false, "{method} must reject an invalid explicit identity");
        }
    }
    app.run("file.new", json!({})).unwrap();
    let active = app.session.doc().unwrap().uid.to_string();
    let before = app.session.documents().len();
    let answer = call(&mut app, "engine.execute", json!({"documentId":active,"command":"file.close","params":{"documentId":uid}}));
    assert_eq!(answer["ok"], false, "an inner target cannot override the authorized outer target");
    assert_eq!(app.session.documents().len(), before);
}

#[test]
fn matching_target_and_legacy_calls_use_the_real_command_and_inspection_path() {
    let mut app = SlideApp::new(Session::with_new(), Services::default());
    let uid = app.session.doc().unwrap().uid.to_string();
    let revision = app.session.doc().unwrap().revision;
    let answer =
        call(&mut app, "engine.execute", json!({"documentId":uid,"command":"shape.insert","params":{"preset":"rect","rect":[10,10,100,50]}}));
    assert_eq!(answer["ok"], true);
    assert_ne!(app.session.doc().unwrap().revision, revision);
    let inspected = call(&mut app, "document.inspect", json!({"documentId":uid}));
    assert_eq!(inspected["result"]["documentId"], uid);
    let ui = call(&mut app, "ui.inspect", json!({}));
    assert_eq!(ui["result"]["documentTargeting"], "active-precondition-v1");
    assert_eq!(ui["result"]["documentId"], uid);
    assert_eq!(ui["result"]["documents"][0]["documentId"], uid);
    assert_eq!(ui["result"]["documents"][0]["revision"], app.session.doc().unwrap().revision.to_string());
    assert_eq!(call(&mut app, "document.inspect", json!({}))["ok"], true, "old local callers stay explicit about using current focus");
}

#[test]
fn stale_save_dispatches_no_host_bytes_and_matching_save_keeps_its_identity() {
    use std::{cell::RefCell, rc::Rc};
    let sent = Rc::new(RefCell::new(Vec::new()));
    let capture = sent.clone();
    let services = Services {
        host_save: Some(Box::new(move |_: &str, _: &[u8], _: bool, context: &crate::HostSaveContext| {
            capture.borrow_mut().push(context.clone());
            Ok(())
        })),
        ..Services::default()
    };
    let mut app = SlideApp::new(Session::with_new(), services);
    let first = app.session.doc().unwrap().uid.to_string();
    app.run("file.new", json!({})).unwrap();
    app.run("shape.insert", json!({"preset":"rect","rect":[10,10,100,50]})).unwrap();
    let active = app.session.doc().unwrap().uid;
    let response = call(&mut app, "engine.execute", json!({"documentId":first,"command":"file.save","params":{}}));
    assert_eq!(response["ok"], false);
    assert!(sent.borrow().is_empty(), "stale dispatch must not hand another document's bytes to a storage host");
    assert!(app.pending_host_saves.is_empty());
    assert!(app.session.doc().unwrap().is_dirty());
    let response = call(&mut app, "engine.execute", json!({"documentId":active.to_string(),"command":"file.save","params":{}}));
    assert_eq!(response["ok"], true);
    assert_eq!(sent.borrow().len(), 1);
    assert_eq!(sent.borrow()[0].document, active);
    assert_eq!(response["result"]["id"], sent.borrow()[0].id);
    assert!(app.session.doc().unwrap().is_dirty(), "dispatch remains distinct from confirmed storage");
}
