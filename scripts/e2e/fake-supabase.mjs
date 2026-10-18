// In-memory stand-in for the Popolitica Supabase REST API, limited to what the relayer uses:
// chain_outbox (GET with PostgREST filters, PATCH by id), chain_trust_addresses (upsert) and the
// RPCs board_recompute_dirty, chain_outbox_enqueue, chain_outbox_enqueue_trust,
// chain_eligible_voter_count. Used by rehearse-204.mjs; never talks to the real database.
//
// The trust RPC reproduces chain_outbox_enqueue_trust: `legacy` mode as before runtime 204
// (no key_version), otherwise as in 20261018000000_chain_security_fixes.sql.
//
// Control endpoints: POST /admin/rows (insert rows), GET /admin/rows, POST /admin/state
// ({ desired, electorate, mode }).

import http from "node:http";

export function startFakeSupabase(port) {
  const rows = [];
  const addresses = new Map();
  let nextId = 1;
  const state = { desired: [], electorate: 10, mode: "legacy" };

  const insert = (r) => {
    if (rows.some((x) => x.network === r.network && x.kind === r.kind && x.ref === r.ref)) return null;
    const row = {
      id: nextId++,
      status: "pending",
      attempts: 0,
      last_error: null,
      chain_address: null,
      tx_hash: null,
      block_hash: null,
      block_number: null,
      result: null,
      user_id: null,
      decision_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...r,
    };
    rows.push(row);
    return row;
  };

  function enqueueTrust(network) {
    const desired = new Map(state.desired.map((e) => [`${e.truster}:${e.trusted}:${e.category}`, e]));
    const history = new Map();
    for (const r of rows.filter((x) => x.network === network && x.kind === "trust")) {
      const h = history.get(r.payload.edge) ?? { n: 0 };
      history.set(r.payload.edge, { n: h.n + 1, last: r });
    }
    const todo = [];
    for (const [edge, e] of desired) {
      const h = history.get(edge);
      if (!h || (h.last.payload.action === "Revoke" && h.last.status === "confirmed")) {
        todo.push({ edge, ...e, action: "Give", key_version: state.mode === "legacy" ? undefined : 2, n: h?.n ?? 0 });
      } else if (
        state.mode !== "legacy" &&
        h.last.payload.action === "Give" &&
        h.last.status === "confirmed" &&
        Number(h.last.payload.key_version ?? 1) < 2
      ) {
        todo.push({ edge, ...e, action: "Revoke", key_version: 1, n: h.n });
      }
    }
    for (const [edge, h] of history) {
      if (h.last.payload.action === "Give" && h.last.status === "confirmed" && !desired.has(edge)) {
        const p = h.last.payload;
        todo.push({
          edge, truster: p.truster_id, trusted: p.trusted_id, category: p.category_id, action: "Revoke",
          key_version: state.mode === "legacy" ? undefined : Number(p.key_version ?? 1), n: h.n,
        });
      }
    }
    let n = 0;
    for (const t of todo) {
      const payload = { edge: t.edge, truster_id: t.truster, trusted_id: t.trusted, category_id: t.category, action: t.action };
      if (t.key_version !== undefined) payload.key_version = t.key_version;
      if (insert({ network, kind: "trust", ref: `${t.edge}:${t.n}`, user_id: t.truster, payload })) n++;
    }
    return n;
  }

  // PostgREST filters used by the relayer: eq, neq, in, lt, gte.
  function matches(row, key, expr) {
    const v = row[key];
    const [op, ...rest] = expr.split(".");
    const arg = rest.join(".");
    switch (op) {
      case "eq": return String(v) === arg;
      case "neq": return String(v) !== arg;
      case "in": return arg.replace(/^\(|\)$/g, "").split(",").includes(String(v));
      case "lt": return key === "created_at" ? v < arg : Number(v) < Number(arg);
      case "gte": return Number(v) >= Number(arg);
      default: throw new Error(`unsupported filter ${key}=${expr}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : undefined;
    const send = (code, out) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(out === undefined ? "" : JSON.stringify(out));
    };
    const path = url.pathname;
    if (path === "/admin/rows" && req.method === "POST") return send(200, (Array.isArray(data) ? data : [data]).map(insert));
    if (path === "/admin/rows") return send(200, rows);
    if (path === "/admin/addresses") return send(200, Object.fromEntries(addresses));
    if (path === "/admin/state") {
      Object.assign(state, data);
      return send(200, state);
    }
    if (path === "/rest/v1/rpc/board_recompute_dirty") return send(200, null);
    if (path === "/rest/v1/rpc/chain_outbox_enqueue") return send(200, { enabled: true, network: data.p_network });
    if (path === "/rest/v1/rpc/chain_outbox_enqueue_trust") return send(200, { enabled: true, trusts: enqueueTrust(data.p_network) });
    if (path === "/rest/v1/rpc/chain_eligible_voter_count") return send(200, state.electorate);
    if (path === "/rest/v1/chain_trust_addresses" && req.method === "POST") {
      addresses.set(`${data.user_id}:${data.network}`, data.address);
      return send(201);
    }
    if (path === "/rest/v1/chain_outbox" && req.method === "GET") {
      let out = rows.filter((r) => {
        for (const [k, v] of url.searchParams) {
          if (["select", "order", "limit"].includes(k)) continue;
          if (!matches(r, k, v)) return false;
        }
        return true;
      });
      out = out.sort((a, b) => a.id - b.id).slice(0, Number(url.searchParams.get("limit") ?? 1e9));
      return send(200, out);
    }
    if (path === "/rest/v1/chain_outbox" && req.method === "PATCH") {
      const id = Number(url.searchParams.get("id").replace("eq.", ""));
      const row = rows.find((r) => r.id === id);
      Object.assign(row, data);
      return send(204);
    }
    send(404, { error: `not handled: ${req.method} ${path}` });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, rows, state })));
}
