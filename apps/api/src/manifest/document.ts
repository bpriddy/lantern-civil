import { isMap, isScalar, isSeq, parseDocument, type Document, type Pair, type YAMLMap } from 'yaml';

/**
 * Reading and editing manifests without rewriting them.
 *
 * PRD 6.5: "A no-op round-trip must be byte-identical." The obvious implementation —
 * parse, mutate the tree, serialise — cannot satisfy that. A serialiser makes global
 * choices about quoting, padding, and indentation, and the example manifests already
 * mix styles that no single set of options reproduces: `{ id: c1, ... }` is padded
 * while `["src/**\/*.py"]` is not. Re-serialising rewrites both to match each other.
 *
 * So untouched text is never regenerated. Edits are computed as splices into the
 * original source using the ranges the parser records, which makes a no-op round-trip
 * byte-identical by construction rather than by luck, and makes PRD 14 M3's "the YAML
 * looks hand-written" true for every line an edit did not touch.
 */

export interface ManifestDocument {
  /** Exactly the bytes that were read. */
  readonly source: string;
  /** The parsed tree, for locating things and for reading values. */
  readonly doc: Document.Parsed;
}

export function readManifest(source: string): ManifestDocument {
  return { source, doc: parseDocument(source, { keepSourceTokens: true }) };
}

/** A replacement of one span of the source. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies splices to the source. Applied back to front so earlier offsets stay valid.
 */
export function applySplices(source: string, splices: readonly Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start);
  let out = source;
  for (const splice of ordered) {
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  }
  return out;
}

/** The offset of the last non-whitespace character at or before `end`. */
export function trimEnd(source: string, end: number): number {
  let at = Math.min(end, source.length);
  while (at > 0 && /\s/.test(source[at - 1]!)) at -= 1;
  return at;
}

export class ManifestEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestEditError';
  }
}

/** The sequence at `path`, with the source detail needed to append to it in style. */
export interface SequenceTarget {
  /** Start of the span a new item replaces or follows. */
  insertAt: number;
  /**
   * End of that span. Equal to insertAt when appending after existing items; for an
   * empty `[]` it covers the brackets, which the first item replaces entirely.
   */
  replaceTo: number;
  /** The exact leading text of an item, e.g. "\n    - " — or ", " inside inline flow. */
  itemPrefix: string;
  /** Whether existing items are single-line flow maps, which a new one should match. */
  flow: boolean;
  count: number;
}

/**
 * How far this file indents a nested block, so a first item lands where the file's
 * own convention says it should rather than where a default says.
 */
function detectIndentStep(source: string): number {
  const lines = source.split('\n');
  let previous = 0;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const width = line.length - line.trimStart().length;
    if (width > previous && !line.trimStart().startsWith('- ')) return width - previous;
    previous = width;
  }
  return 2;
}

