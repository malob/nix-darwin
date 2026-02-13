/* =================================================================
   OPTIONS DATA GUARD
   ================================================================= */

if (typeof OPTIONS_DATA === 'undefined') {
  console.error('OPTIONS_DATA not loaded. Ensure options-data.js is included before this script.');
}

/* =================================================================
   APP STATE
   ================================================================= */

const state = {
  query: '',
  path: [],        // e.g. ['system', 'defaults', 'dock']
  expanded: null,
  options: [],
};

let optionTree = null;  // built once at init

// Incremental rendering state
const RENDER_BATCH = 50;
const TYPE_BADGE_MAX_CHARS = 28;
const renderQueue = { results: [], terms: [], pathPrefix: '', groupPrefixes: null, rendered: 0, bandKey: '', bandParity: false };

// Dropdown state (ephemeral UI, not part of reactive state)
const dropdown = {
  open: false,
  depth: -1,
  items: [],
  filtered: [],
  filterText: '',
  highlighted: 0,
  anchorEl: null,
  anchorRect: null,
  hiddenEls: [],
};


/* =================================================================
   UTILITIES
   ================================================================= */

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/* =================================================================
   NIX ECOSYSTEM

   Everything below this banner depends on Nix / nixpkgs conventions.
   A future maintainer updating for ecosystem changes should start
   here — search for "ECOSYSTEM COUPLING" to find each dependency.
   ================================================================= */

/* ── Nix attribute path handling ───────────────────────────────
   ECOSYSTEM COUPLING: Functions below parse Nix attribute paths
   (dot-separated, with quoted identifiers for segments containing
   dots, and <name>/* wildcards for parameterized options).
   Update if: nixosOptionsDoc changes its option naming conventions.
   Degrades gracefully: unrecognized patterns display as-is (the
   name still appears, just without prefix/leaf splitting or
   parameterized segment merging).
   ─────────────────────────────────────────────────────────────── */

/** Split a Nix attribute path into segments, respecting quoted identifiers.
 *  e.g. 'system.defaults.".GlobalPreferences"."com.apple.mouse.scaling"'
 *  => ['system', 'defaults', '".GlobalPreferences"', '"com.apple.mouse.scaling"'] */
function splitAttrPath(name) {
  const segments = [];
  let i = 0;
  while (i < name.length) {
    if (name[i] === '"') {
      // Quoted segment: collect until closing quote
      const end = name.indexOf('"', i + 1);
      if (end === -1) { segments.push(name.substring(i)); break; }
      segments.push(name.substring(i, end + 1));
      i = end + 1;
      if (i < name.length && name[i] === '.') i++; // skip separator
    } else {
      // Unquoted segment: collect until dot or end
      const dot = name.indexOf('.', i);
      if (dot === -1) { segments.push(name.substring(i)); break; }
      segments.push(name.substring(i, dot));
      i = dot + 1;
    }
  }
  return segments;
}

/** Get the first logical attribute path segment from a (possibly prefix-stripped) name.
 *  Parameterized segments (<name>, *) are absorbed into the following segment so that
 *  e.g. "<name>.serviceConfig.foo" returns "<name>.serviceConfig" — this prevents
 *  parameterized wildcards from collapsing all options into one banding group. */
function firstAttrSegment(name) {
  if (!name) return { segment: '', length: 0 };
  let pos = 0;
  for (;;) {
    let segEnd;
    if (name[pos] === '"') {
      const close = name.indexOf('"', pos + 1);
      segEnd = close === -1 ? name.length : close + 1;
    } else {
      const dot = name.indexOf('.', pos);
      segEnd = dot === -1 ? name.length : dot;
    }
    const nextPos = segEnd < name.length && name[segEnd] === '.' ? segEnd + 1 : segEnd;
    const seg = name.substring(pos, segEnd);
    // If parameterized and more segments follow, absorb and continue to the next
    if ((seg[0] === '<' || seg === '*') && nextPos < name.length) {
      pos = nextPos;
      continue;
    }
    return { segment: name.substring(0, segEnd), length: nextPos };
  }
}

/** Extract the leaf (final segment) of a Nix attribute path.
 *  Used once per option at init time for search scoring. */
function leafOf(name) {
  const segments = splitAttrPath(name);
  return segments.length > 0 ? segments[segments.length - 1] : name;
}

/** Split a display name (possibly prefix-stripped) for rendering.
 *  Returns the split index where prefix ends and leaf begins. */
function splitDisplay(displayName) {
  const segments = splitAttrPath(displayName);
  if (segments.length <= 1) return { prefix: '', leaf: displayName, splitIndex: 0 };
  const leaf = segments[segments.length - 1];
  const splitIndex = displayName.length - leaf.length;
  return {
    prefix: displayName.substring(0, splitIndex),
    leaf,
    splitIndex,
  };
}

/** Merge parameterized segments (<name>, *) with the preceding segment so that
 *  e.g. ['launchd', 'daemons', '<name>', 'serviceConfig'] becomes
 *  ['launchd', 'daemons.<name>', 'serviceConfig'].
 *  ECOSYSTEM COUPLING: Relies on <name> and * wildcard conventions from
 *  nixosOptionsDoc for parameterized (freeform) module options. */
function mergeParamSegments(segments) {
  const result = [];
  for (const seg of segments) {
    if (result.length > 0 && (seg[0] === '<' || seg === '*')) {
      result[result.length - 1] += '.' + seg;
    } else {
      result.push(seg);
    }
  }
  return result;
}

/* ── Nix option value formatting ───────────────────────────────
   ECOSYSTEM COUPLING: nixosOptionsDoc wraps non-trivial default and
   example values in { _type: "literalExpression", text: "..." } or
   { _type: "literalMD", text: "..." }. Unrecognized shapes fall
   back to JSON.stringify.
   ─────────────────────────────────────────────────────────────── */

function formatValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (val._type === 'literalExpression' || val._type === 'literalMD') return val.text;
  return JSON.stringify(val, null, 2);
}

/* ── Nix type expression handling ──────────────────────────────
   ECOSYSTEM COUPLING: Functions below parse Nix type expressions
   as produced by the nixpkgs type system (e.g., "list of attribute
   set of string", "null or boolean", "one of ...").
   Update if: nixpkgs adds new type combinators or changes type
   string representations. Unrecognized types degrade gracefully
   to type-other (badge color) and pass-through display.
   ─────────────────────────────────────────────────────────────── */

function getTypeClass(type) {
  const t = type.toLowerCase().trim();
  // Strip balanced outer parens
  if (t[0] === '(' && matchParen(t, 0) === t.length - 1)
    return getTypeClass(t.slice(1, -1));
  // Strip qualifiers that don't affect classification
  if (t.startsWith('null or ')) return getTypeClass(t.slice(8));
  if (t.startsWith('non-empty ')) return getTypeClass(t.slice(10));
  if (t.startsWith('lazy ')) return getTypeClass(t.slice(5));
  // Unions: unanimous type or 'other'
  const parts = splitOr(t);
  if (parts.length > 1) {
    const classes = parts.map(p => getTypeClass(p));
    return classes.every(c => c === classes[0]) ? classes[0] : 'type-other';
  }
  // Containers
  if (t.startsWith('list of')) return 'type-list';
  if (t.startsWith('attribute set')) return 'type-attrs';
  // Structural types first (their contents can contain scalar keywords)
  if (t.includes('one of')) return 'type-enum';
  if (t.includes('submodule')) return 'type-submod';
  // Scalars
  if (t === 'boolean') return 'type-bool';
  if (t.includes('path')) return 'type-path';
  if (t.includes('package')) return 'type-package';
  if (t.includes('string') || t.includes('concatenated')) return 'type-string';
  if (t.includes('integer') || t.includes('int')) return 'type-int';
  if (t.includes('float')) return 'type-int';  // numeric types share a badge color
  return 'type-other';
}

/** Find index of the closing paren matching s[i], or -1. */
function matchParen(s, i) {
  let d = 1;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '(') d++;
    else if (s[j] === ')') { if (--d === 0) return j; }
  }
  return -1;
}

/** Split s on top-level ' or ' (skipping occurrences inside parentheses). */
function splitOr(s) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (depth === 0 && s.startsWith(' or ', i)) {
      parts.push(s.substring(start, i));
      start = i + 4;
      i += 3;
    }
  }
  parts.push(s.substring(start));
  return parts;
}

/** Recursively format a Nix type expression with container notation.
 *  list of X → [X], attribute set of X → { X }, X or Y → X | Y */
function formatType(s) {
  s = s.trim();
  if (s[0] === '(' && matchParen(s, 0) === s.length - 1)
    return formatType(s.slice(1, -1));
  const parts = splitOr(s);
  if (parts.length > 1) return parts.map(formatType).join(' | ');
  if (s.startsWith('lazy ')) return formatType(s.slice(5));
  if (s.startsWith('list of ')) return '[' + formatType(s.slice(8)) + ']';
  if (s.startsWith('attribute set of ')) return '{ ' + formatType(s.slice(17)) + ' }';
  if (s === 'attribute set') return 'attrs';
  if (s.startsWith('one of ')) return '(' + s.slice(7).split(', ').join(' | ') + ')';
  return s;
}

function typeLabel(type, limit) {
  let s = type;
  s = s.replace(/strings concatenated with .+/, 'strings (concat)');
  s = s.replace(/\(submodule\) or string convertible to it/, 'submodule | string');
  s = s.replace(/positive integer, meaning >0, /g, 'int > 0 ');
  s = s.replace(/positive integer, meaning >0/g, 'int > 0');
  s = s.replace(/(?:16 bit unsigned )?integer;? between (\d+) and (\d+) \(both inclusive\)/g, 'int [$1, $2]');
  s = s.replace(/signed integer/, 'int');
  s = s.replace(/integer/g, 'int');
  s = s.replace(/floating point number/, 'float');
  s = s.replace(/absolute path/g, 'path');
  s = s.replace(/ \(singular enum\)/g, '');
  s = formatType(s);
  // Nullable shorthand: null | X → X?
  let nullable = false;
  if (s.startsWith('null | ')) {
    nullable = true;
    s = s.slice(7);
    // Wrap in parens if there are top-level pipes, so "boolean | string"
    // becomes "(boolean | string)?" — but skip if already delimited like
    // "(0 | 1)" which is fine as "(0 | 1)?" without extra wrapping.
    let depth = 0, topPipe = false;
    for (let i = 0; !topPipe && i < s.length; i++) {
      if ('([{'.includes(s[i])) depth++;
      else if (')]}'.includes(s[i])) depth--;
      else if (depth === 0 && s[i] === '|') topPipe = true;
    }
    if (topPipe) s = '(' + s + ')';
  }
  const qm = nullable ? '?' : '';
  if (!limit) return s + qm;
  const maxLen = limit - qm.length;
  if (s.length <= maxLen) return s + qm;
  const close = s[0] === '[' ? '\u2026]' : s[0] === '{' ? '\u2026 }' : s[0] === '(' ? '\u2026)' : '\u2026';
  return s.substring(0, maxLen - close.length) + close + qm;
}

/** Range-based search term highlighting for option names.
 *  Handles mark/span interleaving by cutting the string at all
 *  boundary points and iterating the resulting segments. */
