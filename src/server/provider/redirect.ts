/**
 * A streaming chat request is never allowed to follow a redirect.
 *
 * Leaving `redirect` unset is the platform default, which follows 307/308 by replaying the same
 * POST - the entire conversation - at whatever address the first server names, and turns 301/302
 * into a GET there. Since 1.2.5 a server can be admitted with no key at all because the address
 * you typed is on your own network, so one redirect from that server is enough to have the
 * conversation delivered somewhere it was never aimed at. Measured on 1.2.5 against two loopback
 * servers, the follow-up request carried 168 bytes of chat body and 231 bytes of responses body;
 * undici strips `authorization` across origins, so what crosses the boundary is the content.
 *
 * Model discovery already refuses redirects (`discover.ts` passes `redirect: "manual"`); this is
 * the same rule on the path that carries the conversation. A gateway that moves its endpoint
 * should be re-entered as the base URL, which is also the only way the admission rule below can
 * keep judging the address the person actually chose.
 */
/** A POST to a person-configured endpoint, with the redirect question settled here so no call
 * site has to remember it: 307/308 resend the body verbatim, 301/302 move it to GET. */
export async function postConversation(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual" })
  refuseRedirect(url, response)
  return response
}

export function refuseRedirect(endpoint: string, response: Response): void {
  if (response.status < 300 || response.status >= 400) return
  const location = response.headers.get("location") || "an unknown address"
  throw new Error(
    `The provider at ${endpoint} answered with a redirect to ${location}. A conversation is not replayed at another address: put that address in the provider's base URL and try again.`,
  )
}
