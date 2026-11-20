# SearXNG deployment reference (itinerary grounding)

This folder describes the self-hosted SearXNG instance used by the TripGenie itinerary grounding feature. All hostnames and secrets here are placeholders (`search.example.com`, `CHANGE_ME_...`). Never commit real values.

## Where it runs

- The SearXNG instance runs as a container on EC2, ECS or a VPS, **outside the AWS Amplify build**.
- Amplify holds only the connection settings (the base URL and the secret header name and value) and the on/off flag. It does not host or build SearXNG.
- The app reaches the instance over **HTTPS only**, with a valid certificate for the base URL hostname.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | SearXNG container (no published port) plus a Caddy proxy |
| `settings.yml` | SearXNG settings: `json` format, four engines, placeholder `secret_key` |
| `Caddyfile` | Reverse proxy that returns 403 without the correct secret header |
| `nginx.conf.sample` | Same check for nginx, if you prefer it |

## Security requirements

- The container port is **not published**. It is reachable only through the reverse proxy on the internal network. There is no unauthenticated public search.
- The proxy rejects a request with a missing or wrong secret header before it reaches the container, and returns an error with no results.
- Set a random `server.secret_key` of at least 32 characters in `settings.yml` (for example `openssl rand -hex 32`). Do not commit it.
- `search.formats` must include `json`.
- Enable at least three of DuckDuckGo, Brave, Bing and Wikipedia (the sample enables all four), so a blocked engine still leaves results from the others.

## App configuration (Amplify)

All five are server-only. None uses a `NEXT_PUBLIC_` prefix.

| Variable | Meaning |
|---|---|
| `SEARXNG_BASE_URL` | Canonical https base URL, for example `https://search.example.com`. No username or password. |
| `SEARXNG_SECRET_HEADER_NAME` | Header name the proxy checks, for example `X-TripGenie-Search-Key`. |
| `SEARXNG_SECRET_HEADER_VALUE` | Shared secret the proxy expects. |
| `TRIPGENIE_SEARXNG_ENABLED` | `true` or `1` turns grounding on. Anything else, or unset, is off. |
| `TRIPGENIE_WEB_PRICING_ENABLED` | `true` or `1` turns web-grounded activity pricing on (`/api/activity-prices` only, needs `SEARXNG_BASE_URL`). Independent of `TRIPGENIE_SEARXNG_ENABLED`. Anything else, or unset, is off. |

Both the header name and value must be set, otherwise no header is sent. On Amplify these variables are inlined at build time, so changing one needs a redeploy.

## Request contract (what the client sends)

Source of truth: `lib/providers/searxng.ts`.

- **Method:** `GET`
- **Path:** `{base}/search`
- **Query parameters:**

| Parameter | Value |
|---|---|
| `q` | the grounding query text |
| `format` | `json` |
| `language` | `en` |
| `safesearch` | `1` |
| `categories` | `general` |
| `pageno` | `1` |

- **Request headers:** `Accept: application/json`, `User-Agent: TripGenieGrounding/1.0`, and the configured secret header (name and value from env) on every request. No cookies, no body, and no traveller data or trip dates.
- **Timeout:** 2500 ms per query. All three queries run in parallel within an overall 3000 ms budget.

## Response contract (what the client reads)

From each entry of the `results` array, only these fields are read. Everything else is ignored.

- `title` (trimmed, up to 200 characters, required)
- `content` (up to 500 characters)
- `url` (must be an absolute https URL)
- `engine` (up to 50 characters)

A body without a `results` array counts as a failure. At most the first 10 valid results per query are kept.

## Redirects

The client sends `redirect: "manual"`. **Any 3xx response is refused**: the body is discarded and the whole grounding result is treated as unavailable (the itinerary is then generated without grounding). Set `SEARXNG_BASE_URL` to the canonical final URL (correct scheme, host and path, no trailing redirect such as http to https or apex to www).

## Failure behaviour

If the instance is down, slow, blocked or returns errors, itinerary generation continues without grounding. Nothing is shown to the traveller about it.

## Latency and timeouts

Worst case for one `POST /api/ai` itinerary request with grounding on:

| Step | Upper bound |
| --- | --- |
| SearXNG grounding (shared budget) | 3 s |
| Bedrock generation (`timeoutMs` 40000) | 40 s |
| Places verification (deadline) | 10 s |
| Total | about 53 s |

Configured limits in the repo: none. There is no `maxDuration` export in any route, `next.config.ts` and `amplify.yml` set no timeout, and `app/api/ai/route.ts` only exports `runtime = "nodejs"`.

Platform limit: Amplify Hosting SSR requests are reported (community reports and an `aws-amplify/amplify-hosting` issue about API route timeouts; not stated on the AWS pages we could fetch) to return 504 at about 30 s. The value is fixed by the platform. Next.js `export const maxDuration` is a Vercel convention and Amplify does not honour it, so no `maxDuration` was added. Confirm the current value in the AWS console or with AWS Support before relying on it.

Impact: the 53 s worst case exceeds 30 s, so a slow Bedrock call plus grounding and verification could be cut off by the platform with a 504 before the route replies. The Bedrock-only path (40 s) already exceeded 30 s before this feature, so grounding adds at most 3 s and verification at most 10 s to an existing exposure. The client treats a failed response as a fallback itinerary.

Mitigation options (none applied; the Bedrock timeout is unchanged):

- Lower the Bedrock `timeoutMs` to about 20 s so that 3 s + 20 s + 10 s stays under 30 s.
- Lower the Places verification deadline (for example to 4 s), or skip verification when elapsed time since the request start is above a threshold.
- Move itinerary generation to an asynchronous job (start request, then poll), which removes the request-time ceiling.
- Host the route on a runtime with a longer limit (for example a Lambda behind a function URL or ECS) if long generations are required.
