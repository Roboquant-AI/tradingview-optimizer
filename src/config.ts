/** Public Roboquant website, without a trailing slash. */
export const ROBOQUANT_URL = 'https://roboquant.dev'

/**
 * Build a link to the Roboquant website tagged with UTM parameters so visits
 * from the extension can be attributed.
 *
 * @param path - Site path, with or without a leading slash (e.g. '/', 'pricing')
 * @param content - Which extension surface the link lives on (e.g. 'popup', 'results')
 */
export function roboquantLink(path: string, content: string): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, ROBOQUANT_URL)
  url.searchParams.set('utm_source', 'tradingview-optimizer')
  url.searchParams.set('utm_medium', 'extension')
  url.searchParams.set('utm_content', content)
  return url.toString()
}
