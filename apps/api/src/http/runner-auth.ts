/**
 * Cloud Run's IAM guards the runner — only the API's identity may invoke it — so
 * dispatch carries an ID token minted by the metadata server. Locally there is no
 * metadata server and no IAM: the fetch fails fast once, and dispatch goes bare.
 * Tokens last an hour; cached for fifty minutes.
 *
 * Shared by every route family that dispatches to the runner (runs, transpile), so
 * the cache and the "no metadata here" discovery are learned once per process.
 */
let cachedIdToken: { audience: string; token: string; expires: number } | null = null;
let metadataAbsent = false;

export async function idTokenFor(audience: string): Promise<string | undefined> {
  if (metadataAbsent) return undefined;
  if (cachedIdToken && cachedIdToken.audience === audience && Date.now() < cachedIdToken.expires) {
    return cachedIdToken.token;
  }
  try {
    const response = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
    );
    if (!response.ok) throw new Error(`metadata ${response.status}`);
    const token = await response.text();
    cachedIdToken = { audience, token, expires: Date.now() + 50 * 60 * 1000 };
    return token;
  } catch {
    metadataAbsent = true;
    return undefined;
  }
}
