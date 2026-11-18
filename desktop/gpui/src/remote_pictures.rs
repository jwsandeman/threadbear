// Another Mac's pictures in a transcript (a tool's screenshots there, a
// picture pasted into one of its messages): their paths are that Mac's, so a
// tile never draws the file here that has the same path, which isn't the one
// meant (Daybreak, 7 Nov). This Mac's runner is asked for it instead
// (`files.read` with the thread's `runnerId`), as the pane asks for that Mac's
// files, and the tile draws the bytes. A tile with no picture says so
// quietly, as the Swift app's ImageGridView does: "Loading…", "Couldn't get it
// from bruce" (why, on hover; a click asks again), or "On bruce" for one too
// big to send whole.
//
// Through Convex, the only way this app reaches another Mac so far, the
// runner answers a `files.read` for another runner only for a picture of one
// of that runner's threads (docs/protocol.md, "Other runners' threads through
// the backend"): one pasted into a message, one a tool handed back (asked of
// that Mac when its tile is drawn) and one a reply names. Any other path is
// "Files on another runner are kept there for now."
//
// A reply's picture (`![alt](address)`) is asked for by its address, said to
// be a reply's (`reply: true`), when the address names a file: never a web
// address. It's drawn from the bytes the runner hands over, never from this
// Mac's file at that address (`reply_picture`, rows/markdown.rs). Until it
// comes, and when it doesn't, the reply shows it as a link. It's decoded
// before the reply is told, so the text has its size and its pixels on the
// first frame it's in.
use crate::call;
use gpui_kit::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use threadbear_client::runner::Client;
use threadbear_core::folders::FileRead;

/// Biggest picture asked for whole (`files.read`'s own default).
const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
pub(crate) enum Picture {
    Loading,
    Ready(Arc<Image>),
    /// Over the size cap: only its start came, which won't draw.
    Truncated,
    Failed(String),
}

/// How long before a reply's picture that couldn't be got is asked for again.
const REPLY_RETRY: std::time::Duration = std::time::Duration::from_secs(120);

/// Every remote picture asked for since launch, by runner and path.
#[derive(Default)]
struct RemotePictures {
    pictures: HashMap<(String, String), Picture>,
    /// The ones a reply names that are on their way or couldn't be got,
    /// by runner and address (`reply_picture`). Kept apart from a tile's:
    /// the runner answers these only with what that Mac sent up for a reply.
    replies: HashMap<(String, String), Picture>,
    /// When each of those couldn't be got.
    reply_failed: HashMap<(String, String), std::time::Instant>,
    /// The ones that came, decoded, as a reply's text is handed them (`Drawn`).
    drawn: Drawn,
}

impl Global for RemotePictures {}

/// The pictures of replies that have come, decoded, by runner and address:
/// what a reply's text draws for another Mac's thread. Shared with the text
/// views, and copied only when one more comes.
pub(crate) type Drawn = Arc<HashMap<(String, String), Arc<RenderImage>>>;

impl RemotePictures {
    /// What `files.read` answered for a tile's picture.
    fn keep(&mut self, key: (String, String), picture: Picture) {
        self.pictures.insert(key, picture);
    }

    /// What it answered for a reply's, with the picture decoded if it was one.
    fn keep_reply(&mut self, key: (String, String), picture: Picture, decoded: Option<Arc<RenderImage>>) {
        let picture = match (picture, decoded) {
            (Picture::Ready(_), Some(decoded)) => {
                Arc::make_mut(&mut self.drawn).insert(key.clone(), decoded);
                self.replies.remove(&key);
                return;
            }
            (Picture::Ready(_), None) => Picture::Failed("It isn't a picture a reply can show.".into()),
            (other, _) => other,
        };
        self.reply_failed.insert(key.clone(), std::time::Instant::now());
        self.replies.insert(key, picture);
    }
}

