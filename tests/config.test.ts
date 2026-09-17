import { describe, expect, it } from 'bun:test'
import { ROBOQUANT_URL, roboquantLink } from '../src/config'

describe('roboquantLink', () => {
  it('points at the Roboquant website', () => {
    expect(ROBOQUANT_URL).toBe('https://roboquant.dev')
    expect(new URL(roboquantLink('/', 'popup')).origin).toBe(ROBOQUANT_URL)
  })

  it('adds UTM parameters for the given surface', () => {
    const url = new URL(roboquantLink('/', 'results'))
    expect(url.searchParams.get('utm_source')).toBe('tradingview-optimizer')
    expect(url.searchParams.get('utm_medium')).toBe('extension')
    expect(url.searchParams.get('utm_content')).toBe('results')
  })

  it('joins paths with or without a leading slash', () => {
    expect(new URL(roboquantLink('/prop-firms', 'results')).pathname).toBe('/prop-firms')
    expect(new URL(roboquantLink('prop-firms', 'results')).pathname).toBe('/prop-firms')
    expect(new URL(roboquantLink('/', 'popup')).pathname).toBe('/')
  })

  it('encodes the content value', () => {
    const url = roboquantLink('/', 'results panel')
    expect(url).toContain('utm_content=results+panel')
  })
})
