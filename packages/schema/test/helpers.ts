import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ProjectFiles } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_ROOT = path.resolve(here, '../../../examples/doc-pipeline');

/** The server-side ProjectFiles: a real checkout on disk. */
export class DiskFiles implements ProjectFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  exists(p: string): boolean {
    return fs.existsSync(path.join(this.root, p));
  }

  read(p: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.root, p), 'utf8');
    } catch {
      return undefined;
    }
  }

  glob(pattern: string): string[] {
    return fs
      .globSync(pattern, { cwd: this.root })
      .map((f) => f.split(path.sep).join('/'))
      .sort();
  }
}

export function loadYaml(root: string) {
  return (p: string): unknown => {
    try {
      return parse(fs.readFileSync(path.join(root, p), 'utf8'));
    } catch {
      return undefined;
    }
  };
}

export const codes = (ds: readonly { code: string }[]): string[] => ds.map((d) => d.code).sort();
