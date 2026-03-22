#!/usr/bin/env bash
set -euo pipefail

FEED_URL="https://geoip.starlinkisp.net/feed.csv"

echo "Fetching Starlink GeoIP feed..."
DATA=$(curl -sS "$FEED_URL")

TOTAL=$(echo "$DATA" | grep -c '[^[:space:]]')
IPV4=$(echo "$DATA" | cut -d',' -f1 | grep '\.' | sort -u | wc -l | tr -d ' ')
IPV6=$(echo "$DATA" | cut -d',' -f1 | grep ':' | sort -u | wc -l | tr -d ' ')

echo ""
echo "=== Starlink GeoIP Feed Count ==="
echo "Total lines : $TOTAL"
echo "IPv4 (unique): $IPV4"
echo "IPv6 (unique): $IPV6"
echo "Sum (v4+v6) : $((IPV4 + IPV6))"
echo ""
echo "Compare with Worker /trigger response:"
echo "  IPv4 count should be $IPV4"
echo "  IPv6 count should be $IPV6"
