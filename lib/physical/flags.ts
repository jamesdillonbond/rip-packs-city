/**
 * Physical-cards switches. Everything physical is OFF unless these are set, so
 * the prototype can merge without changing the site.
 *
 *   PHYSICAL_CARDS=1          master switch for routes/pages
 *   HCI_API_KEY               HobbyCardIndex commercial key
 *   PHYSICAL_CERT_USER_DAILY  per-user cert lookups/day (default 10)
 *   PHYSICAL_CERT_GLOBAL_DAILY  site-wide cert lookups/day (default 5 = Lite's 150/month)
 */
type Env = Record<string, string | undefined>

export function physicalEnabled(env: Env = process.env): boolean {
  return env.PHYSICAL_CARDS === "1" && !!env.HCI_API_KEY
}

export function certCaps(env: Env = process.env): { perUser: number; global: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v)
    return Number.isInteger(x) && x > 0 ? x : d
  }
  return { perUser: n(env.PHYSICAL_CERT_USER_DAILY, 10), global: n(env.PHYSICAL_CERT_GLOBAL_DAILY, 5) }
}
