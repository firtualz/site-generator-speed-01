// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from scratch against the makefun-site README + baseline code (the
// reference). No dependencies. Deterministic: no clock, randomness, env or
// caching between cases. run(input) returns makefun-site's answer, byte for
// byte, for one case's input { site, templates, files }.
//
// Speed plan (measured: baseline spends ~72% in Markdown, ~19% in template
// rendering): a single-pass Markdown renderer that emits HTML directly (no
// token tree, no per-line regex, no per-character escape), templates compiled
// once per case into JS functions (no node-tree walk, no scope-chain walk per
// variable), and cheap wins (fast escape, ASCII fast path for slugs, memoized
// cards/slugs inside one build only).

// ------------------------------------------------------------------ text

/** HTML escape table, by char code. */
const ENT = [];
ENT[38] = '&amp;';
ENT[60] = '&lt;';
ENT[62] = '&gt;';
ENT[34] = '&quot;';
ENT[39] = '&#39;';

/** `text` with & < > " and ' escaped. Returns the input untouched when it holds none of them. */
export function escapeHtml(text) {
  let out = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ENT[text.charCodeAt(i)];
    if (e !== undefined) {
      if (out === null) out = text.slice(0, i);
      else out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  if (out === null) return text;
  return out + text.slice(start);
}

/** Whether char code `c` is JS whitespace (\s). */
function isWSCode(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JS \s, inlined (measured faster than a helper call or /\S+/g).
    const ws =
      c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text` (no cache): NFKD, combining marks dropped, A-Z lowered,
 *  each run of characters other than a-z and 0-9 one "-", none at either end,
 *  at most 64 characters, a "-" left at the cut dropped, "untitled" when
 *  nothing is left. ASCII input takes a fast path (NFKD is identity on ASCII). */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** slugify with a per-build cache (same string recurs: tag names, titles). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ------------------------------------------------------------ front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked
 * with indexOf, never split in full (the body can be long).
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let closeStart = -1;
  let closeEnd = -1;
  let cur = firstNl === -1 ? text.length : firstNl + 1;
  while (cur <= text.length) {
    const e = text.indexOf('\n', cur);
    const le = e === -1 ? text.length : e;
    if (text.slice(cur, le) === '---') {
      closeStart = cur;
      closeEnd = le;
      break;
    }
    if (e === -1) break;
    cur = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  cur = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1; // 0-based index of the line starting at cur
  while (cur < closeStart) {
    const e = text.indexOf('\n', cur);
    const le = e === -1 ? text.length : e;
    const line = text.slice(cur, le);
    if (!FM_BLANK.test(line) && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    cur = e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

/** Char codes of the characters a backslash escapes. */
const ESC = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESC[c] = 1;

function isEscapable(code) {
  return code < 128 && ESC[code] === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any JS whitespace character. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; `linkFn(target)` resolves a link's href. Single pass:
 *  plain runs are copied whole, specials are handled at their position. */
function inline(s, linkFn) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91 || c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out += s.slice(i, j);
    if (j >= n) break;
    const c = s.charCodeAt(j);
    if (c === 38) {
      out += '&amp;';
      i = j + 1;
    } else if (c === 60) {
      out += '&lt;';
      i = j + 1;
    } else if (c === 62) {
      out += '&gt;';
      i = j + 1;
    } else if (c === 34) {
      out += '&quot;';
      i = j + 1;
    } else if (c === 39) {
      out += '&#39;';
      i = j + 1;
    } else if (c === 92) {
      if (j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        const nc = s.charCodeAt(j + 1);
        out += nc === 62 ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += '<strong>' + inline(s.slice(j + 2, k), linkFn) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += '<em>' + inline(s.slice(j + 1, k), linkFn) + '</em>';
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', j + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWS(target)) {
        out += '<a href="' + escapeHtml(linkFn(target)) + '">' + inline(s.slice(j + 1, k), linkFn) + '</a>';
        i = m + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    }
  }
  return out;
}

// Line helpers over `src` (a line is [ls, le), le at '\n' or end).

/** Whether the line is blank (spaces and tabs only). */
function lineBlank(src, ls, le) {
  for (let p = ls; p < le; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the rest of the line from `p` holds spaces/tabs only. */
function lineRestBlank(src, p, le) {
  for (; p < le; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opening: '```' + optional language, then spaces/tabs only. Returns the language or null. */
function fenceOpen(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return null;
  let p = ls + 3;
  while (p < le) {
    const c = src.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) p++;
    else break;
  }
  if (!lineRestBlank(src, p, le)) return null;
  return src.slice(ls + 3, p);
}

/** Whether the line closes a fence: '```' then spaces/tabs only. */
function fenceClose(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return false;
  return lineRestBlank(src, ls + 3, le);
}

/** A heading line: 1-6 '#', space/tab, then non-empty text. Returns { depth, ts, te } or null. */
function headingAt(src, ls, le) {
  let p = ls;
  while (p < le && src.charCodeAt(p) === 35) p++;
  const depth = p - ls;
  if (depth === 0 || depth > 6) return null;
  if (p >= le) return null;
  const c = src.charCodeAt(p);
  if (c !== 32 && c !== 9) return null;
  while (p < le && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  let te = le;
  while (te > p && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
  if (te <= p) return null;
  return { depth, ts: p, te };
}

/** Whether the line is a thematic break: '---' or '***', then spaces/tabs only. */
function hrAt(src, ls, le) {
  if (le - ls < 3) return false;
  const c = src.charCodeAt(ls);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(ls + 1) !== c || src.charCodeAt(ls + 2) !== c) return false;
  return lineRestBlank(src, ls + 3, le);
}

/** Whether the line ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(src, ls, le) {
  return lineBlank(src, ls, le) || fenceOpen(src, ls, le) !== null || headingAt(src, ls, le) !== null || hrAt(src, ls, le);
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(src, ls, le) {
  let a = ls;
  let b = le;
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

/** A bullet marker: '- ' or '* '. Returns the rest start or -1. */
function bulletAt(src, ls, le) {
  if (le - ls < 2) return -1;
  const c = src.charCodeAt(ls);
  if ((c === 45 || c === 42) && src.charCodeAt(ls + 1) === 32) return ls + 2;
  return -1;
}

/** An ordered marker: 1-9 digits, '. '. Returns { start, rest } or null. */
function orderedAt(src, ls, le) {
  let p = ls;
  let digits = 0;
  while (p < le && digits < 9) {
    const c = src.charCodeAt(p);
    if (c < 48 || c > 57) break;
    p++;
    digits++;
  }
  if (digits === 0) return null;
  if (p + 1 >= le || src.charCodeAt(p) !== 46 || src.charCodeAt(p + 1) !== 32) return null;
  return { start: Number(src.slice(ls, p)), rest: p + 2 };
}

/** A list continuation line: two or more spaces then a non-space. */
function continuedAt(src, ls, le) {
  let p = ls;
  while (p < le && src.charCodeAt(p) === 32) p++;
  if (p - ls < 2 || p >= le) return false;
  return !isWSCode(src.charCodeAt(p));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Single pass over the input,
 * no token tree, no per-line regex.
 */
export function renderMarkdown(src, linkFn, slugCache) {
  const n = src.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let out = '';
  let i = 0;
  while (i < n) {
    const nl = src.indexOf('\n', i);
    const le = nl === -1 ? n : nl;
    const next = nl === -1 ? n : nl + 1;
    if (lineBlank(src, i, le)) {
      i = next;
      continue;
    }
    const lang = fenceOpen(src, i, le);
    if (lang !== null) {
      let body = '';
      let closed = false;
      i = next;
      while (i < n) {
        const nl2 = src.indexOf('\n', i);
        const le2 = nl2 === -1 ? n : nl2;
        const next2 = nl2 === -1 ? n : nl2 + 1;
        if (fenceClose(src, i, le2)) {
          i = next2;
          closed = true;
          break;
        }
        body += escapeHtml(src.slice(i, le2)) + '\n';
        i = next2;
      }
      // A fence running to the end of input also takes the empty line after
      // a trailing newline (split('\n') yields it as a final empty line).
      if (!closed && n > 0 && src.charCodeAt(n - 1) === 10) body += '\n';
      out += '<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>' + body + '</code></pre>\n';
      continue;
    }
    const h = headingAt(src, i, le);
    if (h !== null) {
      const text = src.slice(h.ts, h.te);
      const id = uniqueSlug(slugify(text, slugCache), ids);
      const html = inline(text, linkFn);
      out += `<h${h.depth} id="${id}">${html}</h${h.depth}>\n`;
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i = next;
      continue;
    }
    if (hrAt(src, i, le)) {
      out += '<hr>\n';
      i = next;
      continue;
    }
    if (src.charCodeAt(i) === 62) {
      // Blockquote: lines opening on '>'.
      const lines = [];
      while (i < n && src.charCodeAt(i) === 62) {
        const nl2 = src.indexOf('\n', i);
        const le2 = nl2 === -1 ? n : nl2;
        const next2 = nl2 === -1 ? n : nl2 + 1;
        let a = i + 1;
        if (a < le2 && src.charCodeAt(a) === 32) a++;
        const t = trimLine(src, a, le2);
        if (t !== '') lines.push(t);
        i = next2;
      }
      out += lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(lines.join('\n'), linkFn)}</p>\n</blockquote>\n`;
      continue;
    }
    const bRest = bulletAt(src, i, le);
    const oMark = bRest === -1 ? orderedAt(src, i, le) : null;
    if (bRest !== -1 || oMark !== null) {
      const isOrdered = oMark !== null;
      const start = isOrdered ? oMark.start : 1;
      const items = [];
      let first = true;
      while (i < n) {
        const nl2 = src.indexOf('\n', i);
        const le2 = nl2 === -1 ? n : nl2;
        const next2 = nl2 === -1 ? n : nl2 + 1;
        let rest = -1;
        if (!isOrdered) rest = bulletAt(src, i, le2);
        else {
          const om = orderedAt(src, i, le2);
          rest = om === null ? -1 : om.rest;
        }
        if (rest !== -1) {
          items.push([trimLine(src, rest, le2)]);
          i = next2;
          first = false;
        } else if (!first && continuedAt(src, i, le2)) {
          items[items.length - 1].push(trimLine(src, i, le2));
          i = next2;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inline(parts.join('\n'), linkFn)}</li>\n`;
      out += `${open}\n${inner}</${tag}>\n`;
      continue;
    }
    // Paragraph: lines up to a blank line, a fence, a heading or a break.
    const parts = [trimLine(src, i, le)];
    i = next;
    while (i < n) {
      const nl2 = src.indexOf('\n', i);
      const le2 = nl2 === -1 ? n : nl2;
      const next2 = nl2 === -1 ? n : nl2 + 1;
      if (endsParagraph(src, i, le2)) break;
      parts.push(trimLine(src, i, le2));
      i = next2;
    }
    const html = inline(parts.join('\n'), linkFn);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template into a function (scope, templates, depth) => string.
 * Scopes are null-prototype objects chained by prototype: the first path
 * segment reads from the nearest scope holding it (a single `in` check), later
 * segments are own properties of the value so far. Emitted code mirrors the
 * reference semantics exactly (textOf, truthy, include depth, loop object
 * winning over an element bound under the same name "loop").
 */
function compileNodes(nodes) {
  let code = '';
  let uniq = 0;
  const gen = (ns, scope) => {
    for (const n of ns) {
      if (n.kind === 'text') {
        code += 'o+=' + JSON.stringify(n.text) + ';\n';
      } else if (n.kind === 'var' || n.kind === 'raw') {
        code += lookupCode(n.path, scope);
        code += n.kind === 'var' ? 'o+=esc(tx(v));\n' : 'o+=tx(v);\n';
      } else if (n.kind === 'if') {
        code += lookupCode(n.path, scope);
        code += n.not ? 'if(ty(v)===false){\n' : 'if(ty(v)){\n';
        gen(n.then, scope);
        code += '}';
        if (n.else !== null) {
          code += 'else{\n';
          gen(n.else, scope);
          code += '}';
        }
        code += '\n';
      } else if (n.kind === 'for') {
        const id = uniq++;
        const xs = 'x' + id;
        const k = 'k' + id;
        const sc = 's' + id;
        code += lookupCode(n.path, scope);
        code += `if(Array.isArray(v)){const ${xs}=v;for(let ${k}=0;${k}<${xs}.length;${k}++){const ${sc}=Object.create(${scope});${sc}[${JSON.stringify(n.name)}]=${xs}[${k}];${sc}.loop={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};\n`;
        gen(n.body, sc);
        code += '}}\n';
      } else if (n.kind === 'include') {
        code += `if(D<${INCLUDE_DEPTH}){const t=T.get(${JSON.stringify(n.name)});if(t!==undefined)o+=t(${scope},T,D+1,esc,tx,ty);}\n`;
      }
    }
  };
  // Emit a path lookup into the shared temp `v`, for scope variable `scope`.
  function lookupCode(path, scope) {
    let c = `if(${JSON.stringify(path[0])} in ${scope}){v=${scope}[${JSON.stringify(path[0])}];`;
    for (let k = 1; k < path.length; k++) {
      c += `if(v!==null&&typeof v==='object'&&Object.hasOwn(v,${JSON.stringify(path[k])})){v=v[${JSON.stringify(path[k])}];}else{v=undefined;}`;
    }
    c += '}else{v=undefined;}\n';
    return c;
  }
  gen(nodes, 'S');
  return code;
}

/** Compile one template's source into its render function (a TemplateError when it does not parse). */
export function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const body = 'let o=\'\';\nlet v;\n' + compileNodes(nodes) + 'return o;';
  return new Function('S', 'T', 'D', 'esc', 'tx', 'ty', body);
}

// -------------------------------------------------------------------- build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
function build(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const link = (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      };
      const md = renderMarkdown(s.body, link, slugCache);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name, slugCache)) && seen.add(slugify(name, slugCache)));
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name, slugCache);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // A page's link record as templates read it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  // A tag as templates read it (its posts as cards).
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  // A post's card, as lists show it (memoized: pageOf builds it again per source).
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const render = (name, vars) => {
      const fn = b.templates.get(name);
      if (fn === undefined) return null;
      const scope = Object.create(null);
      scope.site = site;
      scope.tags = allTags;
      scope.recent = recent;
      Object.assign(scope, vars);
      return fn(scope, b.templates, 0, escapeHtml, textOf, truthy);
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
