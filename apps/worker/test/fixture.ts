// Test-only clock/snapshot/reconstruction hooks. This entry point is NEVER used by Wrangler.
import worker, { type Env } from '../src/index';
import { MancalaRoom as Room } from '../src/room';

export class MancalaRoom extends Room {
  constructor(private testContext: DurableObjectState) {
    super(testContext);
    testContext.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_clock (id INTEGER PRIMARY KEY, offset_ms INTEGER NOT NULL)');
  }
  protected override now(): number {
    const rows = this.testContext.storage.sql.exec<{ offset_ms: number }>('SELECT offset_ms FROM test_clock WHERE id = 1').toArray();
    return Date.now() + (rows[0]?.offset_ms ?? 0);
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/__advance')) {
      const { ms } = await request.json() as { ms: number };
      this.testContext.storage.sql.exec('INSERT INTO test_clock (id, offset_ms) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET offset_ms = offset_ms + excluded.offset_ms', ms);
      await this.alarm();
      return Response.json({ ok: true });
    }
    if (path.endsWith('/__snapshot')) {
      return Response.json(this.testContext.storage.sql.exec('SELECT snapshot FROM room_state WHERE id = 1').toArray());
    }
    if (path.endsWith('/__reconstruct')) {
      // Re-run the production constructor while retaining SQL and hibernation socket attachments.
      // Models heap loss; this does not claim to force workerd's automatic hibernation lifecycle.
      const recreated = new Room(this.testContext);
      await recreated.alarm();
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/api\/rooms\/(\d{6})\/__(advance|snapshot|reconstruct)$/.exec(new URL(request.url).pathname);
    if (match) return env.ROOMS.get(env.ROOMS.idFromName(match[1]!)).fetch(request);
    return worker.fetch(request, env);
  },
};
