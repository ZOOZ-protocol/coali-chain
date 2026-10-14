// Checks a vote receipt from the Popolitica / Coali "My blockchain proofs" page.
// Usage: node examples/verify-vote.mjs <decision uuid> <option id> <secret> <voter address>
import { ExplorerClient } from "../dist/index.js";

const [decision, option, salt, voter] = process.argv.slice(2);
if (!voter) {
  console.log("usage: node examples/verify-vote.mjs <decision> <option> <secret> <voter address>");
  process.exit(1);
}

const client = new ExplorerClient();
const r = await client.verifyVote({ decision, option, salt, voter });
if (!r.onChain) console.log("No vote from this address on this decision.");
else if (r.match) console.log(`Match: this vote is on chain (block #${r.onChain.recordedAt}, ${r.onChain.kind}).`);
else console.log(`Different: the chain holds ${r.onChain.commitment}, these inputs give ${r.expected}.`);