/// Not an SVG: an SVG's `<image href>` is read from this Mac's disk when
/// it's drawn (rows/markdown.rs, `raster_file`).
fn draws_in_text(image: &Image) -> bool {
    image.format != ImageFormat::Svg
}

/// The picture as far as it's got, asking for it the first time. `redraw`
/// is told when it comes.
pub(crate) fn picture(runner: &str, path: &str, client: &Arc<Client>, redraw: AnyWeakEntity, cx: &mut App) -> Picture {
    ask(runner, path, false, client, redraw, cx)
}

/// Whether an address in another Mac's reply may name a picture file there:
/// a path, a path under its home, or a file URL of that Mac's. A web address
/// never is, so what an agent writes can't make the app or its runner fetch one.
pub(crate) fn names_a_file(address: &str) -> bool {
    if address.len() > 4096 || address.chars().any(char::is_control) {
        return false;
    }
    (address.starts_with('/') && !address.starts_with("//")) || address.starts_with("~/") || address.starts_with("file:///") || address.starts_with("file://localhost/")
}

/// Whether the picture another Mac's reply names by `address` has come and
/// can be drawn, asking that Mac's uploads for it the first time (and again
/// a while after it couldn't be got). `redraw` is told when it comes.
pub(crate) fn reply_picture(runner: &str, address: &str, client: &Arc<Client>, redraw: AnyWeakEntity, cx: &mut App) -> bool {
    if !names_a_file(address) {
        return false;
    }
    let key = (runner.to_owned(), address.to_owned());
    let all = cx.default_global::<RemotePictures>();
    if all.drawn.contains_key(&key) {
        return true;
    }
    if all.reply_failed.get(&key).is_some_and(|at| at.elapsed() >= REPLY_RETRY) {
        all.reply_failed.remove(&key);
        all.replies.remove(&key);
    }
    ask(runner, address, true, client, redraw, cx);
    false
}

/// The same, without asking for it.
pub(crate) fn reply_picture_drawn(runner: &str, address: &str, cx: &App) -> bool {
    cx.try_global::<RemotePictures>().is_some_and(|all| all.drawn.contains_key(&(runner.to_owned(), address.to_owned())))
}

/// The pictures a reply's text may draw for another Mac's thread.
pub(crate) fn drawn(cx: &App) -> Drawn {
    cx.try_global::<RemotePictures>().map(|all| all.drawn.clone()).unwrap_or_default()
}

fn ask(runner: &str, path: &str, reply: bool, client: &Arc<Client>, redraw: AnyWeakEntity, cx: &mut App) -> Picture {
    let key = (runner.to_owned(), path.to_owned());
    let all = cx.default_global::<RemotePictures>();
    let kept = if reply { &mut all.replies } else { &mut all.pictures };
    if let Some(found) = kept.get(&key) {
        return found.clone();
    }
    kept.insert(key.clone(), Picture::Loading);
    let mut params = json!({ "path": path, "runnerId": runner, "maxBytes": MAX_BYTES });
    if reply {
        params["reply"] = json!(true);
    }
    let client = client.clone();
    cx.spawn(async move |cx| {
        let answer = call(client, "files.read", params).await;
        let picture = match answer {
            Ok(value) => match FileRead::decode(&value) {
                Some(read) if read.truncated => Picture::Truncated,
                Some(read) => match crate::viewer::format_of(&key.1, &read.data) {
                    Some(format) => Picture::Ready(Arc::new(Image::from_bytes(format, read.data))),
                    None => Picture::Failed("It isn't a picture this app can show.".into()),
                },
                None => Picture::Failed("Couldn't read the runner's answer.".into()),
            },
            Err(e) => Picture::Failed(e.message),
        };
        // A reply's is decoded here, off the drawing thread.
        let decoded = match &picture {
            Picture::Ready(image) if reply && draws_in_text(image) => {
                let (image, renderer) = (image.clone(), cx.update(|cx| cx.svg_renderer()));
                cx.background_executor().spawn(async move { image.to_image_data(renderer).ok() }).await
            }
            _ => None,
        };
        cx.update(|cx| {
            let all = cx.default_global::<RemotePictures>();
            if reply {
                all.keep_reply(key, picture, decoded);
            } else {
                all.keep(key, picture);
            }
            if let Some(entity) = redraw.upgrade() {
                cx.notify(entity.entity_id());
            }
        });
    })
    .detach();
    Picture::Loading
}

