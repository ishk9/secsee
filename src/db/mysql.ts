import mysql from 'mysql2/promise';
import type { DbSnapshot, DbDiff } from '../types/index.js';
import { computeDiff } from './interface.js';
import type { IDbVerifier } from './interface.js';

export class MySQLVerifier implements IDbVerifier {
  private connection: mysql.Connection | null = null;

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection(this.connectionString);
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  async snapshot(table: string, filter?: Record<string, unknown>): Promise<DbSnapshot> {
    if (!this.connection) {
      throw new Error('Not connected — call connect() first');
    }

    const identifier = table.replace(/[^a-zA-Z0-9_]/g, '');

    let query = `SELECT * FROM \`${identifier}\``;
    const values: (string | number | boolean | null)[] = [];

    if (filter && Object.keys(filter).length > 0) {
      const conditions = Object.entries(filter).map(([col, val]) => {
        const safeCol = col.replace(/[^a-zA-Z0-9_]/g, '');
        values.push(val as string | number | boolean | null);
        return `\`${safeCol}\` = ?`;
      });
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    const [rows] = await this.connection.execute(query, values);
    return {
      table,
      rows: rows as Record<string, unknown>[],
      timestamp: Date.now(),
    };
  }

  diff(before: DbSnapshot, after: DbSnapshot): DbDiff {
    return computeDiff(before, after, 'id');
  }
}
