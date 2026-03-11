import pg from 'pg';
import type { DbSnapshot, DbDiff } from '../types/index.js';
import { computeDiff } from './interface.js';
import type { IDbVerifier } from './interface.js';

export class PostgresVerifier implements IDbVerifier {
  private client: pg.Client | null = null;

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<void> {
    this.client = new pg.Client({ connectionString: this.connectionString });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  async snapshot(table: string, filter?: Record<string, unknown>): Promise<DbSnapshot> {
    if (!this.client) {
      throw new Error('Not connected — call connect() first');
    }

    const identifier = table.replace(/[^a-zA-Z0-9_]/g, '');

    let query = `SELECT * FROM "${identifier}"`;
    const values: unknown[] = [];

    if (filter && Object.keys(filter).length > 0) {
      const conditions = Object.entries(filter).map(([col, val], i) => {
        const safeCol = col.replace(/[^a-zA-Z0-9_]/g, '');
        values.push(val);
        return `"${safeCol}" = $${i + 1}`;
      });
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    const result = await this.client.query(query, values);
    return {
      table,
      rows: result.rows as Record<string, unknown>[],
      timestamp: Date.now(),
    };
  }

  diff(before: DbSnapshot, after: DbSnapshot): DbDiff {
    return computeDiff(before, after, 'id');
  }
}
