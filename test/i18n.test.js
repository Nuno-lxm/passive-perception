// Every locale has exactly the keys English has, and every key the client uses exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import en from '../public/js/locales/en.js';
import ptPT from '../public/js/locales/pt-PT.js';

const DYNAMIC = {
  'dm.tab.': ['table', 'cards', 'room'],
  'presence.': ['online', 'away', 'offline', 'unclaimed'],
  'status.': ['connecting', 'open', 'offline', 'stopped'],
  'signedOut.': ['moved', 'released', 'removed', 'left', 'other'],
  'theme.': ['candlelit', 'daylight', 'auto'],
};

test('pt-PT has the same keys as English, with the same placeholders', () => {
  assert.deepEqual(Object.keys(ptPT).sort(), Object.keys(en).sort());
  const placeholders = (value) => JSON.stringify(value).match(/\{\w+\}/g)?.sort() ?? [];
  for (const key of Object.keys(en)) {
    for (const form of typeof en[key] === 'object' ? Object.keys(en[key]) : [null]) {
      const a = form ? en[key][form] : en[key];
      const b = form ? ptPT[key][form] ?? ptPT[key].other : ptPT[key];
      assert.deepEqual(placeholders(b), placeholders(a), key);
    }
  }
});

test('every translation key used in the client exists', () => {
  const sources = [
    ...readdirSync('public/js').filter((f) => f.endsWith('.js')).map((f) => readFileSync(`public/js/${f}`, 'utf8')),
    ...readdirSync('public').filter((f) => f.endsWith('.html')).map((f) => readFileSync(`public/${f}`, 'utf8')),
  ].join('\n');
  const used = new Set([
    ...[...sources.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...sources.matchAll(/data-i18n(?:-[\w-]+)?="([\w.]+)"/g)].map((m) => m[1]),
    ...Object.entries(DYNAMIC).flatMap(([prefix, names]) => names.map((n) => prefix + n)),
  ]);
  for (const key of used) assert.ok(key in en, `missing key: ${key}`);
});

test('every error code the server can send has a message', () => {
  const server = readdirSync('src/core').map((f) => readFileSync(`src/core/${f}`, 'utf8')).join('\n');
  const codes = new Set([
    ...[...server.matchAll(/fail\('(\w+)'/g)].map((m) => m[1]),
    ...[...server.matchAll(/InputError\('(\w+)'/g)].map((m) => m[1]),
    ...[...server.matchAll(/error: '(\w+)'/g)].map((m) => m[1]),
  ]);
  codes.delete('not_found');
  codes.delete('room_exists');
  codes.delete('room_code_exhausted');
  codes.delete('room_unavailable');
  codes.delete('bad_origin');
  for (const code of codes) assert.ok(`error.${code}` in en, `no message for error code ${code}`);
});
