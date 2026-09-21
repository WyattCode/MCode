/**
 * How a custom provider's address and model ids are tidied before they are
 * used, as MiMo tidies them when it saves one.
 *
 * The form asks for the address up to `/v1`, but people paste the full
 * `/chat/completions` URL anyway; the adapter appends that path itself, so
 * left alone the request would go to `.../chat/completions/chat/completions`
 * and fail as "model unavailable". A model id never contains whitespace, so a
 * space that came along with a paste is dropped rather than sent upstream.
 */

/** The address without surrounding blanks, trailing slashes or a trailing `/chat/completions` or `/completions`. */
export function normalizeBaseURL(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/completions$/i, "")
    .replace(/\/+$/, "")
}

/** The model id with every whitespace character removed. */
export function normalizeModelId(raw: string): string {
  return raw.replace(/\s+/g, "")
}
