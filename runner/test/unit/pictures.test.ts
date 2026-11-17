import { test } from 'node:test';
import assert from 'node:assert/strict';
import { picturesSaid, placePictures, unplacedPictures } from '../../src/pictures.ts';
import type { ImageRef } from '../../src/protocol.ts';

const red: ImageRef = { path: '/media/red.png', mediaType: 'image/png' };
const blue: ImageRef = { path: '/media/blue.png', mediaType: 'image/png' };

// docs/protocol.md, "Pictures in a message".
test('each picture goes straight after the marker naming it, the marker kept in the words', () => {
  assert.deepEqual(placePictures('this [Picture 1] should look like this [Picture 2] please', [red, blue]), [
    { text: 'this [Picture 1]' },
    { image: red },
    { text: ' should look like this [Picture 2]' },
    { image: blue },
    { text: ' please' },
  ]);
});

test('the markers can name pictures out of order', () => {
  assert.deepEqual(placePictures('[Picture 2] then [Picture 1]', [red, blue]), [
    { text: '[Picture 2]' },
    { image: blue },
    { text: ' then [Picture 1]' },
    { image: red },
  ]);
});

test('with no markers, the pictures go before the words, as they always did', () => {
  assert.deepEqual(placePictures('what colour?', [red, blue]), [{ image: red }, { image: blue }, { text: 'what colour?' }]);
  assert.deepEqual(placePictures('', [red]), [{ image: red }]);
});

test('a picture no marker names goes first; a marker naming no picture is just words', () => {
  assert.deepEqual(placePictures('See [Picture 2] and [Picture 7]', [red, blue]), [
    { image: red },
    { text: 'See [Picture 2]' },
    { image: blue },
    { text: ' and [Picture 7]' },
  ]);
  assert.deepEqual(placePictures('[Picture 1] [Picture 0]', []), [{ text: '[Picture 1] [Picture 0]' }]);
});

test('a picture named twice goes once, at its first marker', () => {
  assert.deepEqual(placePictures('[Picture 1] and again [Picture 1]', [red]), [
    { text: '[Picture 1]' },
    { image: red },
    { text: ' and again [Picture 1]' },
  ]);
});

test('nothing but whitespace between or after pictures is left out', () => {
  assert.deepEqual(placePictures('[Picture 1]\n[Picture 2]\n', [red, blue]), [
    { text: '[Picture 1]' },
    { image: red },
    { text: '\n[Picture 2]' },
    { image: blue },
  ]);
  assert.deepEqual(placePictures('  ', [red]), [{ image: red }]);
  assert.deepEqual(placePictures('  ', []), []);
});

test('only the exact marker counts', () => {
  assert.deepEqual(placePictures('[picture 1] [Picture1] [Picture 1 ]', [red]), [
    { image: red },
    { text: '[picture 1] [Picture1] [Picture 1 ]' },
  ]);
});

test('the pictures no marker places are counted, for the mirror\'s line', () => {
  assert.equal(unplacedPictures('this [Picture 1] and [Picture 2]', 2), 0);
  assert.equal(unplacedPictures('see [Picture 2]', 3), 2);
  assert.equal(unplacedPictures('no markers', 1), 1);
  assert.equal(unplacedPictures('[Picture 1] [Picture 1]', 1), 0);
});

// What another Mac's runner works out from a mirrored message's words
// alone (relay.ts): how many pictures it came with, and the words without
// the line sync.ts adds for the ones no marker places.
test('a mirrored message says how many pictures it came with, by its markers and its counting line', () => {
  assert.deepEqual(picturesSaid('Fix it'), { count: 0, words: 'Fix it' });
  assert.deepEqual(picturesSaid('[1 picture]'), { count: 1, words: '' });
  assert.deepEqual(picturesSaid('Look\n\n[3 pictures]'), { count: 3, words: 'Look' });
  assert.deepEqual(picturesSaid('this [Picture 1] like [Picture 2]'), { count: 2, words: 'this [Picture 1] like [Picture 2]' });
  // One placed, one not.
  assert.deepEqual(picturesSaid('like [Picture 2] please\n\n[1 picture]'), { count: 2, words: 'like [Picture 2] please' });
  // A marker naming no picture is only words, as placePictures has it.
  assert.deepEqual(picturesSaid('see [Picture 5]'), { count: 0, words: 'see [Picture 5]' });
  assert.deepEqual(picturesSaid('[Picture 1] and [Picture 3]'), { count: 1, words: '[Picture 1] and [Picture 3]' });
  // The line counts only at the very end, on a paragraph of its own.
  assert.deepEqual(picturesSaid('[2 pictures] came'), { count: 0, words: '[2 pictures] came' });
  assert.deepEqual(picturesSaid('I sent [2 pictures]'), { count: 0, words: 'I sent [2 pictures]' });
  // And agrees with what the sending runner counted.
  for (const [text, images] of [['a [Picture 1] b', 1], ['a', 2], ['[Picture 2] x', 3], ['', 1]] as const) {
    const unplaced = unplacedPictures(text, images);
    const note = unplaced === 1 ? '[1 picture]' : unplaced ? `[${unplaced} pictures]` : '';
    const mirrored = note ? (text ? `${text}\n\n${note}` : note) : text;
    assert.deepEqual(picturesSaid(mirrored), { count: images, words: text }, mirrored);
  }
});
