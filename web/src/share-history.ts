// A shared thread's rows as far back as the reader has gone: the newest from
// share:view live, and older chunks read once with beforeSeq. The part of
// share.tsx with no Convex in it, so it can be tested alone (the phone's
// MessageHistory.swift does the same).
//
// The live query grows by raising its limit, as far as one query may go
// (share:view's PAGE_MAX of 2,000, fewer when rows are big). Past that,
// "Load earlier messages" did nothing (9 Nov): the bigger limit came back
// with the same 2,000 rows.

export const LIVE_MAX = 2000;

export type Row = { seq: number };
export type Picture = { seq: number; url: string };
export type Page<R extends Row, P extends Picture> = { messages: R[]; images: P[]; hasMore: boolean };

export type History<R extends Row, P extends Picture> = {
  live?: Page<R, P>;
  // The limit `live` was asked for with; a bigger one is on its way while it
  // isn't the one asked for now.
  liveLimit: number;
  // Older rows from chunks, oldest first, all before the live page's.
  older: R[];
  olderImages: P[];
  // Whether there's more before `older`; undefined until a chunk has come.
  olderHasMore?: boolean;
  // From the first ask for a chunk: the live page stops growing, and rows that
  // slide off its top as new ones come in move to `older`, or there'd be a
  // hole between the two.
  chunked: boolean;
};

export function empty<R extends Row, P extends Picture>(): History<R, P> {
  return { liveLimit: 0, older: [], olderImages: [], chunked: false };
}

export function rows<R extends Row, P extends Picture>(h: History<R, P>): R[] {
  return [...h.older, ...(h.live?.messages ?? [])];
}

// The pictures of every row shown, each once.
export function pictures<R extends Row, P extends Picture>(h: History<R, P>): P[] {
  const seen = new Set<string>();
  return [...h.olderImages, ...(h.live?.images ?? [])].filter((p) => !seen.has(p.url) && seen.add(p.url));
}

export function hasMore<R extends Row, P extends Picture>(h: History<R, P>): boolean {
  return h.olderHasMore ?? h.live?.hasMore ?? false;
}

export function firstSeq<R extends Row, P extends Picture>(h: History<R, P>): number | undefined {
  return h.older[0]?.seq ?? h.live?.messages[0]?.seq;
}

// A new answer from the live query, asked for with `limit`.
export function takeLive<R extends Row, P extends Picture>(h: History<R, P>, page: Page<R, P>, limit: number): History<R, P> {
  const first = page.messages[0]?.seq;
  const old = h.live;
  if (!h.chunked || !old || first === undefined) return { ...h, live: page, liveLimit: limit };
  const last = old.messages[old.messages.length - 1]?.seq;
  // Nothing in common with the answer before (the page was away while a whole
  // page of new rows came): what's between is unknown, so start again from
  // the newest rather than show a hole.
  if (last !== undefined && last < first) return { ...empty<R, P>(), live: page, liveLimit: limit };
  // Its top can also move back up (big rows above the byte cap that got
  // smaller): those rows are the live page's again.
  const older = h.older.filter((m) => m.seq < first);
  const olderImages = h.olderImages.filter((p) => p.seq < first);
  const after = older[older.length - 1]?.seq ?? -Infinity;
  return {
    ...h,
    live: page,
    liveLimit: limit,
    older: [...older, ...old.messages.filter((m) => m.seq < first && m.seq > after)],
    olderImages: [...olderImages, ...old.images.filter((p) => p.seq < first && p.seq > after)],
  };
}

export type Next = { grow: number } | { older: number } | null;

// What "Load earlier messages" should do next: ask the live query for more,
// ask for a chunk before a seq, or nothing (no more, or more is on its way).
export function next<R extends Row, P extends Picture>(h: History<R, P>, limit: number, step: number): Next {
  if (!h.live || !hasMore(h) || h.liveLimit !== limit) return null;
  // A full page under the server's most: more of it. One that came back short
  // of what was asked had reached what one query may read.
  if (!h.chunked && h.live.messages.length >= limit && limit < LIVE_MAX) return { grow: Math.min(limit + step, LIVE_MAX) };
  const first = firstSeq(h);
  return first === undefined ? null : { older: first };
}

// Before asking for the first chunk.
export function startChunks<R extends Row, P extends Picture>(h: History<R, P>): History<R, P> {
  return { ...h, chunked: true };
}

// A chunk of rows before `before`, or undefined if the shown rows no longer
// start there (it came too late).
export function takeOlder<R extends Row, P extends Picture>(h: History<R, P>, chunk: Page<R, P>, before: number): History<R, P> | undefined {
  if (firstSeq(h) !== before) return undefined;
  return {
    ...h,
    older: [...chunk.messages.filter((m) => m.seq < before), ...h.older],
    olderImages: [...chunk.images.filter((p) => p.seq < before), ...h.olderImages],
    olderHasMore: chunk.hasMore,
  };
}
