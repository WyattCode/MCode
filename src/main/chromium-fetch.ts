import { net } from "electron"

/**
 * Chromium's network for the video cards' lookups and covers, as MiMo's use
 * it (its cover proxy and media lookup are both handed `net.fetch`): the
 * system proxy, PAC/WPAD and the OS certificate store apply, where Node's
 * fetch ignores all three.
 *
 * Built on `net.request` rather than `net.fetch`, because `net.fetch` does not
 * answer a `redirect: "manual"` request with the redirect: it fails it
 * ("Redirect was cancelled"), and the cover proxy must see each hop to hold it
 * to the host list. Here a manual redirect comes back as a bodiless 3xx with
 * its `location`, as the fetch standard's callers expect. Nothing is sent
 * with the session's cookies, and nothing the servers set is kept.
 *
 * Only what those callers use is supported: method, headers, redirect and
 * signal, no request body.
 */

/* Statuses a Response may not carry a body with. */
const BODILESS = new Set([101, 103, 204, 205, 304])

function aborted(): DOMException {
  return new DOMException("This operation was aborted", "AbortError")
}

export function chromiumFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined
  if (signal?.aborted) return Promise.reject(aborted())
  return new Promise<Response>((resolve, reject) => {
    let settled = false
    let fail: (error: Error) => void = () => undefined
    const request = net.request({ url, method: init.method ?? "GET", redirect: init.redirect ?? "follow", credentials: "omit" })
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value)
    const settle = (answer: () => void) => {
      if (settled) return
      settled = true
      answer()
    }
    const onAbort = () => {
      request.abort()
      settle(() => reject(aborted()))
      fail(aborted())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const done = () => signal?.removeEventListener("abort", onAbort)

    request.on("redirect", (status, _method, location) => {
      if (init.redirect !== "manual") return
      // Not followed: Chromium cancels the request once this returns.
      done()
      settle(() => resolve(new Response(null, { status, headers: { location } })))
    })
    request.on("response", (message) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(message.headers)) {
        if (name === "set-cookie") continue
        headers.set(name, Array.isArray(value) ? value.join(", ") : value)
      }
      const status = message.statusCode
      if (BODILESS.has(status) || (init.method ?? "GET").toUpperCase() === "HEAD") {
        done()
        settle(() => resolve(new Response(null, { status, headers })))
        return
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          fail = (error) => {
            try {
              controller.error(error)
            } catch {
              // Already closed.
            }
          }
          message.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          message.on("end", () => {
            done()
            try {
              controller.close()
            } catch {
              // Already failed.
            }
          })
          message.on("error", (error: Error) => {
            done()
            fail(error)
          })
          message.on("aborted", () => fail(aborted()))
        },
        cancel() {
          done()
          request.abort()
        },
      })
      settle(() => resolve(new Response(body, { status, statusText: message.statusMessage, headers })))
    })
    request.on("error", (error) => {
      done()
      settle(() => reject(error))
      fail(error)
    })
    request.end()
  })
}
