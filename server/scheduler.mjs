import { handleCronTrigger } from '../functions/modules/notifications.js';
import { cleanupAgentControl } from '../functions/services/agent-control-service.js';

const owner = `server_${crypto.randomUUID()}`;

async function acquireLease(db) {
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 90_000).toISOString();
  await db.prepare(`INSERT INTO scheduler_leases (name, owner, lease_until, updated_at)
    VALUES ('controller-cron', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until,
    updated_at = CURRENT_TIMESTAMP WHERE scheduler_leases.lease_until < ? OR scheduler_leases.owner = ?`)
    .bind(owner, leaseUntil, now, owner).run();
  const row = await db.prepare("SELECT owner FROM scheduler_leases WHERE name = 'controller-cron'").first();
  return row?.owner === owner;
}

export function startInternalScheduler(env) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (await acquireLease(env.TSUB_SQL_DB)) {
        await cleanupAgentControl({ db: env.TSUB_SQL_DB });
        await handleCronTrigger(env);
      }
    } catch (error) { console.error('[Scheduler]', error?.message || error); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(timer);
}
