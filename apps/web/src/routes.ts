/**
 * The URL is a place in the IDE: `/` is home, `/p/<project>` is the composition
 * canvas, `/p/<project>/g/<graph path>` is a graph. Direct links and refreshes
 * land where they say (the API's not-found handler already serves index.html for
 * anything that is not data), and back/forward walk the places visited. Code
 * altitude — which files Monaco has open — is deliberately not addressable:
 * editor tabs are working state, not a location.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'project'; projectId: string }
  | { kind: 'graph'; projectId: string; graphPath: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'p' || !parts[1]) return { kind: 'home' };
  if (parts[2] === 'g' && parts.length > 3) {
    return { kind: 'graph', projectId: parts[1], graphPath: parts.slice(3).join('/') };
  }
  return { kind: 'project', projectId: parts[1] };
}

export function routePath(route: Route): string {
  if (route.kind === 'home') return '/';
  const project = `/p/${encodeURIComponent(route.projectId)}`;
  if (route.kind === 'project') return project;
  const graph = route.graphPath.split('/').map(encodeURIComponent).join('/');
  return `${project}/g/${graph}`;
}
