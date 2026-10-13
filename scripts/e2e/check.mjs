import { ApiPromise, WsProvider } from "@polkadot/api";
for (const port of [9944, 9945, 9946]) {
  const api = await ApiPromise.create({ provider: new WsProvider(`ws://127.0.0.1:${port}`), noInitWarn: true });
  const entries = await api.query.coaliLedger.decisions.entries();
  const fin = await api.rpc.chain.getFinalizedHead();
  const h = await api.rpc.chain.getHeader(fin);
  console.log(`node :${port} decisions=${entries.length} finalized=#${h.number}`);
  await api.disconnect();
}
