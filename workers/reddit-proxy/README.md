# reddit-proxy

Cloudflare Worker that fronts `reddit.com/r/{sub}/new.json` (and a handful
of related listing endpoints) so the `ingest-external-announcements`
pipeline can reach Reddit without being IP-blocked. Vercel + Supabase
egress both hit Reddit's anonymous block; Cloudflare Worker IPs do not.

## Deploy (Trevor)

From this directory:

    wrangler login              # only needed once per machine
    wrangler secret put PROXY_SECRET   # paste the same TS_PROXY_SECRET value used by the other workers
    wrangler deploy

After deploy, the worker is reachable at
`https://reddit-proxy.tdillonbond.workers.dev`.

## Allowed paths

The worker is not a generic open relay. Only these path patterns are
forwarded verbatim:

- `GET /r/{subreddit}/new.json`
- `GET /r/{subreddit}/hot.json`
- `GET /r/{subreddit}/top.json`
- `GET /r/{subreddit}/rising.json`
- `GET /comments/{id}.json`

Anything else returns 404. Query parameters (`?limit=`, `?t=day`, etc.) are
passed through to Reddit unchanged.

## Caller pattern

Set Vercel env `REDDIT_PROXY_URL=https://reddit-proxy.tdillonbond.workers.dev`
and update `lib/announcements/reddit.ts` (or wherever the ingest lives) to
GET that URL with `X-Proxy-Secret: ${TS_PROXY_SECRET}`.

After the worker is live and one cron run has produced rows, remove the
suppression with:

    DELETE FROM pipeline_alert_suppression WHERE pipeline = 'ingest-external-announcements';
