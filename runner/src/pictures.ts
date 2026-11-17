// Where a message's pictures go among its words (docs/protocol.md,
// "Pictures in a message"). `[Picture N]` stands for images[N-1], and the
// picture goes straight after the first marker naming it, so "this
// [Picture 1] next to this [Picture 2]" reaches the agent with each
// picture where Mike pasted it. Pictures no marker names go first, as
// every picture did before markers (the phone's, an ask box's).
import type { ImageRef } from './protocol.ts';

export type MessagePart = { text: string } | { image: ImageRef };

const MARKER = /\[Picture (\d{1,3})\]/g;

export function placePictures(text: string, images: ImageRef[]): MessagePart[] {
  const cuts = pictureCuts(text, images.length);
  const placed = new Set(cuts.map((c) => c.index));
  const parts: MessagePart[] = [];
  images.forEach((image, i) => {
    if (!placed.has(i)) parts.push({ image });
  });
  let from = 0;
  for (const cut of cuts) {
    pushWords(parts, text.slice(from, cut.at));
    parts.push({ image: images[cut.index] });
    from = cut.at;
  }
  pushWords(parts, text.slice(from));
  return parts;
}

// Where each of `count` pictures goes: just after the first marker naming
// it, in the order the markers come. A marker naming no picture, or one
// already placed, is just words.
function pictureCuts(text: string, count: number): { at: number; index: number }[] {
  const placed = new Set<number>();
  const cuts: { at: number; index: number }[] = [];
  for (const m of text.matchAll(MARKER)) {
    const index = Number(m[1]) - 1;
    if (index < 0 || index >= count || placed.has(index)) continue;
    placed.add(index);
    cuts.push({ at: m.index + m[0].length, index });
  }
  return cuts;
}

// How many of a message's `count` pictures no marker places: the ones that
// go before the words.
export function unplacedPictures(text: string, count: number): number {
  return count - pictureCuts(text, count).length;
}

// The line a mirrored message ends with for its pictures no marker places
// (sync.ts toMessageDoc): "[1 picture]", "[3 pictures]".
const COUNT_LINE = /(?:^|\n\n)\[(?:1 picture|(\d{1,3}) pictures)\]$/;

/**
 * What a mirrored message's words say of its pictures, for a reader that
 * has only the words (relay.ts): how many it came with, and the words
 * without the line counting the unplaced ones. The most that fits: the
 * unplaced ones plus every marker that then names a picture.
 */
export function picturesSaid(text: string): { count: number; words: string } {
  const line = COUNT_LINE.exec(text);
  const unplaced = line ? Number(line[1] ?? 1) : 0;
  const words = line ? text.slice(0, line.index) : text;
  const named = new Set<number>();
  for (const m of words.matchAll(MARKER)) named.add(Number(m[1]));
  let count = unplaced + named.size;
  for (;;) {
    let placed = 0;
    for (const n of named) if (n >= 1 && n <= count) placed++;
    if (unplaced + placed === count) return { count, words };
    count = unplaced + placed;
  }
}

// The Claude API turns down a text block of nothing but whitespace, as
// between two pictures pasted one after the other.
function pushWords(parts: MessagePart[], text: string): void {
  if (text.trim()) parts.push({ text });
}