function highlightName(displayName, splitIndex, terms) {
  // Find all match ranges
  const ranges = [];
  for (const term of terms) {
    const re = new RegExp(escRegex(term), 'gi');
    let m;
    while ((m = re.exec(displayName)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }

  // Merge overlapping/adjacent ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  if (!merged.length) {
    // No matches — fast path
    const { prefix, leaf } = splitDisplay(displayName);
    return `<span class="opt-prefix">${esc(prefix).replace(/\./g, '<wbr>.')}</span><span class="opt-leaf">${esc(leaf).replace(/\./g, '<wbr>.')}</span>`;
  }

  // Collect all cut points (deduplicated, sorted)
  const len = displayName.length;
  const cuts = new Set([0, len]);
  if (splitIndex > 0 && splitIndex < len) cuts.add(splitIndex);
  for (const [s, e] of merged) { cuts.add(s); cuts.add(e); }
  const points = [...cuts].sort((a, b) => a - b);

  // Build a Set of highlighted character positions for O(1) lookup
  const highlighted = new Set();
  for (const [s, e] of merged) {
    for (let i = s; i < e; i++) highlighted.add(i);
  }

  // Iterate segments, open/close <mark> and <span> as needed
  let html = '';
  let inMark = false;

  for (let si = 0; si < points.length - 1; si++) {
    const segStart = points[si];
    const segEnd = points[si + 1];
    const isMark = highlighted.has(segStart);
    const cls = splitIndex > 0 && segStart < splitIndex ? 'opt-prefix' : 'opt-leaf';

    // Close/open mark boundaries
    if (inMark && !isMark) { html += '</mark>'; inMark = false; }
    if (!inMark && isMark) { html += '<mark>'; inMark = true; }

    // Emit span-wrapped segment
    html += `<span class="${cls}">`;
    for (let i = segStart; i < segEnd; i++) {
      const ch = displayName[i];
      if (ch === '.') html += '<wbr>';
      html += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
    }
    html += '</span>';
  }

  if (inMark) html += '</mark>';
  return html;
}


/* =================================================================
   SEARCH SCORING

   Scores how well an option matches the search query. Higher = better.
   Returns -1 for non-matches.

   Priority:
     1. Full query appears contiguously in the option name
     2. Query terms joined (no spaces) appear in the name
     3. All terms appear somewhere in the option name
     4. Terms appear in the leaf (final segment) of the name
     5. Terms only found in description/type (lowest rank)
   ================================================================= */

function scoreOption(opt, terms, fullQuery) {
  if (!terms.length) return 0;

  const name = opt.nameLower;
  const leaf = opt.leafLower;
  const desc = opt.descLower;

  if (!terms.every(t => name.includes(t) || desc.includes(t))) return -1;

  let score = 0;

  if (name.includes(fullQuery)) score += 100;

  const compact = fullQuery.replace(/\s+/g, '');
  if (compact.length > 1 && name.includes(compact)) score += 80;

  if (terms.every(t => name.includes(t))) score += 60;

  for (const t of terms) {
    if (leaf.includes(t)) score += 20;
    else if (name.includes(t)) score += 10;
  }

  if (terms.some(t => name.startsWith(t))) score += 5;

  return score;
}


/* =================================================================
   OPTION TREE

   Each node: { children: Map<string, node>, totalCount }
   totalCount = number of options under this prefix (all descendants).
   Built once at init by walking dot-separated option name segments.
   ================================================================= */

function buildTree(options) {
  const root = { children: new Map(), totalCount: options.length };

  for (const opt of options) {
    const segments = mergeParamSegments(splitAttrPath(opt.name));
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, { children: new Map(), totalCount: 0 });
      }
      node = node.children.get(seg);
      node.totalCount++;
    }
  }

  return root;
}

function getNodeAtPath(path) {
  let node = optionTree;
  for (const seg of path) {
    if (!node || !node.children.has(seg)) return null;
    node = node.children.get(seg);
  }
  return node;
}

