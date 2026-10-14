// Prints votes, trusts, decisions and results as they are finalized on chain. Ctrl+C to stop.
import { connect, watchLedger } from "../dist/chain.js";

const api = await connect();
console.log("Watching Coalichain testnet...");
await watchLedger(api, (e) => console.log(`#${e.block} ${e.method}`, JSON.stringify(e.data)));
