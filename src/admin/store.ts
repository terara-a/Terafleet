export interface SetupState {
  status: 'idle' | 'starting' | 'awaiting_signup' | 'creating' | 'created' | 'needs_review';
  state_hash: string | null;
  admin_sub: string | null;
  expires_at: number | null;
  signup_name: string | null;
  enterprise_name: string | null;
}

export class SetupStore {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async get(): Promise<SetupState> {
    const row = await this.db.prepare('SELECT * FROM setup_state WHERE id = 1').first<SetupState>();
    if (!row) throw new Error('Setup database not initialized');
    return row;
  }

  async start(hash: string, sub: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE setup_state SET status = 'starting',
      state_hash = ?, admin_sub = ?, expires_at = ?, signup_name = NULL
      WHERE id = 1 AND (status = 'idle' OR (status = 'awaiting_signup' AND expires_at <= ?))`)
      .bind(hash, sub, now + 3600_000, now).run();
    return result.meta.changes === 1;
  }

  async awaiting(hash: string, name: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE setup_state SET status = 'awaiting_signup', signup_name = ?
      WHERE id = 1 AND status = 'starting' AND state_hash = ?`).bind(name, hash).run();
    if (result.meta.changes !== 1) throw new Error('Setup state changed');
  }

  async cancelStart(hash: string): Promise<void> {
    await this.db.prepare(`UPDATE setup_state SET status = 'idle', state_hash = NULL, admin_sub = NULL,
      expires_at = NULL, signup_name = NULL WHERE id = 1 AND status = 'starting' AND state_hash = ?`)
      .bind(hash).run();
  }

  async claim(hash: string, sub: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE setup_state SET status = 'creating'
      WHERE id = 1 AND status = 'awaiting_signup' AND state_hash = ? AND admin_sub = ? AND expires_at > ?`)
      .bind(hash, sub, now).run();
    return result.meta.changes === 1;
  }

  async complete(hash: string, enterprise: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE setup_state SET status = 'created', enterprise_name = ?,
      state_hash = NULL, admin_sub = NULL, expires_at = NULL, signup_name = NULL
      WHERE id = 1 AND status = 'creating' AND state_hash = ?`).bind(enterprise, hash).run();
    if (result.meta.changes !== 1) throw new Error('Setup state changed');
  }

  async needsReview(hash: string): Promise<void> {
    await this.db.prepare(`UPDATE setup_state SET status = 'needs_review'
      WHERE id = 1 AND status = 'creating' AND state_hash = ?`).bind(hash).run();
  }
}
