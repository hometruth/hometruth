type UpstreamFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** Forward once, preserving streaming responses and the caller's cancellation. */
export function forwardToWorker(request: Request, upstream: URL, headers: Headers, fetchUpstream: UpstreamFetch = fetch): Promise<Response> {
  // The proxy must not turn a slow response into a false application outage.
  // Renderers use cached state; command endpoints have their own device deadlines.
  // Worker liveness is managed by the supervisor's heartbeat watchdog instead.
  return fetchUpstream(upstream, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    redirect: "manual",
  });
}
