// Every browser script parses. (Tests import some of them, but not the page scripts; a typo there would only show
// up as a blank page in the browser.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('all client scripts are valid JavaScript', () => {
  const files = ['public/config.js', 'public/site.js', ...readdirSync('public/js').filter((f) => f.endsWith('.js')).map((f) => `public/js/${f}`)];
  for (const file of files) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }), file);
  }
});
