import { GENERATION_UNSUPPORTED } from './SourceControl.js';

/**
 * Generation is explicit (owner's call, 2026-10-01): edits change the sketch at
 * once, and the code catches up when the author asks. This is the asking — and the
 * one place that says whether there is anything to ask for.
 */
export function ApplyButton({
  state,
  applying,
  onApply,
}: {
  state: 'never' | 'stale' | 'current' | 'unsupported' | undefined;
  applying: boolean;
  onApply: () => void;
}) {
  if (applying) {
    return (
      <span className="chip chip-applying" title="Generating code for the sketch — this takes a little while">
        <span className="dot warn pulse" />
        Applying…
      </span>
    );
  }
  if (state === 'unsupported') {
    // Civil generates Python only; a project lifted from a TypeScript repo keeps its
    // own code as the implementation. No button — there is nothing it could do.
    return (
      <span className="chip chip-unsupported" title={GENERATION_UNSUPPORTED}>
        <span className="dot" />
        No code generation
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="chip" title="The generated code matches the sketch">
        <span className="dot ok" />
        Applied
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip chip-apply"
      onClick={onApply}
      title="Generate code for what changed in the sketch, and update the running app (A)"
    >
      <span className="dot warn" />
      {state === 'never' ? 'Generate app' : 'Apply changes'}
    </button>
  );
}
