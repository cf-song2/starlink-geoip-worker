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

interface GatewayListItem {
  id: string;
  value: string;
}

interface ListItemValue {
  value: string;
}

interface CfApiResponse {
  success: boolean;
  errors: unknown[];
  result: unknown;
  result_info?: { page?: number; per_page?: number; total_count?: number };
}

const BATCH_SIZE = 1000;

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

  const text = await res.text();
  let json: CfApiResponse;
  try {
    json = JSON.parse(text) as CfApiResponse;
  } catch {
    throw new Error(`CF API non-JSON response [${method} ${path}] (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!json.success) {
    throw new Error(`CF API error [${method} ${path}]: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

async function getExistingLists(env: Env): Promise<GatewayList[]> {
  const json = await cfApi(env, "GET", "/gateway/lists");
  return (json.result as GatewayList[]) || [];
}

async function getListItems(env: Env, listId: string): Promise<GatewayListItem[]> {
  const all: GatewayListItem[] = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const json = await cfApi(env, "GET", `/gateway/lists/${listId}/items?page=${page}&per_page=${perPage}`);
    const items = (json.result as GatewayListItem[][])?.flat() || [];
    all.push(...items);

    const totalCount = json.result_info?.total_count ?? 0;
    if (all.length >= totalCount || items.length === 0) break;
    page++;
  }

  return all;
}

// ---------------------------------------------------------------------------
// List sync logic (diff-based PATCH: append new, remove stale)
// ---------------------------------------------------------------------------

async function syncList(
  env: Env,
  name: string,
  description: string,
  cidrs: string[],
  existingLists: GatewayList[],
): Promise<{ id: string; count: number; added: number; removed: number }> {
  const existing = existingLists.find((l: GatewayList) => l.name === name);

  if (existing) {
    console.log(`Diffing list "${name}" (${existing.id}, currently ${existing.count} items)`);

    // Fetch current item values for diff
    const currentItems = await getListItems(env, existing.id);
    const currentSet = new Set(currentItems.map((item) => item.value));
    const newSet = new Set(cidrs);

    // Compute diff
    const toAppend: ListItemValue[] = [];
    for (const cidr of cidrs) {
      if (!currentSet.has(cidr)) {
        toAppend.push({ value: cidr });
      }
    }

    const toRemove: string[] = [];
    for (const value of currentSet) {
      if (!newSet.has(value)) {
        toRemove.push(value);
      }
    }

    console.log(`Diff: +${toAppend.length} append, -${toRemove.length} remove`);

    // Skip if nothing changed
    if (toAppend.length === 0 && toRemove.length === 0) {
      console.log(`No changes for "${name}", skipping update`);
      return { id: existing.id, count: existing.count, added: 0, removed: 0 };
    }

    // Batch PATCH: removals first, then appends
    for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
      const batch = toRemove.slice(i, i + BATCH_SIZE);
      await cfApi(env, "PATCH", `/gateway/lists/${existing.id}`, { remove: batch });
    }
    for (let i = 0; i < toAppend.length; i += BATCH_SIZE) {
      const batch = toAppend.slice(i, i + BATCH_SIZE);
      await cfApi(env, "PATCH", `/gateway/lists/${existing.id}`, { append: batch });
    }

    const finalCount = existing.count - toRemove.length + toAppend.length;
    console.log(`Updated list "${name}" -> ${finalCount} items`);
    return { id: existing.id, count: finalCount, added: toAppend.length, removed: toRemove.length };
  }

  // POST to create a new list with all items
  const items: ListItemValue[] = cidrs.map((c) => ({ value: c }));
  console.log(`Creating new list "${name}" with ${cidrs.length} items`);
  const json = await cfApi(env, "POST", "/gateway/lists", {
    name,
    description,
    type: "IP",
    items,
  });
  const newId = (json.result as GatewayList).id;
  console.log(`Created list "${name}" -> ${newId}`);
  return { id: newId, count: cidrs.length, added: cidrs.length, removed: 0 };
}

// ---------------------------------------------------------------------------
// Main sync orchestration
// ---------------------------------------------------------------------------

async function runSync(env: Env): Promise<{ ipv4: { id: string; count: number; added: number; removed: number }; ipv6: { id: string; count: number; added: number; removed: number } }> {
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
      `Cron sync completed – IPv4: ${result.ipv4.count} items (+${result.ipv4.added}/-${result.ipv4.removed}), IPv6: ${result.ipv6.count} items (+${result.ipv6.added}/-${result.ipv6.removed})`,
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

    // Debug: compare list items vs feed
    if (url.pathname === "/debug") {
      try {
        const feed = await fetchStarlinkFeed(env);
        const lists = await getExistingLists(env);
        const ipv4List = lists.find((l: GatewayList) => l.name === env.IPV4_LIST_NAME);

        let listItems: GatewayListItem[] = [];
        if (ipv4List) {
          listItems = await getListItems(env, ipv4List.id);
        }

        const listValues = listItems.slice(0, 5).map((i) => JSON.stringify(i));
        const feedValues = feed.ipv4.slice(0, 5);

        const listSet = new Set(listItems.map((i) => i.value));
        const feedSet = new Set(feed.ipv4);
        const newInFeed = feed.ipv4.filter((c) => !listSet.has(c)).slice(0, 10);
        const staleInList = [...listSet].filter((c) => !feedSet.has(c)).slice(0, 10);

        return Response.json({
          listItemCount: listItems.length,
          feedItemCount: feed.ipv4.length,
          listSample: listValues,
          feedSample: feedValues,
          newInFeed,
          staleInList,
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
        "  GET /debug    - Compare list vs feed",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
};
