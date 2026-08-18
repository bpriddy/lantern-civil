/**
 * PRD 6.4: validation errors are structured — { file, jsonPointer, code, message } —
 * and render on the offending node. This package is imported by both the server and
 * the browser, so diagnostics are plain data with no rendering opinions.
 */

/**
 * PRD 6.4 draws one distinction that matters: a flow cycle must "mark it red, block
 * Run — don't fail the save." So a diagnostic either invalidates the manifest or
 * merely blocks execution, and the writer needs to know which.
 */
export type Severity =
  /** The manifest is invalid. The op that produced it should not be committed. */
  | 'error'
  /** The manifest saves fine, but Run is disabled until it is resolved. */
  | 'run-blocking';

export const DIAGNOSTIC_CODES = [
  'invalid-manifest',
  'duplicate-id',
  'unresolved-ref',
  'unresolved-entrypoint',
  'unresolved-schema',
  'invalid-json-schema',
  'unknown-node',
  'exposes-non-service',
  'calls-non-service',
  'client-is-edge-target',
  'capability-edge-bad-source',
  'capability-edge-bad-target',
  'flow-code-node-needs-entrypoint',
  'io-direction-violation',
  'subgraph-cycle',
  'flow-cycle',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface Diagnostic {
  /** Project-relative path of the file the problem lives in. */
  file: string;
  /** RFC 6901 pointer into that file's parsed document. */
  jsonPointer: string;
  code: DiagnosticCode;
  message: string;
  severity: Severity;
  /** Set when the diagnostic should render on a node face. */
  nodeId?: string;
  /** Set when it should render on an edge. */
  edgeId?: string;
  /** For cycle diagnostics: the full path, so the message can name it (PRD 6.4). */
  cyclePath?: string[];
}

export function isFatal(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function blocksRun(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.length > 0;
}

export function diagnosticsFor(
  diagnostics: readonly Diagnostic[],
  nodeId: string,
): Diagnostic[] {
  return diagnostics.filter((d) => d.nodeId === nodeId);
}
