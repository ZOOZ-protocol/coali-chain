// Relayer alerts, sent by WhatsApp (SMS when WhatsApp fails) through the app's sender.
//
// - notify(text): a problem that needs a person (the chain refused a write, a check failed). Sent
//   at once, then again every 30 minutes while the same text repeats.
// - Outages: the database or the chain cannot be reached. Short cuts happen (the gateway in front of
//   the database answers 503 for a few seconds) and clear by themselves, so nothing is sent until
//   3 ticks in a row failed AND 5 minutes passed without a good tick. Once sent, a reminder goes out
//   every 30 minutes, and a message says when it works again.

export const OUTAGE_TICKS = 3;
export const OUTAGE_MS = 5 * 60_000;
export const REMIND_MS = 30 * 60_000;

const UNREACHABLE = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|disconnected|WebSocket|No response received/i;

/** True for "cannot reach the database or the chain" (marked by rest(), or a network error). */
export const isOutage = (e) => e?.outage === true || UNREACHABLE.test(String(e?.message ?? e));

const clock = (ms) =>
  new Date(ms).toLocaleTimeString("fr-FR", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });

/**
 * send(message) resolves true when the message left. now() is injectable for tests.
 */
export function createAlerts({ send, log = () => {}, now = Date.now }) {
  const notifiedAt = new Map();
  const outage = { since: null, failures: 0, lastError: "", alertedAt: null };

  async function notify(text) {
    log(`ALERT ${text}`);
    const key = String(text).slice(0, 180);
    if (now() - (notifiedAt.get(key) ?? -Infinity) < REMIND_MS) return;
    notifiedAt.set(key, now());
    const keyHint = /401|403|Invalid API key|JWT/.test(key) ? " La clé d'accès à la base a peut-être changé." : "";
    if (!(await send(`ZOOZ : l'écriture entre le serveur et la chaîne a échoué. ${text}${keyHint}`))) notifiedAt.delete(key);
  }

  async function tickFailed(e) {
    const t = now();
    outage.since ??= t;
    outage.failures += 1;
    outage.lastError = String(e?.message ?? e).slice(0, 300);
    log(`tick failed (${outage.failures} in a row): ${outage.lastError}`);
    const lasting = outage.failures >= OUTAGE_TICKS && t - outage.since >= OUTAGE_MS;
    const due = outage.alertedAt === null || t - outage.alertedAt >= REMIND_MS;
    if (!lasting || !due) return;
    const sent = await send(
      `ZOOZ : le relais n'arrive plus à joindre la base ou la chaîne depuis ${clock(outage.since)} ` +
        `(${outage.failures} tours ratés de suite). Les écritures attendent et repartiront seules. ` +
        `Dernière erreur : ${outage.lastError}`,
    );
    if (sent) outage.alertedAt = t;
  }

  async function tickSucceeded() {
    if (outage.since === null) return;
    const { since, failures, alertedAt } = outage;
    outage.since = null;
    outage.failures = 0;
    outage.lastError = "";
    outage.alertedAt = null;
    log(`back after ${failures} failed ticks`);
    if (alertedAt === null) return;
    await send(
      `ZOOZ : c'est rétabli. Le relais joint de nouveau la base et la chaîne ` +
        `(coupure depuis ${clock(since)}, ${failures} tours ratés). Les écritures en attente repartent.`,
    );
  }

  return { notify, tickFailed, tickSucceeded };
}
