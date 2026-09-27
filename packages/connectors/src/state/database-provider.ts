import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import { type StateProvider, type StateClient, analyzeStateWith } from './provider.js';
import { type StateAnalysis, DEFAULT_LEGACY_HOURS, stateToEvidence } from './analyze.js';

export class DatabaseStateProvider implements StateProvider {
  readonly kind: ProviderKind = 'state';

  constructor(
    readonly id: string,
    private readonly client: StateClient & {
      health(): Promise<HealthStatus>;
      close(): Promise<void>;
    },
    private readonly opts: {
      database: string;
      collections: string[];
      staleHours: number;
    },
  ) {}

  async analyzeState(
    opts: { staleHours?: number; legacyHours?: number } = {},
  ): Promise<StateAnalysis> {
    return analyzeStateWith(
      this.client,
      {
        database: this.opts.database,
        collections: this.opts.collections,
        staleHours: opts.staleHours ?? this.opts.staleHours,
        legacyHours: opts.legacyHours ?? DEFAULT_LEGACY_HOURS,
      },
      Date.now(),
    );
  }

  toEvidence(analysis: StateAnalysis): Evidence[] {
    return stateToEvidence(
      analysis,
      `${this.id === 'mongodb' ? 'mongo' : this.id}.analyzeState`,
      new Date().toISOString(),
    );
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  async listCollections(): Promise<string[]> {
    return this.client.listCollections();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
