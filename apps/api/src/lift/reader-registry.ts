import ts from 'typescript';
import { byString, decoratorsOf, hasModifier, propName, unwrap, type Decl, type RepoContext } from './read.js';

/**
 * Declaration registries, recognised by shape (docs/lift-repo.md). A codebase that
 * does not list its controllers in @Module metadata, or that declares its work as data
 * rather than classes, writes it down somewhere else: an exported array.
 *
 *   export const HTTP_CONTROLLERS = [OrdersController, InvoicesController];
 *   export const ORDER_ACTIONS = [placeOrderAction, ...MORE_ACTIONS];
 *
 * An exported array (any file) is a registry when its elements — through spreads,
 * conditionals, and identifiers resolved across files — include either
 *
 * - a class decorated @Controller: the controller is served, wherever it is mounted; or
 * - an object built by a define-style factory: a function named define…/create…/make…/
 *   register… called with exactly one object literal that has at least one key a
 *   declaration carries (DECLARATION_KEYS). That object is a declared operation of
 *   the code that defines it.
 *
 * The array's own name is never consulted; neither is any project's vocabulary. What
 * the reader takes from an operation is coarse on purpose — its name, whether it is
 * exposed to an agent (a `tool` key), its `exposure`, whether it is scheduled — because
 * Civil works at the altitude of services and operations are their attributes.
 */

/** A callee named like a factory that builds a declaration. */
const DEFINE_FACTORY = /^(define|create|make|register)([A-Z_]|$)/;

/** Keys a declaration object carries; one is enough to tell it from an options bag. */
const DECLARATION_KEYS = new Set([
  'contract',
  'input',
  'output',
  'schema',
  'run',
  'handler',
  'execute',
  'exposure',
  'tool',
  'schedule',
  'cron',
  'job',
]);

/** Where a scheduled declaration's timing is written, in the order they are looked for. */
const TIMING_KEYS = ['cron', 'schedule', 'spec', 'every', 'interval', 'at'];

export interface RegistryArray {
  name: string;
  file: string;
  line: number;
}

export interface DeclaredOperation {
  /** Stable identity: the binding's file#name, or file:position for an inline call. */
  key: string;
  name: string;
  file: string;
  line: number;
  kind: string;
  exposure?: string;
  tool: boolean;
  scheduled: boolean;
  /** For a scheduled one: its timing as a cron, or as written with `problem` saying so. */
  schedule?: string;
  problem?: string;
}

export interface RegistryRead {
  /** Exported arrays that hold at least one controller or declaration. */
  arrays: RegistryArray[];
  /** @Controller classes listed in a registry, by file#name. */
  controllers: Map<string, { decl: Decl; registries: RegistryArray[] }>;
  operations: Map<string, { op: DeclaredOperation; registries: RegistryArray[] }>;
}

/** A define-style call: `defineAction({ contract, run })`. */
export function defineCall(expr: ts.Expression): { call: ts.CallExpression; factory: string; obj: ts.ObjectLiteralExpression } | null {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e) || e.arguments.length !== 1) return null;
  const callee = unwrap(e.expression);
  const factory = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  if (!factory || !DEFINE_FACTORY.test(factory)) return null;
  const obj = unwrap(e.arguments[0]!);
  if (!ts.isObjectLiteralExpression(obj)) return null;
  const keys = obj.properties.flatMap((p) => (p.name ? [propName(p.name as ts.PropertyName)] : []));
  if (!keys.some((k) => k !== undefined && DECLARATION_KEYS.has(k))) return null;
  return { call: e, factory, obj };
}

