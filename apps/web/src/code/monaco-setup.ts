import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

/**
 * Monaco is bundled rather than loaded from a CDN.
 *
 * @monaco-editor/react loads Monaco from jsdelivr by default. Bundling it instead
 * removes a third party from the critical path of the editor: it keeps working when
 * someone else's CDN has a bad day, the version is pinned to the lockfile rather than
 * to whatever a URL resolves to today, and it works offline.
 *
 * To be accurate about what this is NOT: the CDN never sees your code. Monaco runs
 * entirely client-side and the CDN only serves script assets, so file contents and
 * paths never leave the browser either way. This is an availability and supply-chain
 * argument, not a confidentiality one.
 *
 * The cost is roughly 860KB gzipped, which is why it is also lazy-loaded — see the
 * dynamic import in App.tsx.
 */

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId, label) {
    // JSON is the only language here with a worker worth having — it powers schema
    // validation on the *.schema.json files. Python and YAML ship syntax only, which
    // is all M2 needs; understanding Python is the runtime's job (PRD 7.2), not the
    // editor's.
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

/** Civil's palette, so the editor is not a bright rectangle in a dark shell. */
export const CIVIL_THEME = 'civil-dark';

monaco.editor.defineTheme(CIVIL_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5b6675', fontStyle: 'italic' },
    { token: 'string', foreground: '4ec9a0' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'number', foreground: 'e0a458' },
    { token: 'type', foreground: '7cc4ff' },
  ],
  colors: {
    'editor.background': '#0a0d11',
    'editor.foreground': '#dfe6ef',
    'editorLineNumber.foreground': '#3a4552',
    'editorLineNumber.activeForeground': '#8b97a8',
    'editor.selectionBackground': '#2f5d8f55',
    'editor.lineHighlightBackground': '#151a2155',
    'editorCursor.foreground': '#5aa9ff',
    'editorIndentGuide.background1': '#232b36',
    'editorGutter.background': '#0a0d11',
  },
});

export { monaco };
