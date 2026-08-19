import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

/**
 * Monaco is bundled rather than loaded from a CDN.
 *
 * @monaco-editor/react fetches from jsdelivr by default, which makes the editor stop
 * working when someone else's CDN has a bad day, and leaks every file path you open
 * to a third party in the request for its language workers. Neither is acceptable for
 * something whose whole job is editing your source.
 *
 * The cost is roughly a megabyte of gzipped JavaScript. For an IDE that is the deal.
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
