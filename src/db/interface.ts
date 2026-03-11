import type { DbSnapshot, DbDiff, DbConnectionConfig } from '../types/index.js';
import { PostgresVerifier } from './postgres.js';
import { MySQLVerifier } from './mysql.js';
import { MongoVerifier } from './mongo.js';

export interface IDbVerifier {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  snapshot(table: string, filter?: Record<string, unknown>): Promise<DbSnapshot>;
  diff(before: DbSnapshot, after: DbSnapshot): DbDiff;
}

export function computeDiff(
  before: DbSnapshot,
  after: DbSnapshot,
  idField = 'id',
): DbDiff {
  const beforeMap = new Map<string, Record<string, unknown>>();
  for (const row of before.rows) {
    const key = String(row[idField] ?? '');
    beforeMap.set(key, row);
  }

  const afterMap = new Map<string, Record<string, unknown>>();
  for (const row of after.rows) {
    const key = String(row[idField] ?? '');
    afterMap.set(key, row);
  }

  const inserted: Record<string, unknown>[] = [];
  const deleted: Record<string, unknown>[] = [];
  const modified: { before: Record<string, unknown>; after: Record<string, unknown> }[] = [];

  for (const [key, row] of afterMap) {
    const prev = beforeMap.get(key);
    if (!prev) {
      inserted.push(row);
    } else if (JSON.stringify(prev) !== JSON.stringify(row)) {
      modified.push({ before: prev, after: row });
    }
  }

  for (const [key, row] of beforeMap) {
    if (!afterMap.has(key)) {
      deleted.push(row);
    }
  }

  return { inserted, deleted, modified };
}

export function createDbVerifier(config: DbConnectionConfig): IDbVerifier {
  switch (config.type) {
    case 'postgres':
      return new PostgresVerifier(config.connectionString);
    case 'mysql':
      return new MySQLVerifier(config.connectionString);
    case 'mongodb':
      return new MongoVerifier(config.connectionString);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(`Unsupported database type: ${_exhaustive}`);
    }
  }
}
