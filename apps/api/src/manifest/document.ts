import { isSeq, parseDocument, type Document } from 'yaml';

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
  /** The exact leading text of an item, e.g. "\n    - ". */
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

    return {
      insertAt: range[0],
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

  // The prefix is read from the source rather than assumed, so a file indented with
  // four spaces, or with its dashes in an unusual place, keeps its own shape.
  const beforeFirst = manifest.source.lastIndexOf('\n', first.range[0] - 1);
  const itemPrefix = manifest.source.slice(beforeFirst, first.range[0]);

  const firstText = manifest.source.slice(first.range[0], first.range[1]).trim();

  return {
    // range[1] is the value's end; range[2] includes trailing comment and newline. The
    // value end is what a new item should follow.
    insertAt: last.range[1],
    replaceTo: last.range[1],
    itemPrefix,
    flow: firstText.startsWith('{'),
    count: items.length,
  };
}
