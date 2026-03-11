import { MongoClient, type Db } from 'mongodb';
import type { DbSnapshot, DbDiff } from '../types/index.js';
import { computeDiff } from './interface.js';
import type { IDbVerifier } from './interface.js';

export class MongoVerifier implements IDbVerifier {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<void> {
    this.client = new MongoClient(this.connectionString);
    await this.client.connect();
    this.db = this.client.db();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async snapshot(collection: string, filter?: Record<string, unknown>): Promise<DbSnapshot> {
    if (!this.db) {
      throw new Error('Not connected — call connect() first');
    }

    const rows = await this.db
      .collection(collection)
      .find(filter ?? {})
      .toArray();

    return {
      table: collection,
      rows: rows as Record<string, unknown>[],
      timestamp: Date.now(),
    };
  }

  diff(before: DbSnapshot, after: DbSnapshot): DbDiff {
    return computeDiff(before, after, '_id');
  }
}
