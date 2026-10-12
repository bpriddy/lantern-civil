import ts from 'typescript';
import type { SkeletonRoute } from './skeleton.js';
import { propName, unwrap, type RepoContext } from './read.js';

/**
 * Custom route decorators, recognised by shape (docs/lift-repo.md). A project often
 * wraps Nest's HTTP method decorators in its own:
 *
 *   export const ReadRoute = (path: string) => applyDecorators(Get(path), UseGuards(G));
 *   export function Action(path: string) { return applyDecorators(Post(path), HttpCode(200)); }
 *   export const AdminList = applyDecorators(Get('list'), UseGuards(StaffOnlyGuard));
 *   const verb = (m: 'GET' | 'POST') => (path: string) =>
 *     applyDecorators(RequestMapping({ path, method: RequestMethod[m] }));
 *
 * The decorator a controller method carries is followed to its definition — through
 * imports, consts, factories that return a decorator — and evaluated symbolically: the
 * outer function's parameters are bound to the arguments written at the use site, so a
 * path passed through is the path the controller wrote, and a path read from a
 * property of the argument (`spec.web.at`) is read from the object the use site
 * names. A call with one object-literal argument (`defineThing({ ... })`) is read as
 * that object, as declaration registries are. Whatever cannot be fixed this way is
 * reported, never guessed. Resolution is depth-limited.
 *
 * Only Nest's own decorators end the search: Get/Post/Put/Patch/Delete/All/Options/Head
 * and RequestMapping, imported from outside the repository, inside applyDecorators,
 * an array, or returned directly.
 */

export const HTTP_METHODS: Record<string, SkeletonRoute['method']> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  All: 'ALL',
  Options: 'OPTIONS',
  Head: 'HEAD',
};

const METHOD_NAMES = new Set(Object.values(HTTP_METHODS));

/** The deepest a decorator's definition is followed: calls, consts, properties. */
const MAX_DEPTH = 12;

/** A route a custom decorator mounts: paths null when computed, method null when it is. */
export interface DecoratorRoute {
  method: SkeletonRoute['method'] | null;
  paths: string[] | null;
  /** The Nest decorator that ends the chain, as written: "Get", "RequestMapping". */
  via: string;
}

type Env = Map<string, Bound>;
interface Bound {
  file: string;
  node: ts.Node;
  env: Env;
}
/** A name imported from outside the repository, by its exported name. */
interface External {
  external: string;
  imported: string;
}

const EMPTY: Env = new Map();
const isExternal = (v: Bound | External | null): v is External => v !== null && 'external' in v;

/**
 * The routes a decorator expression on a controller method mounts, when it is a
 * repository-defined decorator that ends in Nest's HTTP decorators; null when it is not
 * one (external, unresolvable, or a decorator that mounts nothing).
 */
export function customRoutes(ctx: RepoContext, file: string, expr: ts.Expression): DecoratorRoute[] | null {
  const head = unwrap(expr);
  const callee = ts.isCallExpression(head) ? unwrap(head.expression) : head;
  if (!ts.isIdentifier(callee)) return null;
  const target = ctx.resolveName(file, callee.text);
  if (!target || 'external' in target) return null;
  const out: DecoratorRoute[] = [];
  new Evaluator(ctx).routes({ file, node: expr, env: EMPTY }, 0, out);
  return out.length ? out : null;
}

class Evaluator {
  constructor(private readonly ctx: RepoContext) {}

  /** What an identifier names: a binding in scope, a repo declaration, or an import. */
  private lookup(file: string, name: string, env: Env): Bound | External | null {
    const bound = env.get(name);
    if (bound) return bound;
    const binding = this.ctx.imports(file).get(name);
    const d = this.ctx.resolveName(file, name);
    if (!d) return null;
    if ('external' in d) return { external: d.external, imported: binding?.imported ?? name };
    if (ts.isVariableDeclaration(d.node)) return d.node.initializer ? { file: d.file, node: d.node.initializer, env: EMPTY } : null;
    return { file: d.file, node: d.node, env: EMPTY };
  }

