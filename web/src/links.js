// Find the links in a chat message. Pure text work: nothing is fetched and
// nothing leaves the browser. Catches pasted https:// links, www. links and bare
// domains like figma.com/file/x, and leaves trailing punctuation outside the link
// so "see example.com/page." doesn't send people to "page.".

// ponytail: a short list of common TLDs, so "e.g." or "node.js" never link. Add
// a TLD here if people share links from one that's missing.
const TLDS = 'com|org|net|io|co|so|dev|app|me|ai|gg|tv|xyz|tech|info|edu|gov|page|site|link|ly|to|fm|uk|us|ca|de|fr|pl|ng|ke|za|in|au|eu|nl|es|it';
// Not right after @ (an email address) or mid-word. Group 1 eats the character
// before the link; no lookbehind, which Safari before 16.4 can't parse.
const URL_RE = new RegExp(
  String.raw`(^|[^@\w.\/-])((?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:[/?#][^\s<>"]*)?))`,
  'gi',
);

// Drop sentence punctuation off the end, and a ")" that closes the sentence's
// bracket rather than one inside the link (wikipedia.org/wiki/Foo_(bar) keeps it).
function trimEnd(url) {
  for (;;) {
    const c = url.at(-1);
    if ('.,!?;:\'"'.includes(c)) url = url.slice(0, -1);
    else if (c === ')' && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
    else return url;
  }
}

// -> [{ start, end, href, label }]
export function findLinks(text) {
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const url = trimEnd(m[2]);
    const start = m.index + m[1].length;
    if (!url.includes('.')) continue; // "https://" on its own
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const bare = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const label = bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
    out.push({ start, end: start + url.length, href, label });
  }
  return out;
}