function getChildrenAtPath(path) {
  const node = getNodeAtPath(path);
  if (!node || node.children.size === 0) return [];
  return [...node.children.entries()]
    .map(([name, child]) => ({ name, count: child.totalCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}


/* =================================================================
   DATA PROCESSING

   ECOSYSTEM COUPLING: OPTIONS_DATA is generated by generate-options-data.py
   from the nixosOptionsDoc JSON output. Each option has:
     - type: string (Nix type expression, e.g. "list of string")
     - description: string (HTML, pre-rendered by nixos-render-docs)
     - default/example: primitive | { _type, text } | null
     - declarations: [{ name, url }]
   Descriptions are HTML because nixos-render-docs handles DocBook/CommonMark
   conversion at build time — this avoids shipping a markdown parser at runtime.
   ================================================================= */

function init() {
  state.options = Object.entries(OPTIONS_DATA)
    .map(([name, opt]) => {
      const type = opt.type || 'unknown';
      const nameEsc = esc(name);
      const typeFull = typeLabel(type);
      const badge = typeLabel(type, TYPE_BADGE_MAX_CHARS);
      return {
        name,
        type,
        description: opt.description || '',
        defaultVal: formatValue(opt.default),
        exampleVal: formatValue(opt.example),
        declarations: opt.declarations || [],
        nameLower: name.toLowerCase(),
        leafLower: leafOf(name).toLowerCase(),
        descLower: (stripTags(opt.description || '') + ' ' + (opt.type || '')).toLowerCase(),
        // Pre-computed rendering values (invariant per option)
        nameEsc,
        typeClass: getTypeClass(type),
        typeBadge: esc(badge),
        typeFull,
        typeTruncated: badge.includes('\u2026'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  optionTree = buildTree(state.options);

  render();
  setupEvents();
  handleHash();
  trackHeaderScroll();
}


/* =================================================================
   STATE & RENDER
   ================================================================= */

function setState(patch) {
  Object.assign(state, patch);
  if (dropdown.open) closeDropdown();
  render();
}

function render() {
  const { results, terms, groupPrefixes } = filterAndSort(state.options, state.query, state.path);
  renderBreadcrumb(state.path, results.length, state.options.length);
  renderOptionList(results, terms, state.path, groupPrefixes);
  updateHeaderHeight();
  window.scrollTo(0, 0);
}


/* =================================================================
   FILTERING & SORTING
   ================================================================= */

function filterAndSort(options, query, path) {
  const fullQuery = query.toLowerCase().trim();
  const terms = fullQuery.split(/\s+/).filter(Boolean);
  const pathPrefix = path.length ? path.join('.') + '.' : '';

  let results;
  if (!terms.length && !pathPrefix) {
    results = [...options];
  } else {
    results = [];
    const scores = terms.length ? new Map() : null;
    for (const opt of options) {
      if (pathPrefix && !opt.name.startsWith(pathPrefix)) continue;
      if (terms.length) {
        const score = scoreOption(opt, terms, fullQuery);
        if (score < 0) continue;
        scores.set(opt, score);
        results.push(opt);
      } else {
        results.push(opt);
      }
    }
    if (terms.length) {
      results.sort((a, b) => scores.get(b) - scores.get(a) || a.name.localeCompare(b.name));
    }
  }
  // Build set of first-segments that have children — options whose name matches
  // a group prefix are "hybrid" (both a direct value and a parent) and should
  // sort with the groups rather than the leaves.
  const groupPrefixes = new Set();
  for (const opt of results) {
    const rest = opt.name.substring(pathPrefix.length);
    const { segment, length } = firstAttrSegment(rest);
    if (length < rest.length) groupPrefixes.add(segment);
  }

  if (!terms.length) {
    results.sort((a, b) => {
      const restA = a.name.substring(pathPrefix.length);
      const restB = b.name.substring(pathPrefix.length);
      const leafA = firstAttrSegment(restA).length >= restA.length && !groupPrefixes.has(restA);
      const leafB = firstAttrSegment(restB).length >= restB.length && !groupPrefixes.has(restB);
      if (leafA !== leafB) return leafA ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  return { results, terms, groupPrefixes };
}


/* =================================================================
   RENDERING
   ================================================================= */

function renderBreadcrumb(path, resultCount, totalCount) {
  const breadcrumbEl = document.getElementById('breadcrumb');
  const countEl = document.getElementById('breadcrumb-count');

  const currentNode = getNodeAtPath(path);
  const hasChildren = currentNode && currentNode.children.size > 0;

  let html = '';

  // Clear button (shown when navigated into a path)
  if (path.length > 0) {
    html += `<button class="crumb-clear" aria-label="Clear path"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg></button>`;
  }

  // Path segments — each separator+crumb pair is wrapped so they never
  // break across lines when the breadcrumb bar wraps.
  for (let i = 0; i < path.length; i++) {
    const isCurrent = i === path.length - 1;
    const sep = i > 0 ? `<span class="crumb-sep" aria-hidden="true">.</span>` : '';
    // Merged parameterized segments (e.g. "agents.<name>") get split visually
    // with inner separators, but wrapped in a single button so they highlight as one unit.
    const parts = splitAttrPath(path[i]);
    const inner = parts.map(p => `<span class="crumb-part">${esc(p)}</span>`).join('<span class="crumb-sep" aria-hidden="true">.</span>');
    const crumb = `<button class="crumb${isCurrent ? ' crumb-current' : ''}" data-depth="${i}">${inner}</button>`;
    html += sep ? `<span class="crumb-pair">${sep}${crumb}</span>` : crumb;
  }

  // Trailing drill affordance (shown when current node has sub-groups)
  if (hasChildren) {
    const sep = path.length > 0 ? `<span class="crumb-sep" aria-hidden="true">.</span>` : '';
    const drill = `<button class="crumb-drill" data-depth="${path.length}" aria-label="Show sub-groups">...</button>`;
    html += sep ? `<span class="crumb-pair">${sep}${drill}</span>` : drill;
  }

  breadcrumbEl.innerHTML = html;

  // Option count
  if (resultCount !== totalCount) {
    countEl.textContent = `${resultCount.toLocaleString()} of ${totalCount.toLocaleString()} options`;
  } else {
    countEl.textContent = `${totalCount.toLocaleString()} options`;
  }
}

function renderOptionHtml(opt, terms, pathPrefix, bandClass) {
  const displayName = pathPrefix && opt.name.startsWith(pathPrefix)
    ? opt.name.substring(pathPrefix.length)
    : opt.name;
  const { prefix, leaf, splitIndex } = splitDisplay(displayName);

  const nameHtml = terms.length
    ? highlightName(displayName, splitIndex, terms)
    : `<span class="opt-prefix">${esc(prefix).replace(/\./g, '<wbr>.')}</span><span class="opt-leaf">${esc(leaf).replace(/\./g, '<wbr>.')}</span>`;

  return `<div class="option${bandClass}" id="opt--${opt.nameEsc}" data-name="${opt.nameEsc}" role="listitem">
      <div class="option-header" role="button" tabindex="0" aria-expanded="false" data-name="${opt.nameEsc}">
        <span class="expand-indicator"><span class="expand-arrow"></span></span>
        <span class="option-name">${nameHtml}<button class="copy-btn" data-copy="${opt.nameEsc}" title="Copy option name"><svg class="icon-default" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg><svg class="icon-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button><button class="link-btn" data-link="${opt.nameEsc}" title="Copy link to option"><svg class="icon-default" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg><svg class="icon-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button></span>
        <span class="type-badge ${opt.typeClass}"${opt.typeTruncated ? ` title="${esc(opt.typeFull)}"` : ''}>${opt.typeBadge}</span>
      </div>
      <div class="option-details">
        <div class="option-details-inner">
          ${opt.description ? `<div class="detail-section"><div class="detail-value">${opt.description}</div></div>` : ''}
          <div class="detail-section">
            <div class="detail-label">Type</div>
            <div class="detail-value detail-type-full">${esc(opt.type)}</div>
          </div>
          ${opt.defaultVal !== null ? `<div class="detail-section"><div class="detail-label">Default</div><pre class="detail-code">${esc(opt.defaultVal)}</pre></div>` : ''}
          ${opt.exampleVal !== null ? `<div class="detail-section"><div class="detail-label">Example</div><pre class="detail-code">${esc(opt.exampleVal)}</pre></div>` : ''}
          ${opt.declarations.length ? `<div class="detail-section"><div class="detail-label">Declared in</div><ul class="decl-list">${opt.declarations.map(d =>
            `<li><a class="decl-link" href="${esc(d.url || '#')}" target="_blank" rel="noopener">${esc(d.name)}</a></li>`
          ).join('')}</ul></div>` : ''}
        </div>
      </div>
    </div>`;
}

function buildBatchHtml(start, count) {
  const q = renderQueue;
  const end = Math.min(start + count, q.results.length);
  let html = '';
  for (let i = start; i < end; i++) {
    const opt = q.results[i];
    const rest = q.pathPrefix ? opt.name.substring(q.pathPrefix.length) : opt.name;
    const { segment, length } = firstAttrSegment(rest);
    const bandKey = (length < rest.length || (q.groupPrefixes && q.groupPrefixes.has(segment))) ? segment : '';
    if (bandKey !== q.bandKey) {
      q.bandParity = !q.bandParity;
      q.bandKey = bandKey;
    }
    html += renderOptionHtml(opt, q.terms, q.pathPrefix, q.bandParity ? ' band-odd' : '');
  }
  q.rendered = end;
  return html;
}

function renderMoreIfNeeded() {
  const q = renderQueue;
  if (q.rendered >= q.results.length) return;

  // Check if user has scrolled near the bottom
  const scrollBottom = window.scrollY + window.innerHeight;
  const docHeight = document.documentElement.scrollHeight;
  if (scrollBottom < docHeight - 500) return;

  const listEl = document.getElementById('options-list');
  const html = buildBatchHtml(q.rendered, RENDER_BATCH);
  listEl.insertAdjacentHTML('beforeend', html);
}

function renderOptionList(results, terms, path, groupPrefixes) {
  state.expanded = null;

  const listEl = document.getElementById('options-list');
  const noEl = document.getElementById('no-results');

  if (results.length === 0) {
    listEl.innerHTML = '';
    listEl.style.display = 'none';
    noEl.classList.remove('hidden');
    renderQueue.results = [];
    renderQueue.rendered = 0;
    return;
  }

  noEl.classList.add('hidden');
  listEl.style.display = '';

  const pathPrefix = path.length ? path.join('.') + '.' : '';

  // Reset render queue for incremental loading
  renderQueue.results = results;
  renderQueue.terms = terms;
  renderQueue.pathPrefix = pathPrefix;
  renderQueue.groupPrefixes = groupPrefixes;
  renderQueue.rendered = 0;
  renderQueue.bandKey = '';
  renderQueue.bandParity = false;

  // Render first batch
  listEl.innerHTML = buildBatchHtml(0, RENDER_BATCH);
}


/* =================================================================
   BREADCRUMB DROPDOWN
   ================================================================= */

function openDropdown(depth, anchorEl) {
  // Compute items based on depth
  let items;
  let activeName = null;

  if (depth < state.path.length) {
    // Siblings dropdown (clicking the current/last crumb)
    items = getChildrenAtPath(state.path.slice(0, depth));
    activeName = state.path[depth];
  } else {
    // Children dropdown (clicking drill or "All" at root)
    items = getChildrenAtPath(state.path);
    activeName = null;
  }

  if (items.length === 0) return;

  // Capture position before hiding elements
  dropdown.anchorRect = anchorEl.getBoundingClientRect();

  // Hide breadcrumb elements that the dropdown replaces
  const breadcrumbEl = document.getElementById('breadcrumb');
  dropdown.hiddenEls = [];
  if (depth >= state.path.length) {
    // Drill case: hide just the drill button
    anchorEl.style.visibility = 'hidden';
    dropdown.hiddenEls.push(anchorEl);
  } else {
    // Siblings case: hide crumb and everything after it
    // Use visibility:hidden (not display:none) to preserve layout and prevent shifts
    const children = [...breadcrumbEl.children];
    // anchorEl may be inside a .crumb-pair wrapper — find the direct child that contains it
    const anchorChild = anchorEl.parentElement === breadcrumbEl ? anchorEl : anchorEl.closest('.crumb-pair');
    const startIdx = children.indexOf(anchorChild);
    for (let i = startIdx; i < children.length; i++) {
      children[i].style.visibility = 'hidden';
      dropdown.hiddenEls.push(children[i]);
    }
  }

  dropdown.open = true;
  dropdown.depth = depth;
  dropdown.items = items;
  dropdown.filtered = items;
  dropdown.filterText = '';
  dropdown.highlighted = activeName ? Math.max(0, items.findIndex(i => i.name === activeName)) : -1;
  dropdown.anchorEl = anchorEl;

  const ddEl = document.getElementById('crumb-dropdown');
  const ddFilterEl = document.getElementById('crumb-dropdown-filter');

  // Pre-fill for siblings case (current segment name, selected)
  if (activeName) {
    ddFilterEl.value = activeName;
  } else {
    ddFilterEl.value = '';
  }
  ddFilterEl.classList.remove('hidden');

  ddEl.classList.remove('hidden');
  positionDropdown();
  renderDropdownItems();

  requestAnimationFrame(() => {
    ddFilterEl.focus();
    if (activeName) ddFilterEl.select();
  });
}

function closeDropdown() {
  dropdown.open = false;
  document.getElementById('crumb-dropdown').classList.add('hidden');
  document.getElementById('crumb-dropdown-filter').classList.add('hidden');

  // Restore hidden breadcrumb elements
  for (const el of dropdown.hiddenEls) {
    el.style.visibility = '';
  }
  dropdown.hiddenEls = [];
}

function positionDropdown() {
  const ddEl = document.getElementById('crumb-dropdown');
  const rect = dropdown.anchorRect;

  // Align filter text baseline with breadcrumb text baseline
  // Crumb padding-top (3px) vs dropdown border (1px) + filter padding (8px) = 6px offset
  // Biased 2px lower for better visual alignment
  ddEl.style.top = (rect.top - 4) + 'px';
  ddEl.style.left = rect.left + 'px';

  // Ensure dropdown doesn't overflow the right edge of the viewport
  requestAnimationFrame(() => {
    const ddRect = ddEl.getBoundingClientRect();
    if (ddRect.right > window.innerWidth - 8) {
      ddEl.style.left = Math.max(8, window.innerWidth - ddRect.width - 8) + 'px';
    }
  });
}

function renderDropdownItems() {
  const listEl = document.getElementById('crumb-dropdown-list');
  const activeName = dropdown.depth < state.path.length ? state.path[dropdown.depth] : null;

  let html = '';
  for (let i = 0; i < dropdown.filtered.length; i++) {
    const item = dropdown.filtered[i];
    const isActive = item.name === activeName;
    const isHighlighted = i === dropdown.highlighted;
    let cls = 'crumb-dropdown-item';
    if (isActive) cls += ' active';
    if (isHighlighted) cls += ' highlighted';
    html += `<button class="${cls}" role="option" ${isActive ? 'aria-selected="true" ' : ''}data-name="${esc(item.name)}">${esc(item.name)}<span class="crumb-dropdown-count">${item.count}</span></button>`;
  }
  listEl.innerHTML = html;

  // Scroll highlighted item into view
  if (dropdown.highlighted >= 0) {
    const highlightedEl = listEl.children[dropdown.highlighted];
    if (highlightedEl) highlightedEl.scrollIntoView({ block: 'nearest' });
  }
}

function selectDropdownItem(name) {
  const depth = dropdown.depth;
  const newPath = state.path.slice(0, depth).concat(name);

  closeDropdown();
  setState({ path: newPath });

  // Auto-cascade: if new node has children, open the next dropdown
  const node = getNodeAtPath(newPath);
  if (node && node.children.size > 0) {
    requestAnimationFrame(() => {
      const drillEl = document.querySelector('.crumb-drill');
      if (drillEl) {
        openDropdown(newPath.length, drillEl);
      }
    });
  }
}


/* =================================================================
   EXPAND / COLLAPSE
   ================================================================= */

function toggleOption(name, animate = true) {
  const el = document.getElementById('opt--' + name);
  if (!el) return;

  if (el.classList.contains('expanded')) {
    collapseOption(el, animate);
  } else {
    if (state.expanded && state.expanded !== name) {
      const prev = document.getElementById('opt--' + state.expanded);
      if (prev) collapseOption(prev, animate);
    }
    expandOption(el, name, animate);
  }
}

function expandOption(el, name, animate = true) {
  const details = el.querySelector('.option-details');
  const header = el.querySelector('.option-header');

  el.classList.add('expanded');
  header.setAttribute('aria-expanded', 'true');
  state.expanded = name;

  if (animate) {
    // CSS defaults to max-height: 0; measure full content height then animate
    const h = details.scrollHeight;
    details.style.maxHeight = '0px';
    details.style.opacity = '0';
    requestAnimationFrame(() => {
      details.style.maxHeight = h + 'px';
      details.style.opacity = '1';
    });
    // After expand animation completes, ensure card is in view
    const onExpand = (e) => {
      if (e.propertyName !== 'max-height') return;
      details.removeEventListener('transitionend', onExpand);
      scrollIntoViewPadded(el);
    };
    details.addEventListener('transitionend', onExpand);
  } else {
    // Instant — suppress transitions, snap to final state
    el.style.transition = 'none';
    details.style.transition = 'none';
    details.style.maxHeight = details.scrollHeight + 'px';
    details.style.opacity = '1';
    el.offsetHeight; // force layout commit
    el.style.transition = '';
    details.style.transition = '';
  }

  // Skip hash update for instant transitions — history.replaceState is
  // rate-limited (~100/10s) and rapid arrow keys would hit the cap,
  // throwing a SecurityError that breaks the expand/collapse flow.
  if (animate) history.replaceState(null, '', '#' + name);
}

function collapseOption(el, animate = true) {
  const details = el.querySelector('.option-details');
  const header = el.querySelector('.option-header');

  if (animate) {
    details.style.maxHeight = details.scrollHeight + 'px';
    requestAnimationFrame(() => {
      details.style.maxHeight = '0px';
      details.style.opacity = '0';
    });

    // Wait for the longest transition (max-height) before cleanup
    const onEnd = (e) => {
      if (e.propertyName !== 'max-height') return;
      el.classList.remove('expanded');
      header.setAttribute('aria-expanded', 'false');
      details.removeEventListener('transitionend', onEnd);
    };
    details.addEventListener('transitionend', onEnd);
  } else {
    // Instant — suppress transitions, snap to collapsed state
    el.style.transition = 'none';
    details.style.transition = 'none';
    el.classList.remove('expanded');
    header.setAttribute('aria-expanded', 'false');
    details.style.maxHeight = '';
    details.style.opacity = '';
    el.offsetHeight; // force layout commit
    el.style.transition = '';
    details.style.transition = '';
  }

  if (state.expanded === el.dataset.name) {
    state.expanded = null;
    // Skip hash clear for instant transitions (see expandOption comment)
    if (animate) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }
}


/** Scroll an element into the visible viewport (below the sticky header),
 *  with padding. Shows as much as possible while prioritizing the top. */
function scrollIntoViewPadded(el) {
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const pad = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--space-2'));
  const viewTop = document.getElementById('header').offsetHeight + pad;
  const viewBottom = window.innerHeight - pad;

  // Fully visible — nothing to do
  if (rect.top >= viewTop && rect.bottom <= viewBottom) return;

  if (rect.height > viewBottom - viewTop) {
    // Element taller than viewport — pin top just below sticky header
    window.scrollBy(0, rect.top - viewTop);
  } else if (rect.bottom > viewBottom) {
    // Bottom off-screen — scroll down, but keep top visible
    const needed = rect.bottom - viewBottom;
    const available = rect.top - viewTop;
    window.scrollBy(0, Math.min(needed, available));
  } else {
    // Top above sticky header — scroll up
    window.scrollBy(0, rect.top - viewTop);
  }
}


/* =================================================================
   EVENTS
   ================================================================= */

function handleDropdownFilterInput(e) {
  dropdown.filterText = e.target.value.toLowerCase();
  dropdown.filtered = dropdown.items.filter(item =>
    item.name.toLowerCase().includes(dropdown.filterText)
  );
  // Prefer prefix match for highlight
  const prefixIdx = dropdown.filterText
    ? dropdown.filtered.findIndex(item => item.name.toLowerCase().startsWith(dropdown.filterText))
    : -1;
  dropdown.highlighted = prefixIdx >= 0 ? prefixIdx : 0;
  renderDropdownItems();
  positionDropdown();
}

function handleDropdownFilterKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (dropdown.highlighted < 0) {
      dropdown.highlighted = 0;
    } else {
      dropdown.highlighted = Math.min(dropdown.highlighted + 1, dropdown.filtered.length - 1);
    }
    renderDropdownItems();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (dropdown.highlighted < 0) {
      dropdown.highlighted = dropdown.filtered.length - 1;
    } else {
      dropdown.highlighted = Math.max(dropdown.highlighted - 1, 0);
    }
    renderDropdownItems();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (dropdown.filtered.length > 0 && dropdown.highlighted >= 0) {
      selectDropdownItem(dropdown.filtered[dropdown.highlighted].name);
    }
  } else if (e.key === 'Backspace' && e.target.value === '') {
    e.preventDefault();
    const depth = dropdown.depth;
    closeDropdown();

    if (depth >= state.path.length) {
      // Drill case: switch to siblings at last segment (no path change)
      if (state.path.length > 0) {
        requestAnimationFrame(() => {
          const lastCrumb = document.querySelector('.crumb-current');
          if (lastCrumb) openDropdown(state.path.length - 1, lastCrumb);
        });
      }
    } else {
      // Siblings case: pop last segment, open siblings at new last
      const newPath = state.path.slice(0, -1);
      setState({ path: newPath });
      if (newPath.length > 0) {
        requestAnimationFrame(() => {
          const lastCrumb = document.querySelector('.crumb-current');
          if (lastCrumb) openDropdown(newPath.length - 1, lastCrumb);
        });
      }
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeDropdown();
  }
}

function setupEvents() {
  const search = document.getElementById('search');
  const breadcrumbEl = document.getElementById('breadcrumb');
  const ddListEl = document.getElementById('crumb-dropdown-list');
  const ddFilterEl = document.getElementById('crumb-dropdown-filter');

  // Search input (debounced)
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setState({ query: search.value }), 80);
  });

  // Arrow down from search enters the option list
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      const first = document.querySelector('.option-header');
      if (first) { e.preventDefault(); first.focus({ focusVisible: true }); }
    }
  });

  // Incremental rendering on scroll
  window.addEventListener('scroll', renderMoreIfNeeded, { passive: true });

  // Search clear button
  document.getElementById('search-clear').addEventListener('click', () => {
    search.value = '';
    setState({ query: '' });
    search.focus();
  });

  // Breadcrumb clicks
  breadcrumbEl.addEventListener('click', e => {
    const clear = e.target.closest('.crumb-clear');
    if (clear) {
      e.stopPropagation();
      closeDropdown();
      setState({ path: [] });
      return;
    }

    const drill = e.target.closest('.crumb-drill');
    if (drill) {
      e.stopPropagation();
      openDropdown(state.path.length, drill);
      return;
    }

    const crumb = e.target.closest('.crumb');
    if (!crumb) return;

    const depth = parseInt(crumb.dataset.depth, 10);

    if (depth === state.path.length - 1) {
      // Current (last) crumb -- open siblings dropdown
      openDropdown(depth, crumb);
    } else {
      // Non-current crumb -- navigate to that depth
      closeDropdown();
      setState({ path: state.path.slice(0, depth + 1) });
    }
  });

  // Dropdown filter events
  ddFilterEl.addEventListener('input', handleDropdownFilterInput);
  ddFilterEl.addEventListener('keydown', handleDropdownFilterKeydown);

  // Dropdown item click
  ddListEl.addEventListener('click', e => {
    const item = e.target.closest('.crumb-dropdown-item');
    if (item) selectDropdownItem(item.dataset.name);
  });

  // Click outside dropdown to close
  document.addEventListener('mousedown', e => {
    if (dropdown.open &&
        !e.target.closest('#crumb-dropdown') &&
        !e.target.closest('.crumb') &&
        !e.target.closest('.crumb-drill') &&
        !e.target.closest('.crumb-clear')) {
      closeDropdown();
    }
  });

  // Options list
  document.getElementById('options-list').addEventListener('click', e => {
    const xref = e.target.closest('a.xref');
    if (xref) {
      e.preventDefault();
      e.stopPropagation();
      navigateToOption(xref.dataset.option);
      return;
    }
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      navigator.clipboard.writeText(copyBtn.dataset.copy).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1200);
      });
      return;
    }
    const linkBtn = e.target.closest('.link-btn');
    if (linkBtn) {
      e.stopPropagation();
      const url = window.location.origin + window.location.pathname + '#' + linkBtn.dataset.link;
      navigator.clipboard.writeText(url).then(() => {
        linkBtn.classList.add('copied');
        setTimeout(() => linkBtn.classList.remove('copied'), 1200);
      });
      return;
    }
    if (e.target.closest('.decl-link')) return;
    if (e.target.closest('a.link')) return;
    const header = e.target.closest('.option-header');
    if (header) toggleOption(header.dataset.name);
  });

  document.getElementById('options-list').addEventListener('keydown', e => {
    const header = e.target.closest('.option-header');
    if (!header) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleOption(header.dataset.name);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const headers = [...document.querySelectorAll('.option-header')];
      const idx = headers.indexOf(header);
      const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      if (next >= 0 && next < headers.length) {
        headers[next].focus({ preventScroll: true, focusVisible: true });
        renderMoreIfNeeded();
        // Expansion follows focus: if something is expanded, carry it along (instant)
        if (state.expanded) toggleOption(headers[next].dataset.name, false);
        // Single scroll source — handles both browse rows and expanded cards
        scrollIntoViewPadded(headers[next].closest('.option'));
      } else if (next < 0) {
        document.getElementById('search').focus({ focusVisible: true });
        // Leaving the list collapses any expanded option (instant)
        if (state.expanded) {
          const el = document.getElementById('opt--' + state.expanded);
          if (el) collapseOption(el, false);
        }
      }
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== search &&
        document.activeElement !== ddFilterEl &&
        !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (e.key === 'ArrowDown' && !e.target.closest('.option-header') &&
        e.target !== search && e.target !== ddFilterEl) {
      const first = document.querySelector('.option-header');
      if (first) { e.preventDefault(); first.focus({ focusVisible: true }); }
      return;
    }
    if (e.key === 'Escape') {
      if (dropdown.open) {
        closeDropdown();
        return;
      }
      if (search.value) {
        search.value = '';
        setState({ query: '' });
      } else {
        search.blur();
      }
    }
  });

  window.addEventListener('hashchange', handleHash);
}

