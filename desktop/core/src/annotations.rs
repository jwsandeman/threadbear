// Browser annotations (browser.annotate): the rules behind the Annotate button
// over a page shown inside the app. Ports of BrowserAnnotationPayload and the
// session checks in EmbeddedBrowserAnnotations.swift. The tools themselves are
// the Swift app's script, run in a world of its own in the page.
use crate::composer::{appending, PICTURE_MARK, PICTURE_MARK_STR};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// The experiment's id (runner/src/experiments/browserAnnotations.md).
pub const EXPERIMENT: &str = "browserAnnotations";

/// The tools: a function taking the session's id.
pub const SOURCE: &str = include_str!("../../../app/Sources/Threadbear/Resources/Annotations/annotation.js");

/// The isolated world the tools run in.
pub const WORLD: &str = "Threadbear annotations";

/// What the tools say of themselves, asked every `POLL_MS`.
pub const READ: &str = "window.__threadbearAnnotation?.read() ?? ({status:'missing'})";
pub const POLL_MS: u64 = 200;

/// The largest screenshot attached, in bytes.
pub const MAX_SCREENSHOT: usize = 14 * 1024 * 1024;

pub const OPENING: &str = "Opening annotation tools…";
pub const ACTIVE: &str = "Select, mark or draw here, then choose Attach.";
pub const ATTACHING: &str = "Attaching annotation…";
pub const ATTACHED: &str = "Annotation attached to this thread's draft. Review it, then send.";
pub const NO_SCREENSHOT: &str = "The screenshot couldn't be attached; your comment and page context are in the draft.";
pub const PAGE_CHANGED: &str = "The page changed. Open Annotate again when it finishes loading.";
pub const STILL_LOADING: &str = "Wait for the page to finish loading, then try Annotate again.";
pub const THREAD_GONE: &str = "The original local thread is no longer available.";
pub const LOCAL_ONLY: &str = "Annotations are available in this Mac's threads.";
pub const SESSION_ENDED: &str = "The page changed and its annotation session ended.";
pub const STOPPED: &str = "The annotation tools stopped responding. Try Annotate again.";
pub const NOTHING: &str = "The page returned no annotation.";
pub const INVALID: &str = "The page returned an invalid or oversized annotation.";

/// The script that starts the tools for `session`.
pub fn start_expression(session: &str) -> String {
    format!("({SOURCE})({})", json!(session))
}

/// The script that closes `session`'s tools, and no other session's.
pub fn finish_expression(session: &str) -> String {
    format!("if (window.__threadbearAnnotation?.sessionId === {}) window.__threadbearAnnotation.finish(); ({{done:true}})", json!(session))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Element {
    pub selector: String,
    #[serde(rename = "tagName")]
    pub tag_name: String,
    #[serde(rename = "outerHTML")]
    pub outer_html: String,
    pub text: String,
    pub styles: BTreeMap<String, String>,
    pub rect: Rect,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub points: Vec<Point>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    #[serde(rename = "scrollX")]
    pub scroll_x: f64,
    #[serde(rename = "scrollY")]
    pub scroll_y: f64,
}

/// What Attach hands over (`BrowserAnnotationPayload`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub url: String,
    pub title: String,
    pub comment: String,
    pub elements: Vec<Element>,
    pub regions: Vec<Rect>,
    pub strokes: Vec<Stroke>,
    pub viewport: Viewport,
}

fn sane(n: f64) -> bool {
    n.is_finite() && n.abs() <= 10_000_000.
}

fn long(text: &str, most: usize) -> bool {
    text.chars().count() > most
}

impl Rect {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height].into_iter().all(sane) && self.width >= 0. && self.height >= 0.
    }
}

impl Annotation {
    /// A page's annotation, within the bounds a draft can carry.
    pub fn decode(value: &Value) -> Result<Annotation, String> {
        let invalid = || INVALID.to_owned();
        if serde_json::to_vec(value).map_err(|_| invalid())?.len() > 512 * 1024 {
            return Err(invalid());
        }
        let a: Annotation = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        let v = &a.viewport;
        let element_ok = |e: &Element| {
            !long(&e.selector, 2048) && !long(&e.tag_name, 128) && !long(&e.outer_html, 16_000) && !long(&e.text, 4000) && e.styles.len() <= 64 && e.styles.iter().all(|(k, v)| !long(k, 128) && !long(v, 1024)) && e.rect.valid()
        };
        let ok = !long(&a.url, 8192)
            && !long(&a.title, 1024)
            && !long(&a.comment, 16_000)
            && a.elements.len() <= 20
            && a.regions.len() <= 20
            && a.strokes.len() <= 100
            && !(a.elements.is_empty() && a.regions.is_empty() && a.strokes.is_empty())
            && a.strokes.iter().map(|s| s.points.len()).sum::<usize>() <= 20_000
            && [v.width, v.height, v.scroll_x, v.scroll_y].into_iter().all(sane)
            && v.width > 0.
            && v.height > 0.
            && a.elements.iter().all(element_ok)
            && a.regions.iter().all(Rect::valid)
            && a.strokes.iter().all(|s| !s.points.is_empty() && s.points.iter().all(|p| sane(p.x) && sane(p.y)));
        if ok {
            Ok(a)
        } else {
            Err(invalid())
        }
    }

