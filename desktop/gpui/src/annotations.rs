// Browser annotations (browser.annotate): Annotate over a page shown inside
// the app, a port of EmbeddedBrowserAnnotations.swift and AnnotatedWebPanel.
//
// The tools are the Swift app's script (threadbear_core::annotations), run in
// an isolated world of the page already in the pane, through the page's own
// DevTools channel (threadbear_web::PanelPage). No browser window opens. One
// page at a time: the tools are asked every 200 ms what they hold, and Attach
// puts the comment, the page's context and a screenshot after the original
// thread's draft, sending nothing. The page going (another thread, a closed
// preview, a navigation, the pool dropping it) ends the session and closes
// the tools.
use crate::app::Threadbear;
use crate::highlights::palette;
use crate::push_button::PushButton;
use crate::style::{self, px};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;
use threadbear_core::annotations::{self as rules, Reading};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::reducer::ImageRef;
use threadbear_web::PanelPage;

/// The status line's height, whatever its words.
const STATUS_HEIGHT: f32 = 40.;

const ANNOTATE_TIP: &str = "Select elements or draw on this page, here in Threadbear";
const CANCEL_TIP: &str = "Close the annotation tools without changing your draft";

/// The session under way.
struct Active {
    key: String,
    thread: String,
    session: String,
    page: Rc<PanelPage>,
    /// The tools' world in the page, once it's made.
    context: Rc<Cell<Option<i64>>>,
    task: Option<Task<()>>,
}

impl Active {
    /// Closes this session's tools in the page, if they opened. Sent, not
    /// waited for.
    fn close_tools(&self) {
        if let Some(context) = self.context.get() {
            drop(self.page.devtools("Runtime.evaluate", json!({ "expression": rules::finish_expression(&self.session), "contextId": context, "returnByValue": true })));
        }
    }
}

/// The status line's words, for one thread's page.
struct Said {
    thread: String,
    key: String,
    words: String,
}

pub(crate) struct Annotations {
    app: Option<WeakEntity<Threadbear>>,
    active: Option<Active>,
    said: Option<Said>,
}

struct Shared(Entity<Annotations>);
impl Global for Shared {}

pub(crate) fn init(cx: &mut App) {
    let entity = cx.new(|_| Annotations { app: None, active: None, said: None });
    cx.set_global(Shared(entity.clone()));
    cx.observe_new(move |_: &mut Threadbear, _: Option<&mut Window>, cx: &mut Context<Threadbear>| {
        let app = cx.entity().downgrade();
        entity.update(cx, |a, _| a.app = Some(app));
        cx.observe(&entity, |_, _, cx| cx.notify()).detach();
    })
    .detach();
}

fn shared(cx: &App) -> Option<Entity<Annotations>> {
    cx.try_global::<Shared>().map(|s| s.0.clone())
}

impl Threadbear {
    /// The browserAnnotations experiment is on for this Mac's runner:
    /// Settings' switch first, else the hello's list (as `open_anything_on`).
    pub(crate) fn annotations_on(&self) -> bool {
        let id = rules::EXPERIMENT;
        let switch = self.runner_settings.as_ref().and_then(|s| s["experiments"].as_array()?.iter().find(|e| e["id"] == id).map(|e| e["on"].as_bool() == Some(true)));
        switch.unwrap_or_else(|| self.remote.experiments.iter().any(|e| e == id))
    }

    /// Whether `thread`'s pages can be annotated: this Mac's threads, with
    /// the experiment on.
    pub(crate) fn annotates(&self, thread: &ThreadSummary) -> bool {
        !thread.is_remote() && self.annotations_on()
    }
}

/// How a session ends early.
enum Stop {
    /// With nothing said: cancelled, or its page or thread went from view.
    Quiet,
    Say(String),
}

impl From<&str> for Stop {
    fn from(words: &str) -> Stop {
        Stop::Say(words.to_owned())
    }
}

/// 128 random bits as hex, as a session's id.
fn token() -> String {
    use std::hash::{BuildHasher as _, Hasher as _};
    let half = || std::collections::hash_map::RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", half(), half())
}

impl Annotations {
    fn say(&mut self, thread: &str, key: &str, words: &str, cx: &mut Context<Self>) {
        self.said = Some(Said { thread: thread.to_owned(), key: key.to_owned(), words: words.to_owned() });
        cx.notify();
    }

