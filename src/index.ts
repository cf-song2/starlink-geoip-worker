export interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  STARLINK_FEED_URL: string;
  IPV4_LIST_NAME: string;
  IPV6_LIST_NAME: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayList {
  id: string;
  name: string;
  type: string;
  count: number;
}

interface ListItemValue {
  value: string;
}

interface CfApiResponse {
  success: boolean;
  errors: unknown[];
  result: unknown;
}

// ---------------------------------------------------------------------------
// Starlink feed fetcher & parser
// ---------------------------------------------------------------------------

async function fetchStarlinkFeed(env: Env): Promise<{ ipv4: string[]; ipv6: string[] }> {
  const response = await fetch(env.STARLINK_FEED_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Starlink feed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.trim() !== "");

  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();

  for (const line of lines) {
    const cidr = line.split(",")[0]?.trim();
    if (!cidr) continue;

    if (cidr.includes(":")) {
      ipv6.add(cidr);
    } else if (cidr.includes(".")) {
      ipv4.add(cidr);
    }
  }

  return { ipv4: [...ipv4], ipv6: [...ipv6] };
}

// ---------------------------------------------------------------------------
// Cloudflare API helpers
// ---------------------------------------------------------------------------

async function cfApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfApiResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as CfApiResponse;
  if (!json.success) {
    throw new Error(`CF API error [${method} ${path}]: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

async function getExistingLists(env: Env): Promise<GatewayList[]> {
  const json = await cfApi(env, "GET", "/gateway/lists");
  return (json.result as GatewayList[]) || [];
}

// ---------------------------------------------------------------------------
// List sync logic (preserves list ID for gateway policy references)
// ---------------------------------------------------------------------------

async function syncList(
  env: Env,
  name: string,
  description: string,
  cidrs: string[],
  existingLists: GatewayList[],
): Promise<{ id: string; count: number }> {
  const items: ListItemValue[] = cidrs.map((c) => ({ value: c }));
  const existing = existingLists.find((l: GatewayList) => l.name === name);

  if (existing) {
    // PUT with items overwrites the entire list (per CF API docs)
    console.log(`Updating existing list "${name}" (${existing.id}, currently ${existing.count} items)`);
    await cfApi(env, "PUT", `/gateway/lists/${existing.id}`, {
      name,
      description,
      items,
    });
    console.log(`Updated list "${name}" -> ${cidrs.length} items`);
    return { id: existing.id, count: cidrs.length };
  }

  // POST to create a new list with items
  console.log(`Creating new list "${name}" with ${cidrs.length} items`);
  const json = await cfApi(env, "POST", "/gateway/lists", {
    name,
    description,
    type: "IP",
    items,
  });
  const newId = (json.result as GatewayList).id;
  console.log(`Created list "${name}" -> ${newId}`);
  return { id: newId, count: cidrs.length };
}

// ---------------------------------------------------------------------------
// Main sync orchestration
// ---------------------------------------------------------------------------

async function runSync(env: Env): Promise<{ ipv4: { id: string; count: number }; ipv6: { id: string; count: number } }> {
  const { ipv4, ipv6 } = await fetchStarlinkFeed(env);
  console.log(`Fetched ${ipv4.length} IPv4 and ${ipv6.length} IPv6 CIDRs from Starlink feed`);

  const existingLists = await getExistingLists(env);

  const ipv4Result = await syncList(
    env,
    env.IPV4_LIST_NAME,
    "Starlink GeoIP IPv4 ranges – auto-synced daily from geoip.starlinkisp.net",
    ipv4,
    existingLists,
  );

  const ipv6Result = await syncList(
    env,
    env.IPV6_LIST_NAME,
    "Starlink GeoIP IPv6 ranges – auto-synced daily from geoip.starlinkisp.net",
    ipv6,
    existingLists,
  );

  return { ipv4: ipv4Result, ipv6: ipv6Result };
}

// ---------------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------------

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log("Starlink GeoIP cron sync started");
    const result = await runSync(env);
    console.log(
      `Cron sync completed – IPv4: ${result.ipv4.count} items (${result.ipv4.id}), IPv6: ${result.ipv6.count} items (${result.ipv6.id})`,
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Manual trigger
    if (url.pathname === "/trigger") {
      try {
        const result = await runSync(env);
        return Response.json({ success: true, ...result });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ success: false, error: msg }, { status: 500 });
      }
    }

    // Status check
    if (url.pathname === "/status") {
      try {
        const lists = await getExistingLists(env);
        const ipv4List = lists.find((l: GatewayList) => l.name === env.IPV4_LIST_NAME);
        const ipv6List = lists.find((l: GatewayList) => l.name === env.IPV6_LIST_NAME);
        return Response.json({
          ipv4: ipv4List ? { id: ipv4List.id, count: ipv4List.count } : null,
          ipv6: ipv6List ? { id: ipv6List.id, count: ipv6List.count } : null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    return new Response(
      [
        "Starlink GeoIP Worker",
        "",
        "Endpoints:",
        "  GET /trigger  - Run sync manually",
        "  GET /status   - Show current list info",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
};