export function findSequence(manifest: ManifestDocument, path: readonly string[]): SequenceTarget {
  const node = manifest.doc.getIn(path, true);
  if (!isSeq(node)) {
    throw new ManifestEditError(`${path.join('.')} is not a sequence in this manifest`);
  }

  const items = node.items.filter((item): item is { range: [number, number, number] } =>
    Boolean(item && typeof item === 'object' && 'range' in item && item.range),
  );

  if (items.length === 0) {
    // An empty sequence has no item to copy a style from — but the file still states
    // its own indentation, and the key it hangs from states its column. A scaffolded
    // project starts with `nodes: []`, so this is the first thing every new project
    // does rather than an edge case.
    const range = node.range;
    if (!range) throw new ManifestEditError(`${path.join('.')} has no position in the source`);

    const lineStart = manifest.source.lastIndexOf('\n', range[0] - 1) + 1;
    const keyIndent = /^\s*/.exec(manifest.source.slice(lineStart, range[0]))?.[0] ?? '';
    const step = ' '.repeat(detectIndentStep(manifest.source));

    // Swallow the space after the colon along with the brackets, so the result is
    // `nodes:` rather than `nodes: ` with a stray trailing space.
    let start = range[0];
    while (start > lineStart && manifest.source[start - 1] === ' ') start -= 1;

    return {
      insertAt: start,
      // The `[]` is replaced, not appended to: a block item cannot live inside it.
      replaceTo: range[1],
      itemPrefix: `\n${keyIndent}${step}- `,
      // Block style by default. Flow is a choice an author makes for terse items, and
      // there is nothing here to suggest they made it.
      flow: false,
      count: 0,
    };
  }

  const last = items[items.length - 1]!;
  const first = items[0]!;

  // A sequence written inline — `edges: [{...}, {...}]` — has no dash to copy; new
  // items join the punctuation already there. Manifests Civil scaffolds never use
  // this form, but an agent may hand one over, and appending a block item into flow
  // brackets corrupts the file.
  if ((node as { flow?: boolean }).flow) {
    const insertAt = trimEnd(manifest.source, last.range[1]);
    return { insertAt, replaceTo: insertAt, itemPrefix: ', ', flow: true, count: items.length };
  }

  // The prefix is read from the source rather than assumed, so a file indented with
  // four spaces, or with its dashes in an unusual place, keeps its own shape.
  const beforeFirst = manifest.source.lastIndexOf('\n', first.range[0] - 1);
  const itemPrefix = manifest.source.slice(beforeFirst, first.range[0]);

  const firstText = manifest.source.slice(first.range[0], first.range[1]).trim();

  // For a flow item range[1] is its closing brace, but for a block item it runs on
  // into the whitespace that follows — so inserting there swallows the newline before
  // the next key, and `edges: []` ends up appended to the previous node. Backing up
  // over trailing whitespace finds where the item's own text actually stops.
  const insertAt = trimEnd(manifest.source, last.range[1]);

  return {
    insertAt,
    replaceTo: insertAt,
    itemPrefix,
    flow: firstText.startsWith('{'),
    count: items.length,
  };
}


/** An item in a sequence, and the span that removing it should take with it. */
export interface SequenceItem {
  /** Start of the removable span, including the leading newline and dash. */
  start: number;
  end: number;
}

/**
 * Where a mapping key's value begins — just after the colon and its space. Used when
 * an emptied collection is written back as `[]` or `{}`: the splice runs from here so
 * the key itself survives.
 */
export function valueStartOfKey(
  manifest: ManifestDocument,
  path: readonly string[],
): number {
  const parent = manifest.doc.getIn(path.slice(0, -1), true);
  const key = path[path.length - 1]!;
  if (!isMap(parent)) throw new ManifestEditError(`${path.slice(0, -1).join('.')} is not a mapping`);
  const pair = (parent as YAMLMap).items.find(
    (p) => isScalar(p.key) && p.key.value === key,
  ) as Pair | undefined;
  const keyNode = pair?.key as { range?: [number, number, number] } | undefined;
  if (!keyNode?.range) throw new ManifestEditError(`${path.join('.')} has no key in the source`);
  const colon = manifest.source.indexOf(':', keyNode.range[1]);
  if (colon === -1) throw new ManifestEditError(`${path.join('.')} has no value position`);
  return colon + 1;
}

/**
 * Finds a sequence item by its `id`, for removal.
 *
 * The span starts at the newline before the item rather than at the item itself, so
 * removing it does not leave the blank line and dash it used to sit on. PRD 14 M3's
 * "the YAML looks hand-written" applies to deletions too: a file with a stray `-` in
 * it is not something a person would have written.
 */
