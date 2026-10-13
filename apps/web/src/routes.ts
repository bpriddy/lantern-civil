/**
 * The URL is a place in the IDE: `/` is home, `/p/<project>` is the composition
 * canvas, `/p/<project>/v/<view>[/d/<domain>]` is one view of it (at its top or
 * inside a domain), and
 * `/p/<project>/g/<graph path>` is a graph. Direct links and refreshes
 * land where they say (the API's not-found handler already serves index.html for
 * anything that is not data), and back/forward walk the places visited. Code
 * altitude — which files Monaco has open — is deliberately not addressable:
 * editor tabs are working state, not a location.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'project'; projectId: string }
  // One view of the composition (§21), at its top or inside one of its domains.
  | { kind: 'view'; projectId: string; view: string; domain?: string }
  | { kind: 'graph'; projectId: string; graphPath: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'p' || !parts[1]) return { kind: 'home' };
  if (parts[2] === 'v' && (parts.length === 4 || (parts.length === 6 && parts[4] === 'd'))) {
    return { kind: 'view', projectId: parts[1], view: parts[3]!, ...(parts[5] ? { domain: parts[5] } : {}) };
  }
  if (parts[2] === 'g' && parts.length > 3) {
    return { kind: 'graph', projectId: parts[1], graphPath: parts.slice(3).join('/') };
  }
  return { kind: 'project', projectId: parts[1] };
}

export function routePath(route: Route): string {
  if (route.kind === 'home') return '/';
  const project = `/p/${encodeURIComponent(route.projectId)}`;
  if (route.kind === 'project') return project;
  if (route.kind === 'view') {
    const view = `${project}/v/${encodeURIComponent(route.view)}`;
    return route.domain ? `${view}/d/${encodeURIComponent(route.domain)}` : view;
  }
  const graph = route.graphPath.split('/').map(encodeURIComponent).join('/');
  return `${project}/g/${graph}`;
}
