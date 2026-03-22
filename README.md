# Starlink GeoIP Worker

Cloudflare Worker that syncs Starlink's GeoIP feed into Zero Trust Gateway Lists (IPv4 / IPv6), running daily via cron.

## Data Source

- **Feed URL**: `https://geoip.starlinkisp.net/feed.csv`
- **Format**: headerless CSV — `CIDR,country,region,city,`
- Only the first column (CIDR) is used

## What It Does

1. Cron triggers daily at **03:00 UTC**
2. Fetches the Starlink GeoIP CSV feed
3. Splits CIDRs into IPv4 and IPv6
4. Creates or updates two Zero Trust Gateway Lists:
   - `Starlink GeoIP - IPv4`
   - `Starlink GeoIP - IPv6`

Existing lists are updated **in-place** (PATCH) so list IDs remain stable for gateway policy references.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

```bash
# Cloudflare API Token (needs Account > Zero Trust: Edit permission)
npx wrangler secret put CF_API_TOKEN

# Your Cloudflare Account ID
npx wrangler secret put CF_ACCOUNT_ID
```

### 3. Deploy

```bash
npm run deploy
```

### 4. Manual trigger (optional)

After deploy, you can trigger a sync manually:

```
GET https://starlink-geoip-worker.<your-subdomain>.workers.dev/trigger
```

Check current list status:

```
GET https://starlink-geoip-worker.<your-subdomain>.workers.dev/status
```

## API Token Permissions

The CF API token needs:
- **Account** > **Zero Trust** > **Edit**

Or more specifically, Gateway Lists read/write permissions.

## Local Development

```bash
npm run dev
```

Then visit `http://localhost:8787/trigger` to test.
Note: `wrangler dev` does **not** fire cron triggers; use the `/trigger` HTTP endpoint instead.
