export interface HttpPost {
  (url: string, init: { headers: Record<string, string>; body: string }):
    Promise<{ status: number; json: unknown; headers: Record<string, string> }>;
}

/**
 * Production adapter over Obsidian's requestUrl (main thread only). `throw: false`
 * so we classify status ourselves instead of letting requestUrl throw on 4xx/5xx.
 * Pass `requestUrl` in from main.ts; this module never imports 'obsidian' so the
 * pure provider stays unit-testable in Node.
 */
export function requestUrlPost(
  requestUrl: (p: { url: string; method: string; headers: Record<string, string>; body: string; throw: boolean }) =>
    Promise<{ status: number; json: unknown; headers: Record<string, string>; text: string }>,
): HttpPost {
  return async (url, init) => {
    const r = await requestUrl({ url, method: 'POST', headers: init.headers, body: init.body, throw: false });
    return { status: r.status, json: r.json, headers: r.headers ?? {} };
  };
}