const short = (node: ts.Node): string => {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

function readOperation(ctx: RepoContext, file: string, found: NonNullable<ReturnType<typeof defineCall>>, key: string, bound: string | undefined): DeclaredOperation {
  const prop = (n: string): ts.Expression | undefined => {
    for (const p of found.obj.properties) {
      if (!p.name || propName(p.name as ts.PropertyName) !== n) continue;
      if (ts.isPropertyAssignment(p)) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p)) return p.name;
      if (ts.isMethodDeclaration(p)) return p.name as ts.Expression;
    }
    return undefined;
  };
  const named = prop('name');
  const name = (named ? ctx.evalString(file, named) : undefined) ?? bound ?? found.factory;
  const exposureExpr = prop('exposure');
  const exposure = exposureExpr ? ctx.evalString(file, exposureExpr) : undefined;
  const scheduled = /schedule|cron/i.test(found.factory) || prop('schedule') !== undefined || prop('cron') !== undefined;
  const op: DeclaredOperation = {
    key,
    name,
    file,
    line: ctx.line(file, found.call),
    kind: found.factory,
    tool: prop('tool') !== undefined,
    scheduled,
  };
  if (exposure !== undefined) op.exposure = exposure;
  if (scheduled) {
    const timingKey = TIMING_KEYS.find((k) => prop(k) !== undefined);
    const timing = timingKey ? prop(timingKey)! : undefined;
    const fixed = timing ? ctx.evalString(file, timing) : undefined;
    if (fixed !== undefined) op.schedule = fixed;
    else if (timing) {
      op.schedule = short(timing);
      op.problem = `scheduled ${name}: its timing "${short(timing)}" is computed; kept as written`;
    } else {
      op.schedule = '@unknown';
      op.problem = `scheduled ${name}: no timing the reader can find (${TIMING_KEYS.join(', ')})`;
    }
  }
  return op;
}

type Element = { kind: 'controller'; decl: Decl } | { kind: 'operation'; op: DeclaredOperation };

/** Every exported array of the given files that is a registry, and what each lists. */
export function readRegistries(ctx: RepoContext, files: readonly string[]): RegistryRead {
  const out: RegistryRead = { arrays: [], controllers: new Map(), operations: new Map() };
  const opCache = new Map<string, DeclaredOperation>();

  const elementsOf = (file: string, expr: ts.Expression, depth: number, seen: Set<string>, acc: Element[]): void => {
    if (depth > 12) return;
    const e = unwrap(expr);
    if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) elementsOf(file, ts.isSpreadElement(el) ? el.expression : el, depth + 1, seen, acc);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      elementsOf(file, e.whenTrue, depth + 1, seen, acc);
      elementsOf(file, e.whenFalse, depth + 1, seen, acc);
      return;
    }
    const inline = defineCall(e);
    if (inline) {
      const key = `${file}:${e.getStart()}`;
      if (!opCache.has(key)) opCache.set(key, readOperation(ctx, file, inline, key, undefined));
      acc.push({ kind: 'operation', op: opCache.get(key)! });
      return;
    }
    if (!ts.isIdentifier(e)) return;
    const d = ctx.resolveName(file, e.text);
    if (!d || 'external' in d) return;
    const key = `${d.file}#${d.name}`;
    if (d.kind === 'class') {
      if (decoratorsOf(d.node).some((x) => x.name === 'Controller')) acc.push({ kind: 'controller', decl: d });
      return;
    }
    if (!ts.isVariableDeclaration(d.node) || !d.node.initializer || seen.has(key)) return;
    seen.add(key);
    const found = defineCall(d.node.initializer);
    if (found) {
      if (!opCache.has(key)) opCache.set(key, readOperation(ctx, d.file, found, key, d.name));
      acc.push({ kind: 'operation', op: opCache.get(key)! });
      return;
    }
    elementsOf(d.file, d.node.initializer, depth + 1, seen, acc);
  };

  for (const file of files) {
    const sf = ctx.sourceFile(file);
    for (const stmt of sf?.statements ?? []) {
      if (!ts.isVariableStatement(stmt) || !hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isArrayLiteralExpression(unwrap(d.initializer))) continue;
        const acc: Element[] = [];
        elementsOf(file, d.initializer, 0, new Set([`${file}#${d.name.text}`]), acc);
        if (!acc.length) continue;
        const array: RegistryArray = { name: d.name.text, file, line: ctx.line(file, d) };
        out.arrays.push(array);
        for (const el of acc) {
          if (el.kind === 'controller') {
            const k = `${el.decl.file}#${el.decl.name}`;
            const rec = out.controllers.get(k) ?? { decl: el.decl, registries: [] };
            if (!rec.registries.includes(array)) rec.registries.push(array);
            out.controllers.set(k, rec);
          } else {
            const rec = out.operations.get(el.op.key) ?? { op: el.op, registries: [] };
            if (!rec.registries.includes(array)) rec.registries.push(array);
            out.operations.set(el.op.key, rec);
          }
        }
      }
    }
  }
  out.arrays.sort((a, b) => byString(a.file, b.file) || a.line - b.line);
  return out;
}