export function findSequenceItemById(
  manifest: ManifestDocument,
  path: readonly string[],
  id: string,
): SequenceItem {
  const node = manifest.doc.getIn(path, true);
  if (!isSeq(node)) {
    throw new ManifestEditError(`${path.join('.')} is not a sequence in this manifest`);
  }

  const index = node.items.findIndex((item) => {
    const value = item && typeof item === 'object' && 'get' in item
      ? (item as { get(key: string): unknown }).get('id')
      : undefined;
    return value === id;
  });

  if (index === -1) throw new ManifestEditError(`no item with id "${id}" in ${path.join('.')}`);

  const item = node.items[index] as { range?: [number, number, number] };
  if (!item.range) throw new ManifestEditError(`item "${id}" has no position in the source`);

  // Inside inline flow — `[a, b]` — an item's span must take one comma with it, or
  // removal leaves `[, b]` behind. The following comma when there is a next item, the
  // preceding one when this is the last.
  if ((node as { flow?: boolean }).flow) {
    const next = node.items[index + 1] as { range?: [number, number, number] } | undefined;
    const previous = node.items[index - 1] as { range?: [number, number, number] } | undefined;
    if (next?.range) return { start: item.range[0], end: next.range[0] };
    if (previous?.range) return { start: previous.range[1], end: item.range[1] };
    return { start: item.range[0], end: item.range[1] };
  }

  // Back up over the dash and the whitespace before it, to the end of the previous
  // line — that whole span belongs to this item.
  let start = item.range[0];
  const lineStart = manifest.source.lastIndexOf('\n', start - 1);
  if (lineStart !== -1 && manifest.source.slice(lineStart + 1, start).trim() === '-') {
    start = lineStart;
  }

  return { start, end: trimEnd(manifest.source, item.range[1]) };
}

/**
 * The splices that remove a set of items in one application — and, when they are all
 * of them, the single splice that writes the sequence back as `[]` instead.
 *
 * Without the restore, removing the only edge leaves `edges:` with nothing under it,
 * which parses as null: the schema rejects it, and the next addEdge is refused with
 * "not a sequence". Add an edge, remove it, add another — every project would hit
 * that within its first minutes.
 *
 * Removal is plural for a reason found the hard way: inside inline flow brackets,
 * one item's removal span reaches to its neighbour — the comma has to go with it —
 * so two spans computed independently for ADJACENT items overlap, and overlapping
 * splices shred the text between them. Runs of adjacent removals are therefore
 * merged into one span here, where the whole set is visible.
 */
export function removeSequenceItems(
  manifest: ManifestDocument,
  path: readonly string[],
  ids: readonly string[],
): Splice[] {
  const node = manifest.doc.getIn(path, true);
  if (!isSeq(node)) {
    throw new ManifestEditError(`${path.join('.')} is not a sequence in this manifest`);
  }

  const wanted = new Set(ids);
  const indices: number[] = [];
  node.items.forEach((item, index) => {
    const value = item && typeof item === 'object' && 'get' in item
      ? (item as { get(key: string): unknown }).get('id')
      : undefined;
    if (typeof value === 'string' && wanted.has(value)) {
      indices.push(index);
      wanted.delete(value);
    }
  });
  if (wanted.size > 0) {
    throw new ManifestEditError(
      `no item with id "${[...wanted][0]}" in ${path.join('.')}`,
    );
  }

  const isFlow = (node as { flow?: boolean }).flow ?? false;
  const ranges = node.items.map((item) => (item as { range?: [number, number, number] }).range);
  const range = (i: number): [number, number, number] => {
    const r = ranges[i];
    if (!r) throw new ManifestEditError(`an item in ${path.join('.')} has no position in the source`);
    return r;
  };

  // Everything goes: one restore splice, because item spans computed against the
  // same parse would each also try to own the collection's punctuation.
  if (indices.length === node.items.length) {
    if (isFlow) {
      // The brackets stay; their contents go.
      return [{ start: range(0)[0], end: range(node.items.length - 1)[1], text: '' }];
    }
    return [{
      start: valueStartOfKey(manifest, path),
      end: trimEnd(manifest.source, range(node.items.length - 1)[1]),
      text: ' []',
    }];
  }

  if (!isFlow) {
    // A block item owns its whole line; adjacent line spans touch but never overlap.
    return indices.map((index) => {
      const r = range(index);
      let start = r[0];
      const lineStart = manifest.source.lastIndexOf('\n', start - 1);
      if (lineStart !== -1 && manifest.source.slice(lineStart + 1, start).trim() === '-') {
        start = lineStart;
      }
      return { start, end: trimEnd(manifest.source, r[1]), text: '' };
    });
  }

  // Flow: merge runs of adjacent indices, then give each run one span. A run that
  // is followed by a survivor takes the comma after it; a run that ends the list
  // takes the comma before it instead.
  const splices: Splice[] = [];
  for (let i = 0; i < indices.length; ) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j]! + 1) j += 1;
    const first = indices[i]!;
    const last = indices[j]!;

    if (last < node.items.length - 1) {
      splices.push({ start: range(first)[0], end: range(last + 1)[0], text: '' });
    } else {
      const start = first > 0
        ? trimEnd(manifest.source, range(first - 1)[1])
        : range(first)[0];
      splices.push({ start, end: range(last)[1], text: '' });
    }
    i = j + 1;
  }
  return splices;
}

