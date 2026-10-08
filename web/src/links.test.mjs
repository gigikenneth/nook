// Self-check for chat link detection. Run: node web/src/links.test.mjs
import assert from 'node:assert';
import { findLinks } from './links.js';

const hrefs = (t) => findLinks(t).map((l) => l.href);

assert.deepEqual(hrefs('see https://example.com/page'), ['https://example.com/page'], 'pasted link');
assert.deepEqual(hrefs('www.notion.so/my-page'), ['https://www.notion.so/my-page'], 'www link gets a scheme');
assert.deepEqual(hrefs('figma.com/file/abc?x=1'), ['https://figma.com/file/abc?x=1'], 'bare domain with path');
assert.deepEqual(hrefs('try google.com'), ['https://google.com'], 'bare domain alone');
assert.deepEqual(hrefs('bbc.co.uk/news'), ['https://bbc.co.uk/news'], 'multi-part TLD');

// Trailing punctuation stays outside.
assert.deepEqual(hrefs('check https://example.com/page.'), ['https://example.com/page'], 'full stop');
assert.deepEqual(hrefs('example.com, or'), ['https://example.com'], 'comma');
assert.deepEqual(hrefs('wow https://x.com/a!?'), ['https://x.com/a'], 'bang and question mark');
assert.deepEqual(hrefs('(see https://example.com)'), ['https://example.com'], 'closing bracket of the sentence');
assert.deepEqual(hrefs('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)'], 'bracket inside the link kept');
assert.deepEqual(hrefs('"https://example.com"'), ['https://example.com'], 'quotes');

// Things that aren't links.
assert.deepEqual(hrefs('mail hello@gigikenneth.com'), [], 'email address');
assert.deepEqual(hrefs('e.g. this, i.e. that'), [], 'abbreviations');
assert.deepEqual(hrefs('built with node.js and file.txt'), [], 'file names');
assert.deepEqual(hrefs('example.community'), [], 'TLD prefix of a longer word');
assert.deepEqual(hrefs('javascript:alert(1)'), [], 'no script links');

// Positions and label, for rendering.
const [l] = findLinks('go to https://example.com/x/. now');
assert.equal('go to https://example.com/x/. now'.slice(l.start, l.end), 'https://example.com/x/', 'span excludes the full stop');
assert.equal(l.label, 'example.com/x', 'label drops scheme and trailing slash');

console.log('links self-check: all passed');
