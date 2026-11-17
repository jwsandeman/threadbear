// A box that takes pictures as the message box does: a card's Something else
// box (composer_card.rs, AskAnswerBox) and the review window's reply box
// (review_window.rs, ReviewReplyBox). Its chips are this composer's: a paste,
// a drop or the picture button puts one where the cursor is and copies it in
// through the runner.
use crate::composer::Composer;
use crate::style;
use crate::style::px;
use crate::tips::Tip as _;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{h_flex, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::collections::HashSet;
use threadbear_core::reducer::ImageRef;

impl Composer {
    /// A box outside the pane joins this composer's: its chips are numbered
    /// and their pictures kept for as long as it lives.
    pub(crate) fn adopt_box(&mut self, input: &Entity<TextareaState>) {
        self.extra_boxes.retain(|b| b.upgrade().is_some());
        if !self.extra_boxes.iter().any(|b| b.upgrade().as_ref() == Some(input)) {
            self.extra_boxes.push(input.downgrade());
        }
    }

    pub(crate) fn adopted_boxes(&self) -> Vec<Entity<TextareaState>> {
        self.extra_boxes.iter().filter_map(WeakEntity::upgrade).collect()
    }

    /// The message box's pictures are forgotten; an adopted box's stay.
    pub(crate) fn clear_pictures(&mut self, cx: &App) {
        let kept: HashSet<SharedString> = self.adopted_boxes().iter().flat_map(|b| Self::chips_in(b, cx)).map(|(_, id)| id).collect();
        self.pictures.retain(|id, _| kept.contains(id));
    }

    /// What `input` holds as a draft keeps it: its words, a [Picture N]
    /// marker for each chip whose picture is in, and those pictures in order.
    pub(crate) fn box_note(&self, input: &Entity<TextareaState>, cx: &App) -> (String, Vec<ImageRef>) {
        let text = input.read(cx).value().to_string();
        threadbear_core::inline_chips::draft_in(&text, &self.box_chips_in(input, cx), 0..text.len())
    }

    /// A picture in `input` is still being copied in.
    pub(crate) fn box_copying(&self, input: &Entity<TextareaState>, cx: &App) -> bool {
        Self::chips_in(input, cx).iter().any(|(_, id)| self.pictures.get(id).is_some_and(|c| c.image.is_none()))
    }

    /// Pictures for `input`, from its picture button
    /// (AskAnswerBox.choosePictures): chips where the cursor was, as a paste
    /// would put them.
    pub(crate) fn choose_pictures_in(&mut self, input: &Entity<TextareaState>, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: Some("Add".into()) });
        let input = input.downgrade();
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                this.update_in(cx, |this, window, cx| {
                    if let Some(input) = input.upgrade() {
                        this.take_paths_in(&input, paths, window, cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    /// The box's text field with its chips drawn, and a paste of pictures
    /// going in as chips where the cursor is (AskAnswerBox, Mike 1 Nov).
    pub(crate) fn box_field(&mut self, input: &Entity<TextareaState>, field: Textarea, cx: &mut Context<Self>) -> Textarea {
        let input = input.clone();
        let this = cx.entity().downgrade();
        let tokens = this.clone();
        let (clicks, click_input) = (this.clone(), input.clone());
        field
            .token(move |ctx, _window, cx| match tokens.upgrade() {
                Some(this) => this.read(cx).render_chip(ctx, cx),
                None => div().into_any_element(),
            })
            .on_paste(move |item, window, cx| this.upgrade().is_some_and(|this| this.update(cx, |this, cx| this.take_clipboard_in(&input, item, window, cx))))
            // A click on a picture's chip opens it among this box's others,
            // as in the message box (Composer::open_picture).
            .on_token_click(move |event, window, cx| {
                if let Some(this) = clicks.upgrade() {
                    this.update(cx, |this, cx| this.open_picture(&click_input, event.token().id(), window, cx));
                }
            })
    }

    /// Its pictures over the words, 44 square with × on hover, and the
    /// picture button at the right (AskAnswerBox's thumbs and addButton).
    /// `slot` tells one box's from another's in the same window.
    pub(crate) fn box_pictures(&mut self, input: &Entity<TextareaState>, slot: usize, add_tip: &'static str, cx: &mut Context<Self>) -> (Option<AnyElement>, AnyElement) {
        let input = input.clone();
        let ask = slot;
        let chips = Self::chips_in(&input, cx);
        let strip = (!chips.is_empty()).then(|| {
            let mut row = h_flex().gap(px(6.));
            for (n, (_, id)) in chips.into_iter().enumerate() {
                let path = self.pictures.get(&id).map(|c| c.image.as_ref().map_or_else(|| c.source.clone(), |i| std::path::PathBuf::from(&i.path)));
                let in_yet = self.pictures.get(&id).is_some_and(|c| c.image.is_some());
                let (remove_input, remove_id) = (input.clone(), id.clone());
                let tile = div()
                    .relative()
                    .size(px(44.))
                    .rounded(px(6.))
                    .overflow_hidden()
                    .border(gpui_kit::px(0.5))
                    .border_color(style::hairline(cx))
                    .bg(style::chip_fill(cx))
                    .when_some(path, |d, path| d.child(img(path).size(px(44.)).object_fit(ObjectFit::Cover).when(!in_yet, |i| i.opacity(0.5))));
                let remove = crate::composer::remove_badge(("answer-picture-remove", ask * 100 + n)).on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    // Not the thumbnail's click under it, which opens the picture.
                    cx.stop_propagation();
                    this.remove_picture_in(&remove_input, remove_id.clone(), window, cx);
                }));
                let (open_input, open_id) = (input.clone(), id.clone());
                let group: SharedString = format!("answer-picture-{ask}-{n}").into();
                row = row.child(
                    div()
                        .id(("answer-picture", ask * 100 + n)).role(Role::Button)
                        .group(group.clone())
                        .relative()
                        .cursor_pointer()
                        .child(tile)
                        // Placed itself in the corner, as the message box's are
                        // (Composer::render_strip).
                        .child(div().absolute().top(px(2.)).right(px(2.)).invisible().group_hover(group, |s| s.visible()).child(remove))
                        .tip(crate::viewer::TILE_TIP)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_picture(&open_input, &open_id, window, cx);
                        })),
                );
            }
            row.into_any_element()
        });
        let add_input = input.clone();
        let add = div()
            .id(("answer-add-pictures", ask)).role(Role::Button)
            .flex_none()
            .size(px(22.))
            .mb(px((style::size::BODY_LINE - 22.) / 2.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.))
            .cursor_pointer()
            .hover(|s| s.bg(style::hover_fill(cx)))
            .child(Icon::from(IconName::ImagePlus).with_size(px(14.)).text_color(style::secondary_label(cx)))
            .tip(add_tip)
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.choose_pictures_in(&add_input, window, cx)))
            .into_any_element();
        (strip, add)
    }
}
