import { linkOnlyCard, readMediaMeta, type MediaMeta } from "@shared/media-platform"

/*
 * The window's half of MiMo's video cards: the cards the main process looked
 * up, kept for the session.
 */

const PER_CALL = 20
const known = new Map<string, MediaMeta>()
const asking = new Map<string, Promise<MediaMeta | undefined>>()

/**
 * The cards for these links, in order; a link the platform says nothing usable about has none.
 * With `details` off (the settings switch) nothing is asked: each card is its link alone.
 */
export async function enrichMedia(urls: string[], details = true): Promise<MediaMeta[]> {
  if (!details) return urls.map(linkOnlyCard).filter((meta): meta is MediaMeta => Boolean(meta))
  const bridge = window.mcode
  const fresh = urls.filter((url) => !known.has(url) && !asking.has(url))
  if (fresh.length && bridge?.mediaEnrich) {
    for (let at = 0; at < fresh.length; at += PER_CALL) {
      const batch = fresh.slice(at, at + PER_CALL)
      const job = bridge
        .mediaEnrich(batch)
        .catch(() => batch.map(() => null))
        .then((answers) => {
          batch.forEach((url, index) => {
            const meta = readMediaMeta(answers[index])
            // Only a card is kept: a miss is asked again, and the main process decides how long a miss lasts.
            if (meta) known.set(url, meta)
            asking.delete(url)
          })
        })
      for (const url of batch) asking.set(url, job.then(() => known.get(url)))
    }
  }
  const found = await Promise.all(urls.map((url) => (known.has(url) ? Promise.resolve(known.get(url)) : (asking.get(url) ?? Promise.resolve(undefined)))))
  return found.filter((meta): meta is MediaMeta => Boolean(meta))
}
