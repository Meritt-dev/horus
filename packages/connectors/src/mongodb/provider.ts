import { MongoStateClient } from './client.js';
import { DatabaseStateProvider } from '../state/database-provider.js';
export class MongoStateProvider extends DatabaseStateProvider {
  constructor(client: MongoStateClient, opts: { database: string; collections: string[]; staleHours: number }) {
    super('mongodb', client, opts);
  }
}