    /// Annotate on the page shown under `key` in `thread`'s pane. `source`
    /// is a local page's own file address, which stands for the private one
    /// it's served from.
    pub(crate) fn start(&mut self, key: String, source: Option<String>, thread: String, cx: &mut Context<Self>) {
        if self.active.is_some() {
            return;
        }
        let Some(app) = self.app.clone() else { return };
        let allowed = app.read_with(cx, |app, _| app.threads.get(&thread).is_some_and(|t| app.annotates(t))).unwrap_or(false);
        if !allowed {
            return self.say(&thread, &key, rules::LOCAL_ONLY, cx);
        }
        let page = match crate::web_panels::shown_page(&key, cx) {
            Some((page, true)) if !page.loading() => page,
            _ => return self.say(&thread, &key, rules::STILL_LOADING, cx),
        };
        let session = token();
        let context = Rc::new(Cell::new(None));
        self.say(&thread, &key, rules::OPENING, cx);
        let task = cx.spawn({
            let (page, key, thread, session, context) = (page.clone(), key.clone(), thread.clone(), session.clone(), context.clone());
            async move |this, cx| {
                let outcome = run(&app, &this, &page, &key, source, &thread, &session, &context, cx).await;
                this.update(cx, |a, cx| a.ended(&session, outcome, cx)).ok();
            }
        });
        self.active = Some(Active { key, thread, session, page, context, task: Some(task) });
        cx.notify();
    }

    fn ended(&mut self, session: &str, outcome: Result<Option<String>, Stop>, cx: &mut Context<Self>) {
        if self.active.as_ref().is_none_or(|a| a.session != session) {
            return;
        }
        let Some(mut active) = self.active.take() else { return };
        // This is that task, at its end.
        if let Some(task) = active.task.take() {
            task.detach();
        }
        active.close_tools();
        match outcome {
            Ok(Some(words)) | Err(Stop::Say(words)) => self.say(&active.thread, &active.key, &words, cx),
            Ok(None) | Err(Stop::Quiet) => self.said = None,
        }
        cx.notify();
    }

    /// Cancel annotation: the tools close and the draft is as it was.
    pub(crate) fn cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(active) = self.active.take() {
            active.close_tools();
            self.said = None;
            cx.notify();
        }
    }

    fn active_on(&self, thread: &str, key: &str) -> bool {
        self.active.as_ref().is_some_and(|a| a.thread == thread && a.key == key)
    }

    fn words_for(&self, thread: &str, key: &str) -> String {
        self.said.as_ref().filter(|s| s.thread == thread && s.key == key).map(|s| s.words.clone()).unwrap_or_default()
    }
}

async fn devtools(page: &PanelPage, method: &str, params: Value, cx: &mut AsyncApp) -> Result<Value, Stop> {
    let answer = page.devtools(method, params);
    let timeout = cx.background_executor().timer(Duration::from_secs(10));
    futures::pin_mut!(answer, timeout);
    match futures::future::select(answer, timeout).await {
        futures::future::Either::Left((Ok(Ok(value)), _)) => Ok(value),
        futures::future::Either::Left(_) => Err(rules::STOPPED.into()),
        futures::future::Either::Right(_) => Err("The page didn't answer in time. Try Annotate again.".into()),
    }
}

/// A script's value, run in the tools' world.
async fn evaluate(page: &PanelPage, expression: &str, context: i64, cx: &mut AsyncApp) -> Result<Value, Stop> {
    let answer = devtools(page, "Runtime.evaluate", json!({ "expression": expression, "contextId": context, "returnByValue": true, "awaitPromise": true }), cx).await?;
    if answer.get("exceptionDetails").is_some() {
        return Err(rules::STOPPED.into());
    }
    Ok(answer["result"]["value"].clone())
}

/// Whether the session still has its thread on show and its page in the pane,
/// where it was when Annotate was pressed.
fn holds(app: &WeakEntity<Threadbear>, page: &Rc<PanelPage>, key: &str, thread: &str, started: &(String, u32), cx: &mut AsyncApp) -> Result<(), Stop> {
    app.read_with(cx, |app, cx| {
        if !app.threads.get(thread).is_some_and(|t| app.annotates(t)) {
            return Err(Stop::from(rules::THREAD_GONE));
        }
        if app.pane_thread().is_none_or(|t| t.id != thread) {
            return Err(Stop::Quiet);
        }
        match crate::web_panels::shown_page(key, cx) {
            Some((shown, true)) if Rc::ptr_eq(&shown, page) => Ok(()),
            _ => Err(Stop::Quiet),
        }
    })
    .map_err(|_| Stop::Quiet)??;
    if rules::page_changed((&started.0, started.1), (&page.address(), page.loads()), page.loading()) {
        return Err(rules::PAGE_CHANGED.into());
    }
    Ok(())
}

