import { PostgresStateClient } from './client.js';
import { DatabaseStateProvider } from '../state/database-provider.js';
export class PostgresStateProvider extends DatabaseStateProvider {
  constructor(client: PostgresStateClient, opts: { database: string; collections: string[]; staleHours: number }) {
    super('postgres', client, opts);
  }
}
