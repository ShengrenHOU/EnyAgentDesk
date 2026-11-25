/** Plain-text linkification for message excerpts, with no Markdown interpretation and no raw HTML. */

export type Inline = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string }

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
    return `${parsed.host}${path === '/' ? '' : path}`
  } catch (error) { void error /* Not a URL after all; show it as written. */; return url }
}
/** Splits plain text into text and bare-URL link nodes, excluding trailing sentence punctuation from URLs. */
export function linkify(text: string): Inline[] {
  return text.split(/(https?:\/\/[^\s)，。]*[^\s)，。.,;:!?'"])/).filter(Boolean).map((part): Inline => /^https?:\/\//.test(part)
    ? { kind: 'link', text: shortUrl(part), url: part } : { kind: 'text', text: part })
}
