// Rebuilds the Merkle root of the latest published results of each recent decision
// from the votes on chain, and compares it with the published one.
import { ExplorerClient } from "../dist/index.js";
import { connect, verifySnapshot } from "../dist/chain.js";

const client = new ExplorerClient();
const api = await connect();
const seen = new Set();
for (const s of await client.snapshots({ limit: 50 })) {
  if (seen.has(s.data.decisionId)) continue;
  seen.add(s.data.decisionId);
  const r = await verifySnapshot(api, s.data.decisionId);
  if (!r) continue;
  const state = r.snapshot.isFinal ? "final" : "interim";
  console.log(`${r.match ? "OK  " : "FAIL"} ${s.data.decisionId} #${r.snapshot.seq} ${state}, ${r.votes.length} votes`);
}
await api.disconnect();