/// The page as it looks with its marks, kept by the runner as a picture.
/// None when it couldn't be taken or kept; the annotation still attaches.
async fn capture(app: &WeakEntity<Threadbear>, page: &PanelPage, session: &str, context: i64, cx: &mut AsyncApp) -> Result<Option<ImageRef>, Stop> {
    let Ok(shot) = devtools(page, "Page.captureScreenshot", json!({ "format": "png", "captureBeyondViewport": false }), cx).await else { return Ok(None) };
    let Some(bytes) = shot["data"].as_str().and_then(rules::screenshot) else { return Ok(None) };
    // Cancelled while it was taken: nothing attaches.
    if !rules::still_ready(&evaluate(page, rules::READ, context, cx).await?, session) {
        return Err(Stop::Quiet);
    }
    let Ok(client) = app.read_with(cx, |app, _| app.client.clone()) else { return Err(Stop::Quiet) };
    let Some(file) = crate::composer::stage_private(&crate::composer::paste_base(), &format!("annotation-{session}.png"), &bytes) else { return Ok(None) };
    let kept = crate::call(client, "media.import", json!({ "path": file.to_string_lossy() })).await;
    crate::composer::unstage(&file);
    Ok(kept.ok().and_then(|v| ImageRef::decode(&v["image"])))
}

#[allow(clippy::too_many_arguments)]
async fn run(app: &WeakEntity<Threadbear>, this: &WeakEntity<Annotations>, page: &Rc<PanelPage>, key: &str, source: Option<String>, thread: &str, session: &str, context: &Rc<Cell<Option<i64>>>, cx: &mut AsyncApp) -> Result<Option<String>, Stop> {
    let started = (page.address(), page.loads());
    let tree = devtools(page, "Page.getFrameTree", json!({}), cx).await?;
    let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or(Stop::from(rules::STILL_LOADING))?.to_owned();
    // The tools' own isolated world, apart from the page's scripts.
    let world = devtools(page, "Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": rules::WORLD, "grantUniveralAccess": false }), cx).await?;
    let id = world["executionContextId"].as_i64().ok_or(Stop::from("The page couldn't keep the annotation tools apart from its own scripts."))?;
    context.set(Some(id));
    evaluate(page, &rules::start_expression(session), id, cx).await?;
    this.update(cx, |a, cx| a.say(thread, key, rules::ACTIVE, cx)).map_err(|_| Stop::Quiet)?;
    loop {
        holds(app, page, key, thread, &started, cx)?;
        match rules::reading(&evaluate(page, rules::READ, id, cx).await?, session).map_err(Stop::Say)? {
            Reading::Active => {}
            Reading::Cancelled => return Ok(None),
            Reading::Ready(mut annotation) => {
                // A local page is named by its file's address.
                if let Some(source) = &source {
                    annotation.url = source.clone();
                }
                this.update(cx, |a, cx| a.say(thread, key, rules::ATTACHING, cx)).map_err(|_| Stop::Quiet)?;
                let images: Vec<ImageRef> = capture(app, page, session, id, cx).await?.into_iter().collect();
                holds(app, page, key, thread, &started, cx)?;
                if !rules::still_ready(&evaluate(page, rules::READ, id, cx).await?, session) {
                    return Err(Stop::Quiet);
                }
                let words = if images.is_empty() { rules::NO_SCREENSHOT } else { rules::ATTACHED };
                let text = annotation.draft_addition(images.len());
                let (window, composer) = app
                    .update(cx, |app, cx| {
                        app.append_to_draft(thread, text, images, cx);
                        (app.main_window, app.composers.get(thread).cloned())
                    })
                    .map_err(|_| Stop::Quiet)?;
                if let Some(composer) = composer {
                    cx.update_window(window, |_, window, cx| {
                        composer.update(cx, |c, cx| c.focus(window, cx));
                        crate::web_panels::keyboard_to_app(window);
                    })
                    .ok();
                }
                return Ok(Some(words.to_owned()));
            }
        }
        cx.background_executor().timer(Duration::from_millis(rules::POLL_MS)).await;
    }
}

thread_local! {
    /// The page last drawn with Annotate over it: its thread, key and source
    /// (the automation's `annotate` starts on it).
    static FRAMED: std::cell::RefCell<Option<(String, String, Option<String>)>> = const { std::cell::RefCell::new(None) };
}

/// The main window's frame starting: nothing's drawn with Annotate yet.
pub(crate) fn frame_started() {
    FRAMED.with(|f| *f.borrow_mut() = None);
}

