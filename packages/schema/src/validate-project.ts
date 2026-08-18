import type { Diagnostic } from './diagnostics.js';
import type { ProjectFiles } from './files.js';
import { zGraph } from './manifest/graph.js';
import { validateComposition, validateGraph } from './validate.js';

/**
 * Cross-file validation. YAML parsing stays outside this package on purpose:
 * PRD 7.1 says the client never constructs YAML, so the browser only ever sees
 * already-parsed documents. The caller supplies the loader.
 */
export interface ProjectSources {
  files: ProjectFiles;
  /** Returns the parsed document at `path`, or undefined if absent/unparseable. */
  loadDoc(path: string): unknown;
}

export interface ProjectValidation {
  diagnostics: Diagnostic[];
  /** Every graph file reachable from the composition, in discovery order. */
  graphFiles: string[];
}

/**
 * PRD 6.4: "Subgraph containment cycles rejected with the full cycle path."
 * A graph that transitively contains itself would descend forever.
 */
export function validateProject(
  compositionPath: string,
  sources: ProjectSources,
): ProjectValidation {
  const { files, loadDoc } = sources;
  const diagnostics: Diagnostic[] = [];
  const graphFiles: string[] = [];

  const compositionRaw = loadDoc(compositionPath);
  if (compositionRaw === undefined) {
    return {
      graphFiles,
      diagnostics: [
        {
          file: compositionPath,
          jsonPointer: '',
          code: 'unresolved-ref',
          message: `composition "${compositionPath}" could not be read`,
          severity: 'error',
        },
      ],
    };
  }

  const composition = validateComposition(compositionRaw, compositionPath, files);
  diagnostics.push(...composition.diagnostics);

  const roots: string[] = [];
  for (const node of composition.doc?.spec.nodes ?? []) {
    if (node.type === 'service' && 'graph' in node.impl) roots.push(node.impl.graph);
  }

  // Colour-marked DFS over subgraph references. GREY means "on the current descent
  // path", which is exactly the containment cycle the PRD wants rejected.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const descend = (path: string): void => {
    const current = colour.get(path) ?? WHITE;
    if (current === BLACK) return;
    if (current === GREY) {
      const start = stack.indexOf(path);
      const cyclePath = [...stack.slice(start), path];
      const key = [...cyclePath].sort().join('>');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        diagnostics.push({
          file: stack[stack.length - 1] ?? path,
          jsonPointer: '',
          code: 'subgraph-cycle',
          message: `subgraph containment cycle: ${cyclePath.join(' → ')}`,
          severity: 'error',
          cyclePath,
        });
      }
      return;
    }

    colour.set(path, GREY);
    stack.push(path);
    graphFiles.push(path);

    const raw = loadDoc(path);
    if (raw !== undefined) {
      const result = validateGraph(raw, path, files);
      diagnostics.push(...result.diagnostics);

      // Descend even when the graph failed its own validation, so a cycle is still
      // reported rather than hidden behind an unrelated error. Re-parse leniently:
      // a doc that failed strict validation may still have usable subgraph refs.
      const lenient = result.doc ?? zGraph.deepPartial().safeParse(raw).data;
      for (const node of lenient?.spec?.nodes ?? []) {
        if (node && node.type === 'subgraph' && typeof node.ref === 'string') descend(node.ref);
      }
    }

    stack.pop();
    colour.set(path, BLACK);
  };

  for (const root of roots) descend(root);

  return { diagnostics, graphFiles };
}
