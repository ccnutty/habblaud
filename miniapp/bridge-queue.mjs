import { randomUUID } from 'node:crypto';

export class MiniAppError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

/** Requests are held in memory and dispatched at most once to the Mac. */
export function createBridgeQueue({ timeoutMs = 15_000, now = Date.now } = {}) {
  const pending = new Map();
  let lastSeen = -Infinity;

  return {
    run(operation, args = []) {
      if (now() - lastSeen > 20_000) throw new MiniAppError(503, 'mac_offline');
      if (pending.size >= 16) throw new MiniAppError(429, 'bridge_busy');
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const job = pending.get(id);
          pending.delete(id);
          const code = operation === 'sendMessage' && job.claimed ? 'delivery_unknown' : 'bridge_timeout';
          reject(new MiniAppError(504, code));
        }, timeoutMs);
        pending.set(id, { id, operation, args, resolve, reject, timer, claimed: false });
      });
    },

    claim() {
      lastSeen = now();
      const job = [...pending.values()].find((candidate) => !candidate.claimed);
      if (!job) return null;
      job.claimed = true;
      return { id: job.id, operation: job.operation, args: job.args };
    },

    complete(id, result) {
      const job = pending.get(id);
      if (!job?.claimed) return false;
      pending.delete(id);
      clearTimeout(job.timer);
      if (result?.ok === true) job.resolve(result.data);
      else {
        const status = [403, 404, 409, 429].includes(result?.status) ? result.status : 502;
        job.reject(new MiniAppError(status, status === 502 ? 'upstream_unavailable' : 'upstream_rejected'));
      }
      return true;
    },
  };
}