function navigateToOption(name) {
  const opt = state.options.find(o => o.name === name);
  if (!opt) return;

  // Compute parent path from option name, merging parameterized segments
  // to match the tree structure (e.g. ['launchd', 'daemons.<name>'] not
  // ['launchd', 'daemons', '<name>'])
  const segments = mergeParamSegments(splitAttrPath(name));
  const parentPath = segments.slice(0, -1);

  document.getElementById('search').value = '';
  closeDropdown();
  setState({ query: '', path: parentPath });

  // Ensure target is rendered (may be beyond initial batch)
  let el = document.getElementById('opt--' + name);
  if (!el && renderQueue.rendered < renderQueue.results.length) {
    const listEl = document.getElementById('options-list');
    listEl.insertAdjacentHTML('beforeend', buildBatchHtml(renderQueue.rendered, renderQueue.results.length - renderQueue.rendered));
    el = document.getElementById('opt--' + name);
  }
  if (el) {
    if (!el.classList.contains('expanded')) toggleOption(name);
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

function handleHash() {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (!hash) return;
  navigateToOption(hash);
}

function updateHeaderHeight() {
  const header = document.getElementById('header');
  document.documentElement.style.setProperty('--header-height', header.offsetHeight + 'px');
}

function trackHeaderScroll() {
  let wasScrolled = false;
  window.addEventListener('scroll', () => {
    const isScrolled = window.scrollY > 10;
    if (isScrolled !== wasScrolled) {
      document.getElementById('header').classList.toggle('scrolled', isScrolled);
      wasScrolled = isScrolled;
    }
  }, { passive: true });

  updateHeaderHeight();
  window.addEventListener('resize', updateHeaderHeight);
}


/* =================================================================
   THEME
   ================================================================= */

function getPreferredTheme() {
  const stored = localStorage.getItem('nix-darwin-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

// Apply immediately to avoid flash
applyTheme(getPreferredTheme());

function setupThemeToggle() {
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.add('theme-transitioning');
    applyTheme(next);
    localStorage.setItem('nix-darwin-theme', next);
    // Re-enable transitions after the browser paints with new theme
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.documentElement.classList.remove('theme-transitioning');
      });
    });
  });

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
    if (!localStorage.getItem('nix-darwin-theme')) {
      applyTheme(e.matches ? 'light' : 'dark');
    }
  });
}


/* =================================================================
   INIT
   ================================================================= */

document.addEventListener('DOMContentLoaded', () => { init(); setupThemeToggle(); });