    /// The words added to the draft (`draftText`): the comment, then the
    /// page's context as JSON, its keys in order.
    pub fn draft_text(&self, screenshot: bool) -> String {
        let mut details = match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.remove("comment");
        if screenshot {
            details.insert("strokes".into(), json!(format!("{} drawn strokes, shown in the screenshot", self.strokes.len())));
        } else {
            details.insert("screenshot".into(), json!("Unavailable. Drawing points and regions use the captured viewport's coordinates."));
        }
        let context = serde_json::to_string_pretty(&sorted(Value::Object(details))).unwrap_or_default();
        let comment = if self.comment.is_empty() { "Please review the marked areas." } else { &self.comment };
        let text = format!("Browser annotation\n\n{comment}\n\nPage context (captured from the page):\n```json\n{context}\n```");
        // A mark in the page's own words would stand for a picture.
        text.replace(PICTURE_MARK, "[object]")
    }

    /// `draft_text`, then a mark for each of `pictures` screenshots.
    pub fn draft_addition(&self, pictures: usize) -> String {
        let mut text = self.draft_text(pictures > 0);
        for _ in 0..pictures {
            text = appending(PICTURE_MARK_STR, &text);
        }
        text
    }
}

fn sorted(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let ordered: BTreeMap<String, Value> = map.into_iter().map(|(k, v)| (k, sorted(v))).collect();
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted).collect()),
        // A whole number as the page gave it: 45, not 45.0.
        Value::Number(n) => match n.as_f64().filter(|f| n.is_f64() && f.fract() == 0. && f.abs() < 9e15) {
            Some(whole) => json!(whole as i64),
            None => Value::Number(n),
        },
        other => other,
    }
}

/// What the tools said when asked (`READ`).
#[derive(Clone, Debug, PartialEq)]
pub enum Reading {
    Active,
    Cancelled,
    Ready(Annotation),
}

/// An answer to `READ` for `session`: another session's, or none, is the page
/// having changed.
pub fn reading(value: &Value, session: &str) -> Result<Reading, String> {
    if value["sessionId"].as_str() != Some(session) {
        return Err(SESSION_ENDED.to_owned());
    }
    match value["status"].as_str() {
        Some("active") => Ok(Reading::Active),
        Some("cancelled") => Ok(Reading::Cancelled),
        Some("ready") => match value.get("annotation").filter(|a| a.is_object()) {
            Some(annotation) => Annotation::decode(annotation).map(Reading::Ready),
            None => Err(NOTHING.to_owned()),
        },
        _ => Err(STOPPED.to_owned()),
    }
}

/// Whether `session`'s annotation is still waiting to be attached.
pub fn still_ready(value: &Value, session: &str) -> bool {
    value["sessionId"].as_str() == Some(session) && value["status"].as_str() == Some("ready")
}

/// A screenshot from `Page.captureScreenshot`: its PNG bytes, if it is one
/// and small enough to attach.
pub fn screenshot(data: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    if data.len() > MAX_SCREENSHOT / 3 * 4 + 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    (bytes.len() <= MAX_SCREENSHOT && bytes.starts_with(b"\x89PNG\r\n\x1a\n")).then_some(bytes)
}

/// A page's address and how many times it has loaded, when Annotate started
/// and now: any difference, or a load under way, is the page having changed.
pub fn page_changed(started: (&str, u32), now: (&str, u32), loading: bool) -> bool {
    loading || started != now
}

/// What the Browser panel opens inside the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opened {
    /// A web page, by its address.
    Page(String),
    /// A local file, by its path.
    File(String),
}

/// An address as a page shown inside the app: a web page or a local file.
/// None for anything else (`about:`, `data:`, another app's scheme).
pub fn opens_here(url: &str) -> Option<Opened> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("file://") {
        let rest = &url["file://".len()..];
        let path = rest.strip_prefix("localhost").filter(|p| p.starts_with('/')).unwrap_or(rest);
        let path = path.split(['?', '#']).next().unwrap_or(path);
        return path.starts_with('/').then(|| Opened::File(crate::open_policy::percent_decode(path)));
    }
    let host = ["http://", "https://"].iter().find_map(|scheme| lower.strip_prefix(scheme))?;
    let host = host.split(['/', '?', '#']).next().unwrap_or("");
    (!host.is_empty()).then(|| Opened::Page(url.to_owned()))
}

