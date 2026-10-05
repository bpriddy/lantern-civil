import { posix } from 'node:path';
import type { SkeletonClient } from './skeleton.js';
import { civilId, type Pkg, type RepoContext } from './read.js';

/**
 * The Vite reader: a frontend package in, a client out. Deliberately thin — a
 * client node is the app, not its components, so what matters is that it exists,
 * how it is run, and (decided in read.ts, which sees every server) whom it calls.
 *
 * The source points at the vite.config when there is one, since that is the file
 * that makes the package a Vite app; otherwise at its package.json.
 */
export function readViteClient(
  ctx: RepoContext,
  pkg: Pkg,
  devScript: { name: string; command: string },
): SkeletonClient {
  const config = ['ts', 'mts', 'js', 'mjs']
    .map((ext) => posix.join(pkg.dir, `vite.config.${ext}`))
    .find((p) => ctx.files[p] !== undefined);
  return {
    id: civilId(posix.basename(pkg.dir) || (pkg.name ?? 'web').replace(/^@[^/]+\//, '')),
    path: pkg.dir,
    framework: 'vite',
    devScript: devScript.command,
    devScriptName: devScript.name,
    calls: [],
    source: { file: config ?? pkg.manifest },
  };
}