/// `page` with Annotate over it and the status line under it
/// (`AnnotatedWebPanel`). `key` is the page's in the pool (web_panels.rs).
pub(crate) fn framed(thread: &ThreadSummary, key: String, source: Option<String>, page: AnyElement, cx: &mut App) -> AnyElement {
    let Some(annotations) = shared(cx) else { return page };
    FRAMED.with(|f| *f.borrow_mut() = Some((thread.id.clone(), key.clone(), source.clone())));
    let p = palette(cx);
    let (active, busy, words) = {
        let a = annotations.read(cx);
        (a.active_on(&thread.id, &key), a.active.is_some(), a.words_for(&thread.id, &key))
    };
    let button = if active {
        let annotations = annotations.clone();
        PushButton::new("annotate-cancel", "Cancel annotation", CANCEL_TIP).small().render(cx, move |_, _, cx| annotations.update(cx, |a, cx| a.cancel(cx)))
    } else {
        let (annotations, thread_id, key) = (annotations.clone(), thread.id.clone(), key.clone());
        // Another page's session holds this one's button until it ends.
        PushButton::new("annotate-start", "Annotate", ANNOTATE_TIP).small().busy(busy).render(cx, move |_, _, cx| annotations.update(cx, |a, cx| a.start(key.clone(), source.clone(), thread_id.clone(), cx)))
    };
    let bar = h_flex().flex_none().items_center().px(px(10.)).py(px(6.)).border_b_1().border_color(style::hairline(cx)).child(button);
    let status = crate::highlights::tipped_as(
        div().id("annotate-status").flex_none().h(px(STATUS_HEIGHT)).px(px(8.)).flex().items_center().text_size(px(style::size::LABEL)).text_color(p.secondary).child(div().line_clamp(2).child(words.clone())),
        words,
        gpui_kit::Role::GenericContainer,
    );
    v_flex().size_full().child(bar).child(div().flex_1().min_h_0().child(page)).child(status).into_any_element()
}

/// What the dump says of Annotate over the pane's page.
#[cfg(feature = "automation")]
pub(crate) fn dump(thread: &str, cx: &App) -> Value {
    let Some(annotations) = shared(cx) else { return Value::Null };
    let a = annotations.read(cx);
    let framed = FRAMED.with(|f| f.borrow().clone()).filter(|(t, ..)| t == thread);
    let Some((_, key, _)) = framed else { return Value::Null };
    json!({ "button": if a.active_on(thread, &key) { "Cancel annotation" } else { "Annotate" }, "active": a.active_on(thread, &key), "status": a.words_for(thread, &key), "key": key })
}

/// The automation's `annotate`: `start` or `cancel` on the page last drawn
/// with Annotate over it, as its button does; `tools` runs a script in the
/// tools' world; `open` is an address entered in the Browser pane's field;
/// anything else only reads. `context` is the tools' world, for DevTools.
#[cfg(feature = "automation")]
pub(crate) async fn automation(app: &WeakEntity<Threadbear>, cmd: &Value, cx: &mut AsyncApp) -> Result<Value, String> {
    let annotations = cx.update(|cx| shared(cx)).ok_or("no annotations")?;
    let framed = FRAMED.with(|f| f.borrow().clone());
    let needs_page = || framed.clone().ok_or("no page with Annotate is showing".to_owned());
    match cmd["do"].as_str().unwrap_or("state") {
        "start" => {
            let (thread, key, source) = needs_page()?;
            annotations.update(cx, |a, cx| a.start(key, source, thread, cx));
        }
        "cancel" => annotations.update(cx, |a, cx| a.cancel(cx)),
        "tools" => {
            let js = cmd["js"].as_str().ok_or("tools needs js")?;
            let (page, context) = annotations.read_with(cx, |a, _| a.active.as_ref().and_then(|a| Some((a.page.clone(), a.context.get()?)))).ok_or("the annotation tools aren't open")?;
            let value = evaluate(&page, js, context, cx).await.map_err(|stop| match stop {
                Stop::Say(words) => words,
                Stop::Quiet => "the tools went away".to_owned(),
            })?;
            return Ok(json!({ "value": value }));
        }
        "open" => {
            let address = cmd["address"].as_str().ok_or("open needs address")?.to_owned();
            let side = app.read_with(cx, |app, _| app.side.clone()).map_err(|e| e.to_string())?;
            let opened = side.update(cx, |side, cx| side.browser_open(&address, cx));
            return if opened { Ok(json!("ok")) } else { Err("the Browser pane didn't take that address".into()) };
        }
        "state" => {}
        other => return Err(format!("do must be start, cancel, tools, open or state, not {other:?}")),
    }
    Ok(cx.update(|cx| {
        let a = annotations.read(cx);
        let (active, context) = (a.active.is_some(), a.active.as_ref().and_then(|a| a.context.get()));
        let mut state = match framed.as_ref().map(|(thread, ..)| dump(thread, cx)) {
            Some(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        state.insert("active".into(), json!(active));
        state.insert("context".into(), json!(context));
        Value::Object(state)
    }))
}
