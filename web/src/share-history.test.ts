import { test } from 'node:test';
import assert from 'node:assert/strict';
import { empty, firstSeq, hasMore, next, pictures, rows, startChunks, takeLive, takeOlder, type History } from './share-history.ts';

type R = { seq: number };
type P = { seq: number; url: string };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const page = (a: number, b: number, more: boolean, pics: number[] = []) => ({
  messages: range(a, b).map((seq) => ({ seq })),
  images: pics.map((seq) => ({ seq, url: `https://x/${seq}.png` })),
  hasMore: more,
});
const seqs = (h: History<R, P>) => rows(h).map((m) => m.seq);

test('a full live page under the most grows, and waits while the bigger one comes', () => {
  const h = takeLive(empty<R, P>(), page(601, 1000, true), 400);
  assert.deepEqual(next(h, 400, 200), { grow: 600 });
  assert.equal(next(h, 600, 200), null);
});

test('at the most a share sends (2,000) it reads an older chunk instead', () => {
  const h = takeLive(empty<R, P>(), page(5501, 7500, true), 2000);
  assert.deepEqual(next(h, 2000, 200), { older: 5501 });
  // A page cut short by its size (8 MB a query) does the same.
  const big = takeLive(empty<R, P>(), page(901, 1000, true), 600);
  assert.deepEqual(next(big, 600, 200), { older: 901 });
});

test('chunks go above the live page until the start', () => {
  let h = startChunks(takeLive(empty<R, P>(), page(5501, 7500, true), 2000));
  h = takeOlder(h, page(5301, 5500, true, [5310]), 5501)!;
  assert.deepEqual(seqs(h), range(5301, 7500));
  assert.deepEqual(next(h, 2000, 200), { older: 5301 });
  h = takeOlder(h, page(1, 5300, false), 5301)!;
  assert.equal(rows(h).length, 7500);
  assert.equal(hasMore(h), false);
  assert.equal(next(h, 2000, 200), null);
  assert.deepEqual(pictures(h).map((p) => p.seq), [5310]);
});

test('rows that slide off the live page stay once chunks are in', () => {
  let h = startChunks(takeLive(empty<R, P>(), page(5501, 7500, true, [5502]), 2000));
  h = takeLive(h, page(5503, 7502, true), 2000);
  assert.equal(firstSeq(h), 5501);
  h = takeOlder(h, page(5301, 5500, true), 5501)!;
  assert.deepEqual(seqs(h), range(5301, 7502));
  assert.deepEqual(pictures(h).map((p) => p.seq), [5502]);
});

test('without chunks a sliding live page is all there is', () => {
  let h = takeLive(empty<R, P>(), page(601, 1000, true), 400);
  h = takeLive(h, page(602, 1001, true), 400);
  assert.deepEqual(seqs(h), range(602, 1001));
});

test('no overlap with the answer before starts again from the newest', () => {
  let h = startChunks(takeLive(empty<R, P>(), page(5501, 7500, true), 2000));
  h = takeOlder(h, page(5301, 5500, true), 5501)!;
  h = takeLive(h, page(9601, 11600, true), 2000);
  assert.deepEqual(seqs(h), range(9601, 11600));
  assert.equal(h.chunked, false);
});

test('a live page reaching further back takes its rows back from the chunks', () => {
  let h = startChunks(takeLive(empty<R, P>(), page(5501, 7500, true, [5505]), 2000));
  h = takeLive(h, page(5511, 7510, true), 2000);
  h = takeLive(h, page(5490, 7510, true, [5505]), 2000);
  assert.deepEqual(seqs(h), range(5490, 7510));
  assert.deepEqual(pictures(h).map((p) => p.seq), [5505]);
});

test('a chunk that comes too late is dropped', () => {
  let h = startChunks(takeLive(empty<R, P>(), page(5501, 7500, true), 2000));
  h = takeOlder(h, page(5301, 5500, true), 5501)!;
  assert.equal(takeOlder(h, page(5301, 5500, true), 5501), undefined);
});
