/**
 * Analytics bootstrap.
 *
 * Lives here rather than inline in index.html so the maintainer opt-out can read
 * a Vite env var, which HTML cannot.
 *
 * That distinction matters more than it looks. Blanket-excluding localhost — the
 * obvious way to keep dev sessions out of the numbers — silenced the majority of
 * real usage: localhost accounted for roughly twice the hosted traffic, and most
 * of it came from countries the maintainer has never worked from. Waymo's licence
 * forbids redistribution, so its users *must* run locally against their own data,
 * which makes local runs the very cohort worth measuring.
 *
 * So local runs are reported and labelled; only the maintainer's machine opts
 * out, via a gitignored .env.local.
 */

const MEASUREMENT_ID = 'G-4LENPW8TBE'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** Where this copy of EgoLens is running. Attached to every event. */
export type Deployment =
  /** The canonical hosted build */
  | 'hosted'
  /** Someone's own machine — cloned repo, or self-hosted on a dev server */
  | 'local'
  /** Any other origin: a fork's Pages site, or an iframe embed's host */
  | 'other'

export function classifyDeployment(hostname: string): Deployment {
  if (LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost')) return 'local'
  if (hostname === 'egolens.org' || hostname === 'www.egolens.org') return 'hosted'
  return 'other'
}

let deployment: Deployment = 'other'

/** The deployment label for the current page, resolved once at bootstrap. */
export function getDeployment(): Deployment {
  return deployment
}

/**
 * Load gtag and configure it, unless this build opted out.
 *
 * Opt out by putting `VITE_ANALYTICS_DISABLED=true` in `.env.local`, which
 * `.gitignore` already covers via `*.local`. Do that on the maintainer's machine
 * so its dev sessions stay out of the numbers; every other clone reports as
 * `deployment: 'local'`.
 */
export function installAnalytics(): void {
  deployment = classifyDeployment(location.hostname)

  if (import.meta.env.VITE_ANALYTICS_DISABLED === 'true') return

  const tag = document.createElement('script')
  tag.async = true
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
  document.head.appendChild(tag)

  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments)
  }
  window.gtag('js', new Date())
  window.gtag('config', MEASUREMENT_ID, {
    // No cookies, no persistent identifier — see docs/ for the tradeoff this
    // buys (no consent banner) and costs (returning users are unmeasurable).
    storage: 'none',
    client_id: Math.random().toString(36).slice(2) + Date.now().toString(36),
  })
}
