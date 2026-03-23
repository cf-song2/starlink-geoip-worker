# Starlink GeoIP Worker

Cloudflare Worker that syncs Starlink's GeoIP feed into Zero Trust Gateway Lists (IPv4 / IPv6), running daily via cron.

## Data Source

- **Feed URL**: `https://geoip.starlinkisp.net/feed.csv`
- **Format**: headerless CSV — `CIDR,country,region,city,`
- Only the first column (CIDR) is used

## What It Does

1. Cron triggers daily at **18:00 UTC** (= KST 03:00)
2. Fetches the Starlink GeoIP CSV feed
3. Splits CIDRs into IPv4 and IPv6
4. Creates or updates two Zero Trust Gateway Lists:
   - `Starlink GeoIP - IPv4`
   - `Starlink GeoIP - IPv6`

### Update Strategy (Diff-based PATCH)

- Fetches current list items via paginated `GET /gateway/lists/{id}/items`
- Computes diff: new CIDRs to **append**, stale CIDRs to **remove**
- If no changes → **skip** (no API call)
- If changes exist → `PATCH /gateway/lists/{id}` with `{ append, remove }`
- For new lists → `POST /gateway/lists` with all items
- List IDs remain stable for gateway policy references

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Secrets are stored encrypted on Cloudflare's side via `wrangler secret put`.
They are injected into the Worker's `env` object at runtime (alongside `[vars]` from `wrangler.toml`).

```bash
# Cloudflare API Token (needs Account > Zero Trust: Edit permission)
npx wrangler secret put CF_API_TOKEN

# Your Cloudflare Account ID
npx wrangler secret put CF_ACCOUNT_ID

# Shared secret for protecting /trigger and /debug endpoints
npx wrangler secret put TRIGGER_SECRET
```

> **Note**: Secret values cannot be retrieved after creation — store them securely.

### 3. Deploy

```bash
npm run deploy
```

## HTTP Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /` | — | Worker info |
| `GET /status` | — | Current list IDs and item counts |
| `GET /trigger` | `Bearer <TRIGGER_SECRET>` | Run sync manually |
| `GET /debug` | `Bearer <TRIGGER_SECRET>` | Compare list items vs feed (diagnostics) |

### Manual trigger example

```bash
curl -H "Authorization: Bearer <TRIGGER_SECRET>" \
  https://starlink-geoip-worker.<subdomain>.workers.dev/trigger
```

## API Token Permissions

The CF API token needs:
- **Account** > **Zero Trust** > **Edit**

Or more specifically, Gateway Lists read/write permissions.

## Verification

```bash
bash script/count-feed.sh
```

Fetches the feed independently and counts unique IPv4/IPv6 CIDRs for comparison with the Worker output.

## Local Development

```bash
npm run dev
```

Then visit `http://localhost:8787/trigger` to test.
Note: `wrangler dev` does **not** fire cron triggers; use the `/trigger` HTTP endpoint instead.
