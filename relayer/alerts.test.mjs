import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlerts, isOutage, OUTAGE_MS, REMIND_MS } from "./alerts.mjs";

const MIN = 60_000;

function harness({ sendOk = true } = {}) {
  let t = Date.UTC(2026, 10, 10, 17, 0);
  const sent = [];
  const alerts = createAlerts({
    send: async (m) => {
      sent.push(m);
      return typeof sendOk === "function" ? sendOk() : sendOk;
    },
    now: () => t,
  });
  return { alerts, sent, advance: (ms) => (t += ms) };
}

const outageError = () => Object.assign(new Error("POST rpc/chain_outbox_enqueue: 503"), { outage: true });

test("a short cut that clears by itself sends nothing", async () => {
  const { alerts, sent, advance } = harness();
  for (let i = 0; i < 6; i++) {
    await alerts.tickFailed(outageError());
    advance(30_000);
  }
  await alerts.tickSucceeded();
  assert.equal(sent.length, 0);
});

test("3 failures in a row are not enough before 5 minutes", async () => {
  const { alerts, sent, advance } = harness();
  for (let i = 0; i < 9; i++) {
    await alerts.tickFailed(outageError());
    advance(30_000);
  }
  assert.ok(9 * 30_000 < OUTAGE_MS);
  assert.equal(sent.length, 0);
});

test("5 minutes are not enough with fewer than 3 failures", async () => {
  const { alerts, sent, advance } = harness();
  await alerts.tickFailed(outageError());
  advance(6 * MIN);
  await alerts.tickFailed(outageError());
  assert.equal(sent.length, 0);
  advance(30_000);
  await alerts.tickFailed(outageError());
  assert.equal(sent.length, 1);
});

test("a lasting outage: one alert, a reminder after 30 minutes, then a recovery message", async () => {
  const { alerts, sent, advance } = harness();
  for (let elapsed = 0; elapsed <= OUTAGE_MS; elapsed += 30_000) {
    await alerts.tickFailed(outageError());
    advance(30_000);
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0], /n'arrive plus à joindre la base ou la chaîne depuis 19:00/);
  assert.match(sent[0], /Dernière erreur : POST rpc\/chain_outbox_enqueue: 503/);

  for (let elapsed = 0; elapsed < REMIND_MS - 2 * MIN; elapsed += 30_000) {
    await alerts.tickFailed(outageError());
    advance(30_000);
  }
  assert.equal(sent.length, 1);
  advance(3 * MIN);
  await alerts.tickFailed(outageError());
  assert.equal(sent.length, 2);

  await alerts.tickSucceeded();
  assert.equal(sent.length, 3);
  assert.match(sent[2], /c'est rétabli/);
  assert.match(sent[2], /coupure depuis 19:00/);

  await alerts.tickSucceeded();
  assert.equal(sent.length, 3);
});

test("after a recovery, a new outage starts from zero", async () => {
  const { alerts, sent, advance } = harness();
  for (let i = 0; i < 12; i++) {
    await alerts.tickFailed(outageError());
    advance(30_000);
  }
  await alerts.tickSucceeded();
  assert.equal(sent.length, 2);
  await alerts.tickFailed(outageError());
  advance(30_000);
  await alerts.tickFailed(outageError());
  await alerts.tickSucceeded();
  assert.equal(sent.length, 2);
});

test("an outage alert that could not be sent is tried again on the next failure", async () => {
  let ok = false;
  const { alerts, sent, advance } = harness({ sendOk: () => ok });
  for (let elapsed = 0; elapsed <= OUTAGE_MS; elapsed += 30_000) {
    await alerts.tickFailed(outageError());
    advance(30_000);
  }
  assert.equal(sent.length, 1);
  ok = true;
  await alerts.tickFailed(outageError());
  assert.equal(sent.length, 2);
  await alerts.tickFailed(outageError());
  assert.equal(sent.length, 2);
});

test("notify sends once per problem, again after 30 minutes, and retries a failed send", async () => {
  let ok = true;
  const { alerts, sent, advance } = harness({ sendOk: () => ok });
  await alerts.notify("écriture abandonnée : vote 1");
  await alerts.notify("écriture abandonnée : vote 1");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^ZOOZ : l'écriture entre le serveur et la chaîne a échoué\. écriture abandonnée/);
  advance(REMIND_MS);
  await alerts.notify("écriture abandonnée : vote 1");
  assert.equal(sent.length, 2);

  ok = false;
  await alerts.notify("autre problème");
  ok = true;
  await alerts.notify("autre problème");
  assert.equal(sent.length, 4);
});

test("notify hints at the database key on 401", async () => {
  const { alerts, sent } = harness();
  await alerts.notify("GET chain_outbox: 401");
  assert.match(sent[0], /La clé d'accès à la base a peut-être changé/);
});

test("isOutage", () => {
  assert.equal(isOutage(outageError()), true);
  assert.equal(isOutage(new Error("fetch failed")), true);
  assert.equal(isOutage(new Error("WebSocket is not connected")), true);
  assert.equal(isOutage(new Error("POST rpc/x: 400 bad input")), false);
  assert.equal(isOutage(new Error("coaliLedger.TooSoon")), false);
});
