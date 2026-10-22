import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards } from '../public/js/import-text.js';

const SEATS = [{ id: 's1', name: 'Ireena' }, { id: 's2', name: 'Ismark' }, { id: 's3', name: 'Ândrea' }];

test('groups, titles, text, players and notes', () => {
  const { cards, warnings, errors } = parseCards(`# The Manor
## Cold draft
You feel a cold draft from behind the bookcase.

Something is hidden there.
for: Ireena, ismark
note: DC 15 Perception

## Torn map
A map of the valley.
NOTE: only after the fight

#
## No group
Plain text.
`, SEATS);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(cards, [
    { title: 'Cold draft', body: 'You feel a cold draft from behind the bookcase.\n\nSomething is hidden there.', grp: 'The Manor', note: 'DC 15 Perception', forSeats: ['s1', 's2'] },
    { title: 'Torn map', body: 'A map of the valley.', grp: 'The Manor', note: 'only after the fight', forSeats: [] },
    { title: 'No group', body: 'Plain text.', grp: null, note: '', forSeats: [] },
  ]);
});

test('Portuguese keywords, "everyone", accents and "e" between names', () => {
  const { cards } = parseCards(`## Pista
para: andrea e Ireena
nota: só se passarem
## Todos
para: todos`, SEATS);
  assert.deepEqual(cards[0].forSeats, ['s3', 's1']);
  assert.equal(cards[0].note, 'só se passarem');
  assert.deepEqual(cards[1].forSeats, ['s1', 's2', 's3']);
});

test('unknown players and stray text are warnings; no cards is an error', () => {
  const { warnings } = parseCards(`Some intro text.
## Clue
for: Irena`, SEATS);
  assert.deepEqual(warnings, [{ code: 'unknownPlayer', card: 'Clue', value: 'Irena' }, { code: 'strayText' }]);
  assert.deepEqual(parseCards('just some notes\nwithout headings', SEATS).errors, [{ code: 'noCards' }]);
});

test('### and deeper headings stay in the text; long titles are shortened with a warning', () => {
  const { cards, warnings } = parseCards(`## ${'T'.repeat(130)}
### A subheading stays
text`, SEATS);
  assert.equal(cards[0].title.length, 120);
  assert.equal(cards[0].body, '### A subheading stays\ntext');
  assert.equal(warnings[0].code, 'titleShortened');
});

test('too much text in a card blocks the import', () => {
  const { errors } = parseCards(`## Big\n${'x'.repeat(4001)}`, SEATS);
  assert.deepEqual(errors, [{ code: 'bodyTooLong', card: 'Big' }]);
});

test('Windows line endings and trailing spaces', () => {
  const { cards } = parseCards('## A  \r\nline one  \r\n\r\nfor: Ireena\r\n', SEATS);
  assert.deepEqual(cards, [{ title: 'A', body: 'line one', grp: null, note: '', forSeats: ['s1'] }]);
});