  /** Follow identifiers and property reads to the expression they stand for. */
  resolve(v: Bound, depth: number): Bound | External | null {
    if (depth > MAX_DEPTH) return null;
    const n = ts.isExpression(v.node) ? unwrap(v.node) : v.node;
    if (ts.isIdentifier(n)) {
      const next = this.lookup(v.file, n.text, v.env);
      return next === null || isExternal(next) ? next : this.resolve(next, depth + 1);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const key = ts.isPropertyAccessExpression(n) ? n.name.text : this.str({ ...v, node: n.argumentExpression }, depth + 1);
      if (key === undefined) return null;
      const base = this.resolve({ ...v, node: n.expression }, depth + 1);
      if (base === null) return null;
      // A member of something imported from outside (an enum like RequestMethod): the
      // access itself is the answer, for the caller to read.
      if (isExternal(base)) return { external: base.external, imported: `${base.imported}.${key}` };
      const member = this.member(base, key, depth + 1);
      return member ? this.resolve(member, depth + 1) : null;
    }
    return { ...v, node: n };
  }

  /** An object a value is: a literal, or the one object-literal argument of a call. */
  private object(v: Bound, depth: number): { file: string; obj: ts.ObjectLiteralExpression; env: Env } | null {
    if (depth > MAX_DEPTH) return null;
    const r = this.resolve(v, depth + 1);
    if (!r || isExternal(r)) return null;
    if (ts.isObjectLiteralExpression(r.node)) return { file: r.file, obj: r.node, env: r.env };
    if (ts.isCallExpression(r.node) && r.node.arguments.length === 1) {
      const arg = this.resolve({ ...r, node: r.node.arguments[0]! }, depth + 1);
      if (arg && !isExternal(arg) && ts.isObjectLiteralExpression(arg.node)) return { file: arg.file, obj: arg.node, env: arg.env };
    }
    return null;
  }

  private member(base: Bound, key: string, depth: number): Bound | null {
    if (ts.isEnumDeclaration(base.node)) {
      const m = base.node.members.find((x) => propName(x.name as ts.PropertyName) === key);
      return m?.initializer ? { file: base.file, node: m.initializer, env: EMPTY } : null;
    }
    const o = this.object(base, depth + 1);
    if (!o) return null;
    // Later properties win, as at runtime; spreads are read into.
    for (const p of [...o.obj.properties].reverse()) {
      if (ts.isSpreadAssignment(p)) {
        const inner = this.member({ file: o.file, node: p.expression, env: o.env }, key, depth + 1);
        if (inner) return inner;
        continue;
      }
      if (!p.name || propName(p.name as ts.PropertyName) !== key) continue;
      if (ts.isPropertyAssignment(p)) return { file: o.file, node: p.initializer, env: o.env };
      if (ts.isShorthandPropertyAssignment(p)) return { file: o.file, node: p.name, env: o.env };
      return null;
    }
    return null;
  }