/// A local file's address, as a draft names the page that was annotated.
pub fn file_address(path: &str) -> String {
    let escaped: String = path
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect();
    format!("file://{escaped}")
}

/// What's typed in the Browser panel's address field, as `opens_here`: a
/// bare name with a dot is https, anything else a search.
pub fn typed(text: &str) -> Option<Opened> {
    opens_here(&crate::browserbear::address(text)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "url": "https://example.com/pricing",
            "title": "Pricing",
            "comment": "Make this button bigger",
            "elements": [{ "selector": "#buy", "tagName": "button", "outerHTML": "<button id=\"buy\">Buy</button>", "text": "Buy", "styles": { "color": "rgb(0, 0, 0)" }, "rect": { "x": 10, "y": 20, "width": 80, "height": 30 } }],
            "regions": [],
            "strokes": [{ "points": [{ "x": 1, "y": 2 }, { "x": 3, "y": 4 }] }],
            "viewport": { "width": 800, "height": 600, "scrollX": 0, "scrollY": 120 }
        })
    }

    #[test]
    fn a_page_annotation_decodes() {
        let a = Annotation::decode(&sample()).unwrap();
        assert_eq!(a.elements[0].tag_name, "button");
        assert_eq!(a.strokes[0].points.len(), 2);
        assert_eq!(a.viewport.scroll_y, 120.);
    }

    #[test]
    fn nothing_marked_or_out_of_bounds_is_refused() {
        let mut empty = sample();
        empty["elements"] = json!([]);
        empty["strokes"] = json!([]);
        assert_eq!(Annotation::decode(&empty), Err(INVALID.to_owned()));

        let mut long_comment = sample();
        long_comment["comment"] = json!("x".repeat(16_001));
        assert!(Annotation::decode(&long_comment).is_err());

        let mut many = sample();
        many["regions"] = json!(vec![json!({ "x": 0, "y": 0, "width": 1, "height": 1 }); 21]);
        assert!(Annotation::decode(&many).is_err());

        let mut negative = sample();
        negative["elements"][0]["rect"]["width"] = json!(-1);
        assert!(Annotation::decode(&negative).is_err());

        let mut far = sample();
        far["strokes"][0]["points"][0]["x"] = json!(10_000_001);
        assert!(Annotation::decode(&far).is_err());

        let mut flat = sample();
        flat["viewport"]["height"] = json!(0);
        assert!(Annotation::decode(&flat).is_err());

        let mut missing = sample();
        missing.as_object_mut().unwrap().remove("title");
        assert!(Annotation::decode(&missing).is_err());

        let mut empty_stroke = sample();
        empty_stroke["strokes"] = json!([{ "points": [] }]);
        assert!(Annotation::decode(&empty_stroke).is_err());

        // Each part within its own bound, and the whole within 512 KB.
        let mut big = sample();
        big["elements"] = json!(vec![sample()["elements"][0].clone(); 20]);
        for e in big["elements"].as_array_mut().unwrap() {
            e["outerHTML"] = json!("x".repeat(16_000));
            e["text"] = json!("é".repeat(4000));
        }
        big["title"] = json!("t".repeat(1024));
        big["comment"] = json!("c".repeat(16_000));
        assert!(Annotation::decode(&big).is_ok());
        for e in big["elements"].as_array_mut().unwrap() {
            e["styles"] = (0..64).map(|i| (format!("k{i}"), json!("v".repeat(1024)))).collect::<Map<String, Value>>().into();
        }
        assert!(Annotation::decode(&big).is_err(), "over 512 KB in all");
    }

    #[test]
    fn the_draft_has_the_comment_then_the_page_context() {
        let a = Annotation::decode(&sample()).unwrap();
        let text = a.draft_text(true);
        assert!(text.starts_with("Browser annotation\n\nMake this button bigger\n\nPage context (captured from the page):\n```json\n{"), "{text}");
        assert!(text.ends_with("}\n```"));
        assert!(text.contains("\"strokes\": \"1 drawn strokes, shown in the screenshot\""));
        assert!(text.contains("\"selector\": \"#buy\""));
        assert!(text.contains("\"height\": 30,") && text.contains("\"scrollY\": 120,"), "{text}");
        assert!(!text.contains("\"comment\""));
        assert!(!text.contains("\"screenshot\""));
        // Its keys in order, at every depth.
        let at = |key: &str| text.find(&format!("\"{key}\":")).unwrap();
        assert!(at("elements") < at("regions") && at("regions") < at("strokes") && at("strokes") < at("title") && at("title") < at("url") && at("url") < at("viewport"));
        assert!(at("outerHTML") < at("rect") && at("rect") < at("selector") && at("selector") < at("styles") && at("styles") < at("tagName"));
    }

    #[test]
    fn without_a_screenshot_the_drawing_stays_as_points() {
        let a = Annotation::decode(&sample()).unwrap();
        let text = a.draft_text(false);
        assert!(text.contains("\"screenshot\": \"Unavailable. Drawing points and regions use the captured viewport's coordinates.\""));
        assert!(text.contains("\"points\""));
        assert_eq!(a.draft_addition(0), text);
    }

    #[test]
    fn no_comment_asks_for_a_review_and_a_mark_in_the_page_is_not_a_picture() {
        let mut value = sample();
        value["comment"] = json!("");
        value["title"] = json!("A \u{FFFC} title");
        let a = Annotation::decode(&value).unwrap();
        let text = a.draft_addition(1);
        assert!(text.contains("\n\nPlease review the marked areas.\n\n"));
        assert!(text.contains("A [object] title"));
        assert_eq!(text.chars().filter(|c| *c == PICTURE_MARK).count(), 1);
        assert!(text.ends_with("``` \u{FFFC}"));
    }

    #[test]
    fn a_reading_belongs_to_its_session() {
        let ready = json!({ "sessionId": "s1", "status": "ready", "annotation": sample() });
        assert!(matches!(reading(&ready, "s1"), Ok(Reading::Ready(_))));
        assert!(still_ready(&ready, "s1"));
        assert!(!still_ready(&ready, "s2"));
        assert_eq!(reading(&ready, "s2"), Err(SESSION_ENDED.to_owned()));
        assert_eq!(reading(&json!({ "status": "missing" }), "s1"), Err(SESSION_ENDED.to_owned()));
        assert_eq!(reading(&json!({ "sessionId": "s1", "status": "active" }), "s1"), Ok(Reading::Active));
        assert_eq!(reading(&json!({ "sessionId": "s1", "status": "cancelled" }), "s1"), Ok(Reading::Cancelled));
        assert_eq!(reading(&json!({ "sessionId": "s1", "status": "ready" }), "s1"), Err(NOTHING.to_owned()));
        assert_eq!(reading(&json!({ "sessionId": "s1", "status": "odd" }), "s1"), Err(STOPPED.to_owned()));
        assert!(!still_ready(&json!({ "sessionId": "s1", "status": "cancelled" }), "s1"));
    }

    #[test]
    fn the_scripts_name_their_session() {
        let start = start_expression("a\"b");
        assert!(start.starts_with("(//"));
        assert!(start.ends_with(")(\"a\\\"b\")"));
        assert!(SOURCE.contains("window.__threadbearAnnotation = api"));
        assert!(finish_expression("s1").contains("sessionId === \"s1\""));
    }

    #[test]
    fn a_screenshot_is_a_png() {
        use base64::Engine as _;
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let png = b"\x89PNG\r\n\x1a\nrest";
        assert_eq!(screenshot(&encode(png)), Some(png.to_vec()));
        assert_eq!(screenshot(&encode(b"GIF89a")), None);
        assert_eq!(screenshot("not base64!"), None);
        assert_eq!(screenshot(""), None);
    }

    #[test]
    fn a_load_or_another_address_is_the_page_changing() {
        assert!(!page_changed(("https://a/", 1), ("https://a/", 1), false));
        assert!(page_changed(("https://a/", 1), ("https://a/", 1), true));
        assert!(page_changed(("https://a/", 1), ("https://a/#x", 1), false));
        assert!(page_changed(("https://a/", 1), ("https://a/", 2), false));
    }

    #[test]
    fn the_browser_panel_opens_pages_and_files_here() {
        assert_eq!(typed("example.com/a b"), Some(Opened::Page("https://www.google.com/search?q=example.com%2Fa+b".into())));
        assert_eq!(typed("example.com"), Some(Opened::Page("https://example.com".into())));
        assert_eq!(typed("http://localhost:3000/x"), Some(Opened::Page("http://localhost:3000/x".into())));
        assert_eq!(typed("file:///Users/me/My%20Site/index.html"), Some(Opened::File("/Users/me/My Site/index.html".into())));
        assert_eq!(opens_here("file://localhost/tmp/a.html#top"), Some(Opened::File("/tmp/a.html".into())));
        assert_eq!(file_address("/Users/me/My Site/café.html"), "file:///Users/me/My%20Site/caf%C3%A9.html");
        assert_eq!(opens_here(&file_address("/Users/me/My Site/café.html")), Some(Opened::File("/Users/me/My Site/café.html".into())));
        assert_eq!(typed("  "), None);
        assert_eq!(opens_here("about:blank"), None);
        assert_eq!(opens_here("data:text/html,hi"), None);
        assert_eq!(opens_here("chrome://settings"), None);
        assert_eq!(opens_here("https://"), None);
        assert_eq!(opens_here("file://server/share/a.html"), None);
    }
}