/** One item's removal. The plural form exists because spans of neighbours interact. */
export function removeSequenceItem(
  manifest: ManifestDocument,
  path: readonly string[],
  id: string,
): Splice {
  return removeSequenceItems(manifest, path, [id])[0]!;
}

/** The parsed mapping of the sequence item with this id, for editing its entries. */
export function findItemMap(
  manifest: ManifestDocument,
  path: readonly string[],
  id: string,
): YAMLMap {
  const node = manifest.doc.getIn(path, true);
  if (!isSeq(node)) {
    throw new ManifestEditError(`${path.join('.')} is not a sequence in this manifest`);
  }
  const item = node.items.find(
    (candidate) =>
      isMap(candidate) && isScalar(candidate.get('id', true)) &&
      (candidate.get('id', true) as { value?: unknown }).value === id,
  );
  if (!item) throw new ManifestEditError(`no item with id "${id}" in ${path.join('.')}`);
  return item as YAMLMap;
}

const pairKeyName = (pair: Pair): string | undefined =>
  isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined;

/**
 * Sets entries on one mapping — replacing values that exist, appending keys that do
 * not — in the mapping's own style. `rendered` values are already YAML text.
 *
 * New keys are combined into a single insertion so a patch that adds two fields
 * lands them in the order the patch stated, rather than in whichever order a sort
 * of equal offsets happens to leave.
 */