  /** A string a value fixes, or undefined. */
  str(v: Bound, depth: number): string | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const r = this.resolve(v, depth + 1);
    if (!r || isExternal(r)) return undefined;
    const n = r.node;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text;
      for (const span of n.templateSpans) {
        const s = this.str({ ...r, node: span.expression }, depth + 1);
        if (s === undefined) return undefined;
        out += s + span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.str({ ...r, node: n.left }, depth + 1);
      const rr = this.str({ ...r, node: n.right }, depth + 1);
      return l === undefined || rr === undefined ? undefined : l + rr;
    }
    return undefined;
  }

  /** Paths a route decorator's argument gives: none, 'x', ['a', 'b'], { path }. */
  private paths(v: Bound | null, depth: number): string[] | null {
    if (!v) return [''];
    const r = this.resolve(v, depth + 1);
    if (!r || isExternal(r)) return null;
    if (ts.isArrayLiteralExpression(r.node)) {
      const all = r.node.elements.map((el) => this.str({ ...r, node: el }, depth + 1));
      return all.every((s): s is string => s !== undefined) ? all : null;
    }
    if (ts.isObjectLiteralExpression(r.node)) {
      const p = this.member(r, 'path', depth + 1);
      return p ? this.paths(p, depth + 1) : [''];
    }
    const s = this.str(r, depth + 1);
    return s === undefined ? null : [s];
  }

  /** An HTTP method a value names: RequestMethod.GET, RequestMethod[m], 'GET'. */
  private method(v: Bound, depth: number): SkeletonRoute['method'] | null {
    const r = this.resolve(v, depth + 1);
    if (!r) return null;
    const name = isExternal(r) ? r.imported.split('.').slice(1).join('.') : this.str(r, depth + 1);
    const upper = name?.toUpperCase();
    return upper && METHOD_NAMES.has(upper as SkeletonRoute['method']) ? (upper as SkeletonRoute['method']) : null;
  }

  /** A function value: the node and the scope it closes over. */
  private fn(v: Bound, depth: number): { file: string; node: ts.FunctionLikeDeclaration; env: Env }[] {
    if (depth > MAX_DEPTH) return [];
    const r = this.resolve(v, depth + 1);
    if (!r || isExternal(r)) return [];
    const n = r.node;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.body) return [{ file: r.file, node: n, env: r.env }];
    if (ts.isCallExpression(n))
      return this.call(r, n, depth + 1).flatMap((ret) => this.fn(ret, depth + 1));
    if (ts.isConditionalExpression(n))
      return [...this.fn({ ...r, node: n.whenTrue }, depth + 1), ...this.fn({ ...r, node: n.whenFalse }, depth + 1)];
    return [];
  }

  /** The values a call to a repository function returns, its parameters bound to the arguments. */
  private call(at: Bound, call: ts.CallExpression, depth: number): Bound[] {
    return this.fn({ ...at, node: call.expression }, depth + 1).flatMap((f) => {
      const scope: Env = new Map(f.env);
      f.node.parameters.forEach((p, i) => {
        if (!ts.isIdentifier(p.name)) return;
        const arg = call.arguments[i];
        if (arg) scope.set(p.name.text, { ...at, node: arg });
        else if (p.initializer) scope.set(p.name.text, { file: f.file, node: p.initializer, env: scope });
        else scope.delete(p.name.text);
      });
      return returnsOf(f.file, f.node, scope);
    });
  }

  /** Every route an expression that produces decorators mounts. */
  routes(v: Bound, depth: number, out: DecoratorRoute[]): void {
    if (depth > MAX_DEPTH) return;
    const n = ts.isExpression(v.node) ? unwrap(v.node) : v.node;
    if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) this.routes({ ...v, node: ts.isSpreadElement(el) ? el.expression : el }, depth + 1, out);
      return;
    }
    if (ts.isConditionalExpression(n)) {
      this.routes({ ...v, node: n.whenTrue }, depth + 1, out);
      this.routes({ ...v, node: n.whenFalse }, depth + 1, out);
      return;
    }
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      const r = this.resolve({ ...v, node: n }, depth + 1);
      if (r && !isExternal(r) && ts.isExpression(r.node) && r.node !== n) this.routes(r, depth + 1, out);
      return;
    }
    if (!ts.isCallExpression(n)) return;
    const callee = this.resolve({ ...v, node: n.expression }, depth + 1);
    if (isExternal(callee)) {
      const name = callee.imported;
      const args = n.arguments;
      if (HTTP_METHODS[name]) {
        out.push({ method: HTTP_METHODS[name]!, paths: this.paths(args[0] ? { ...v, node: args[0] } : null, depth), via: name });
      } else if (name === 'RequestMapping') {
        const opts = args[0] ? { ...v, node: args[0] } : null;
        const path = opts ? this.member(opts, 'path', depth + 1) : null;
        const methodExpr = opts ? this.member(opts, 'method', depth + 1) : null;
        out.push({
          // Nest's RequestMapping defaults to GET.
          method: methodExpr ? this.method(methodExpr, depth) : 'GET',
          paths: this.paths(path, depth),
          via: name,
        });
      } else if (name === 'applyDecorators') {
        for (const a of args) this.routes({ ...v, node: ts.isSpreadElement(a) ? a.expression : a }, depth + 1, out);
      }
      return;
    }
    for (const ret of this.call(v, n, depth + 1)) this.routes(ret, depth + 1, out);
  }
}

/**
 * What a function returns — its expression body, or every `return` not inside a nested
 * function — with its local consts bound in `scope` (mutated), so returns can name them.
 */
function returnsOf(file: string, fn: ts.FunctionLikeDeclaration, scope: Env): Bound[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [{ file, node: body, env: scope }];
  const out: Bound[] = [];
  const nested = (n: ts.Node) => n !== body && (ts.isFunctionLike(n) || ts.isClassLike(n));
  const visit = (n: ts.Node): void => {
    if (nested(n)) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) scope.set(n.name.text, { file, node: n.initializer, env: scope });
    if (ts.isReturnStatement(n) && n.expression) out.push({ file, node: n.expression, env: scope });
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}