/// A click on one that couldn't be got: asked for again on the next draw.
pub(crate) fn retry(runner: &str, path: &str, cx: &mut App) {
    let key = (runner.to_owned(), path.to_owned());
    let pictures = &mut cx.default_global::<RemotePictures>().pictures;
    if matches!(pictures.get(&key), Some(Picture::Failed(_))) {
        pictures.remove(&key);
    }
}

/// What a tile with no picture says (`remoteWords`).
pub(crate) fn words(picture: &Picture, runner_name: &str) -> Option<String> {
    match picture {
        Picture::Loading => Some("Loading…".into()),
        Picture::Truncated => Some(format!("On {runner_name}")),
        Picture::Failed(_) => Some(format!("Couldn't get it from {runner_name}")),
        Picture::Ready(_) => None,
    }
}

/// The picture as far as it's got, without asking for it.
#[cfg(feature = "automation")]
fn peek(runner: &str, path: &str, cx: &App) -> Option<Picture> {
    cx.try_global::<RemotePictures>()?.pictures.get(&(runner.to_owned(), path.to_owned())).cloned()
}

/// `tiles`, as the Swift app's: what each picture of the last row of at
/// least `count` says, "picture" for one that's drawn, else its words.
#[cfg(feature = "automation")]
pub(crate) fn tiles_command(app: &Entity<crate::app::Threadbear>, cmd: &serde_json::Value, cx: &mut App) -> Result<serde_json::Value, String> {
    let count = cmd["count"].as_u64().unwrap_or(1) as usize;
    let (images, runner) = app.update(cx, |t, cx| t.update_pane(cx, |p, _| p.last_row_images(count).map(|images| (images, p.summary.runner_id.clone()))))??;
    let name = runner.as_deref().map(|id| app.read(cx).runner_name_of(id)).unwrap_or_default();
    let said: Vec<String> = images
        .iter()
        .map(|image| match &runner {
            None => "picture".to_owned(),
            // Not asked for yet is on its way, as the Swift tile says it.
            Some(runner) => peek(runner, &image.path, cx).map_or_else(|| Some("Loading…".to_owned()), |p| words(&p, &name)).unwrap_or_else(|| "picture".to_owned()),
        })
        .collect();
    Ok(json!(format!("ok {}", said.join(" | "))))
}

/// `reply-pictures`: what each picture the last reply with any names is
/// drawn as, in the reply's order: "picture", or "link".
#[cfg(feature = "automation")]
pub(crate) fn reply_pictures_command(app: &Entity<crate::app::Threadbear>, cx: &mut App) -> Result<serde_json::Value, String> {
    let said = app.update(cx, |t, cx| t.update_pane(cx, |p, cx| p.last_reply_pictures(cx)))??;
    Ok(json!(format!("ok {}", said.join(" | "))))
}