export function setMapEntries(
  manifest: ManifestDocument,
  map: YAMLMap,
  rendered: ReadonlyMap<string, string>,
): Splice[] {
  if (!map.range) throw new ManifestEditError('this mapping has no position in the source');
  const flow = (map as { flow?: boolean }).flow ?? false;
  const splices: Splice[] = [];
  const additions: string[] = [];

  for (const [key, text] of rendered) {
    const pair = map.items.find((p) => pairKeyName(p) === key);

    if (pair) {
      const value = pair.value as { range?: [number, number, number] } | null;
      if (value?.range) {
        splices.push({ start: value.range[0], end: trimEnd(manifest.source, value.range[1]), text });
      } else {
        // `key:` with nothing after it — the value goes where one would have been.
        const keyNode = pair.key as { range?: [number, number, number] };
        if (!keyNode.range) throw new ManifestEditError(`"${key}" has no position in the source`);
        const colon = manifest.source.indexOf(':', keyNode.range[1]);
        splices.push({ start: colon + 1, end: colon + 1, text: ` ${text}` });
      }
      continue;
    }
    additions.push(`${key}: ${text}`);
  }

  if (additions.length > 0) {
    const last = map.items[map.items.length - 1];
    const lastValue = (last?.value ?? last?.key) as { range?: [number, number, number] } | undefined;
    if (!lastValue?.range) throw new ManifestEditError('cannot find where this mapping ends');
    let at = trimEnd(manifest.source, lastValue.range[1]);

    // A trailing comment on the last entry's line belongs to that entry. Inserting
    // between the value and its comment would hand the comment to the new line, so
    // the insertion point moves past it to the line's end.
    if (!flow) {
      const lineEnd = manifest.source.indexOf('\n', at);
      const rest = manifest.source.slice(at, lineEnd === -1 ? manifest.source.length : lineEnd);
      if (/^[ \t]*#/.test(rest)) at = lineEnd === -1 ? manifest.source.length : lineEnd;
    }

    if (flow) {
      splices.push({ start: at, end: at, text: `, ${additions.join(', ')}` });
    } else {
      // New lines get the column the first key uses, which is the item's own indent.
      const firstKey = map.items[0]!.key as { range: [number, number, number] };
      const lineStart = manifest.source.lastIndexOf('\n', firstKey.range[0] - 1) + 1;
      const indent = ' '.repeat(firstKey.range[0] - lineStart);
      splices.push({
        start: at,
        end: at,
        text: additions.map((entry) => `\n${indent}${entry}`).join(''),
      });
    }
  }

  return splices;
}

/**
 * Removes a set of entries from one mapping, with the punctuation or lines they sat
 * on. Plural for the same reason removeSequenceItems is: in a flow mapping, adjacent
 * entries' spans share a comma, and computed independently they overlap and shred
 * the text between them. Keys that are not present are skipped; the second element
 * of the result says which were actually there.
 */
export function removeMapEntries(
  manifest: ManifestDocument,
  map: YAMLMap,
  keys: readonly string[],
): { splices: Splice[]; removed: string[] } {
  const wanted = new Set(keys);
  const indices: number[] = [];
  const removed: string[] = [];
  map.items.forEach((pair, index) => {
    const name = pairKeyName(pair);
    if (name !== undefined && wanted.has(name)) {
      indices.push(index);
      removed.push(name);
    }
  });
  if (indices.length === 0) return { splices: [], removed };

  const keyRange = (i: number): [number, number, number] => {
    const r = (map.items[i]!.key as { range?: [number, number, number] }).range;
    if (!r) throw new ManifestEditError('a mapping key has no position in the source');
    return r;
  };
  const valueEnd = (i: number): number => {
    const node = (map.items[i]!.value ?? map.items[i]!.key) as { range?: [number, number, number] };
    if (!node.range) throw new ManifestEditError('a mapping value has no position in the source');
    return trimEnd(manifest.source, node.range[1]);
  };

  if (!(map as { flow?: boolean }).flow) {
    // A block entry owns its whole line; line spans never overlap.
    const splices = indices.map((index) => {
      let start = keyRange(index)[0];
      const lineStart = manifest.source.lastIndexOf('\n', start - 1);
      if (lineStart !== -1 && manifest.source.slice(lineStart + 1, start).trim() === '') {
        start = lineStart;
      }
      return { start, end: valueEnd(index), text: '' };
    });
    return { splices, removed };
  }

  // Flow: merge runs of adjacent entries into one span each.
  const splices: Splice[] = [];
  for (let i = 0; i < indices.length; ) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j]! + 1) j += 1;
    const first = indices[i]!;
    const last = indices[j]!;

    if (last < map.items.length - 1) {
      splices.push({ start: keyRange(first)[0], end: keyRange(last + 1)[0], text: '' });
    } else {
      const start = first > 0 ? valueEnd(first - 1) : keyRange(first)[0];
      splices.push({ start, end: valueEnd(last), text: '' });
    }
    i = j + 1;
  }
  return { splices, removed };
}

/** One entry's removal, or undefined when the key is not there. */
export function removeMapEntry(
  manifest: ManifestDocument,
  map: YAMLMap,
  key: string,
): Splice | undefined {
  return removeMapEntries(manifest, map, [key]).splices[0];
}
