// Live tests against the public testnet (network required).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ExplorerClient, TESTNET, contentHash, totalsHash } from "../dist/index.js";
import { connect, getDecision, getVote, getVotes, getSnapshot, verifySnapshot, trustReceived } from "../dist/chain.js";

const client = new ExplorerClient();
let api;
after(() => api?.disconnect());

test("explorer: stats", async () => {
  const s = await client.stats();
  assert.equal(s.token.symbol, "ZOOZ");
  assert.equal(s.token.decimals, TESTNET.decimals);
  assert.ok(s.best > 0 && s.validators.length > 0);
});

test("explorer: latest vote, its decision, and a wrong secret", async () => {
  const [ev] = await client.votes({ limit: 1 });
  assert.ok(ev, "no vote on chain");
  const v = await client.vote(ev.data.decisionId, ev.data.voter);
  assert.equal(v.commitment, ev.data.commitment);
  const d = await client.decision(ev.data.decisionId);
  assert.ok(d.votes >= 1);
  const r = await client.verifyVote({ decision: ev.data.decisionId, option: "x", salt: "wrong", voter: ev.data.voter });
  assert.equal(r.match, false);
  assert.ok(r.onChain);
  assert.equal(await client.vote(ev.data.decisionId, "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM"), null);
});

test("explorer: clear text and totals match the anchored fingerprints", async () => {
  const [s] = await client.snapshots({ limit: 1 });
  const d = await client.decision(s.data.decisionId);
  const published = d.results.filter((r) => r.totals);
  assert.ok(published.length > 0, "no totals published");
  for (const r of published) assert.equal(totalsHash(r.totals), r.totalsHash);
  assert.ok(d.content, "no content published");
  assert.equal(contentHash(d.content), d.contentHash);
});

test("chain: reads match the explorer", async () => {
  api = await connect();
  const [ev] = await client.votes({ limit: 1 });
  const v = await getVote(api, ev.data.decisionId, ev.data.voter);
  assert.equal(v.commitment, ev.data.commitment);
  const d = await getDecision(api, ev.data.decisionId);
  assert.equal(d.votes, (await getVotes(api, ev.data.decisionId)).length);
  const [tr] = await client.trusts({ limit: 1 });
  if (tr) assert.equal(typeof (await trustReceived(api, tr.data.trusted)), "number");
});

test("chain: published snapshots match the votes on chain", async () => {
  api ??= await connect();
  const snaps = await client.snapshots({ limit: 20 });
  let checked = 0;
  for (const s of snaps) {
    const seq = Number(s.data.seq);
    if (!(await getSnapshot(api, s.data.decisionId, seq))) continue;
    const r = await verifySnapshot(api, s.data.decisionId, { seq });
    assert.equal(r.computedRoot, s.data.merkleRoot, `${s.data.decisionId} #${seq}`);
    assert.ok(r.match);
    checked++;
  }
  assert.ok(checked > 0);
});