/// `tile-point`: where a picture tile's middle is (`index` of the last row of
/// at least `count`), with its file's name: "ok x y name.png".
#[cfg(feature = "automation")]
pub(crate) fn tile_point_command(app: &Entity<crate::app::Threadbear>, cmd: &serde_json::Value, window: &mut Window, cx: &mut App) -> Result<serde_json::Value, String> {
    use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
    let count = cmd["count"].as_u64().unwrap_or(1) as usize;
    let index = cmd["index"].as_u64().unwrap_or(0) as usize;
    let images = app.update(cx, |t, cx| t.update_pane(cx, |p, _| p.last_row_images(count)))??;
    let image = images.get(index).ok_or("no such picture")?;
    let name = std::path::Path::new(&image.path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    window.render_frame(cx);
    // A tile's label is its file's name (rows/images.rs).
    let tile = window.find_all_by_label(&name).into_iter().filter(|e| e.visible()).last().ok_or("that picture isn't on screen")?;
    let (x, y) = crate::automation::whole_point(tile.visible_bounds()).ok_or("that picture isn't on screen")?;
    Ok(json!(format!("ok {x} {y} {name}")))
}

#[cfg(test)]
mod tests {
    // Not `super::*`: gpui's `test` attribute would come with it.
    use super::{names_a_file, Picture, RemotePictures};
    use gpui_kit::{Image, ImageFormat, RenderImage};
    use std::sync::Arc;

    fn decoded() -> Arc<RenderImage> {
        Arc::new(RenderImage::new(vec![image::Frame::new(image::RgbaImage::new(1, 1))]))
    }

    fn key(address: &str) -> (String, String) {
        ("mac-mini".to_owned(), address.to_owned())
    }

    #[test]
    fn only_a_file_address_is_ever_asked_for() {
        for address in ["/Users/b/x/chart.png", "~/shots/a.png", "file:///Users/b/a%20b.png", "file://localhost/Users/b/a.png"] {
            assert!(names_a_file(address), "{address}");
        }
        for address in [
            "https://example.com/y.png",
            "http://127.0.0.1/y.png",
            "//example.com/y.png",
            "file://example.com/share/y.png",
            "data:image/png;base64,AAAA",
            "threadbear-relay:t/14/Tool picture 1",
            "chart.png",
            "../chart.png",
            "",
            "/Users/b/a\nb.png",
        ] {
            assert!(!names_a_file(address), "{address}");
        }
        assert!(!names_a_file(&format!("/{}", "a".repeat(4096))));
    }

    #[test]
    fn a_replys_picture_is_kept_apart_from_a_tiles_and_drawn_only_once_decoded() {
        let mut all = RemotePictures::default();
        let png = Arc::new(Image::from_bytes(ImageFormat::Png, b"\x89PNG".to_vec()));
        // A tile's answer (which may be this runner's own inbox file) is never a reply's.
        all.keep(key("/Users/b/x/chart.png"), Picture::Ready(png.clone()));
        assert!(all.drawn.is_empty());
        assert!(all.replies.is_empty());
        let pixels = decoded();
        all.keep_reply(key("/Users/b/x/chart.png"), Picture::Ready(png.clone()), Some(pixels.clone()));
        assert!(Arc::ptr_eq(all.drawn.get(&key("/Users/b/x/chart.png")).unwrap(), &pixels));
        // An SVG, or bytes that don't decode, are never handed to a reply's text.
        assert!(!super::draws_in_text(&Image::from_bytes(ImageFormat::Svg, b"<svg/>".to_vec())));
        all.keep_reply(key("/Users/b/x/logo.svg"), Picture::Ready(png), None);
        assert_eq!(all.drawn.len(), 1);
        assert!(matches!(all.replies.get(&key("/Users/b/x/logo.svg")), Some(Picture::Failed(_))));
        // One that couldn't be got is remembered with when, to ask again.
        all.keep_reply(key("/Users/b/x/gone.png"), Picture::Failed("kept there".into()), None);
        assert!(all.reply_failed.contains_key(&key("/Users/b/x/gone.png")));
        assert!(all.reply_failed.contains_key(&key("/Users/b/x/logo.svg")));
        assert_eq!(all.drawn.len(), 1);
    }

    #[test]
    fn a_snapshot_handed_to_a_text_view_is_not_changed_by_a_later_picture() {
        let mut all = RemotePictures::default();
        let before = all.drawn.clone();
        all.keep_reply(key("/a.png"), Picture::Ready(Arc::new(Image::from_bytes(ImageFormat::Png, vec![1]))), Some(decoded()));
        assert!(before.is_empty());
        assert_eq!(all.drawn.len(), 1);
    }
}
