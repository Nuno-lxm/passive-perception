// @ts-check
// Turns prep notes into cards. Pure: no DOM, so `node --test` covers it.
//
//   # The Manor                  a group: the cards below go in it ("#" alone ends the group)
//   ## Cold draft                a card title (every card starts with "##")
//   You feel a cold draft…       anything else is the card's text
//   for: Ireena, Ismark          optional: players it's usually for ("everyone" = all of them)
//   note: DC 15 Perception       optional: the DM's private note
//
// Portuguese keywords work too: "para:" and "nota:". Keywords are case-insensitive.

const LIMITS = { title: 120, body: 4000, group: 40, note: 1000, cards: 200 };
const FOR = /^(for|para)\s*:\s*(.*)$/i;
const NOTE = /^(note|nota)\s*:\s*(.*)$/i;
const EVERYONE = new Set(['everyone', 'all', 'todos', 'toda a gente']);

/**
 * @typedef {{ title: string, body: string, grp: string | null, note: string, forSeats: string[] }} ImportedCard
 * @typedef {{ code: string, card?: string, value?: string }} ImportWarning  code: a translation key suffix
 */

/**
 * @param {string} text
 * @param {{ id: string, name: string }[]} seats  The room's seats, to match "for:" names.
 * @returns {{ cards: ImportedCard[], warnings: ImportWarning[], errors: ImportWarning[] }}
 *   Warnings are informational; errors mean the import must not go ahead.
 */
export function parseCards(text, seats) {
  /** @type {ImportedCard[]} */
  const cards = [];
  /** @type {ImportWarning[]} */
  const warnings = [];
  /** @type {ImportWarning[]} */
  const errors = [];
  /** @type {string | null} */
  let group = null;
  /** @type {(ImportedCard & { lines: string[], notes: string[] }) | null} */
  let card = null;
  let strayText = false;

  const byName = new Map(seats.map((seat) => [fold(seat.name), seat.id]));

  const finish = () => {
    if (!card) return;
    const body = trimBlankLines(card.lines).join('\n');
    const note = card.notes.join('\n').trim();
    if (card.title || body) {
      cards.push({ title: card.title, body, grp: card.grp, note, forSeats: card.forSeats });
      if (body.length > LIMITS.body) errors.push({ code: 'bodyTooLong', card: card.title });
      if (note.length > LIMITS.note) errors.push({ code: 'noteTooLong', card: card.title });
    }
    card = null;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const heading = line.match(/^(#{1,2})(?!#)\s*(.*)$/);

    if (heading && heading[1] === '#') {
      finish();
      group = heading[2].trim() || null;
      if (group && group.length > LIMITS.group) {
        warnings.push({ code: 'groupShortened', value: group });
        group = group.slice(0, LIMITS.group);
      }
      continue;
    }
    if (heading && heading[1] === '##') {
      finish();
      let title = heading[2].trim();
      if (title.length > LIMITS.title) {
        warnings.push({ code: 'titleShortened', card: title.slice(0, 40) });
        title = title.slice(0, LIMITS.title);
      }
      card = { title, body: '', grp: group, note: '', forSeats: [], lines: [], notes: [] };
      continue;
    }
    if (!card) {
      if (line.trim()) strayText = true; // text before the first "##" has no card to go in
      continue;
    }
    const forLine = line.trim().match(FOR);
    if (forLine) {
      for (const name of forLine[2].split(/\s*(?:,|;|\s+and\s+|\s+e\s+)\s*/i).map((n) => n.trim()).filter(Boolean)) {
        if (EVERYONE.has(fold(name))) {
          for (const seat of seats) if (!card.forSeats.includes(seat.id)) card.forSeats.push(seat.id);
          continue;
        }
        const id = byName.get(fold(name));
        if (id) {
          if (!card.forSeats.includes(id)) card.forSeats.push(id);
        } else {
          warnings.push({ code: 'unknownPlayer', card: card.title, value: name });
        }
      }
      continue;
    }
    const noteLine = line.trim().match(NOTE);
    if (noteLine) {
      card.notes.push(noteLine[2]);
      continue;
    }
    card.lines.push(line);
  }
  finish();

  if (strayText) warnings.push({ code: 'strayText' });
  if (!cards.length) errors.push({ code: 'noCards' });
  if (cards.length > LIMITS.cards) errors.push({ code: 'tooMany', value: String(LIMITS.cards) });
  return { cards, warnings, errors };
}

/** Case- and accent-insensitive, so "irena" ≠ "Ireena" but "Ândrea" = "andrea". @param {string} s */
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();

/** @param {string[]} lines */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}
