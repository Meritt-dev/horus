import { z } from 'zod';
export const cloudLogSchemas = {
  'azure-monitor': z.object({
    workspace: z.string().uuid(),
    subscription: z.string().min(1).optional(),
    tables: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/))
      .min(1)
      .max(10)
      .default(['AppTraces', 'AppExceptions', 'ContainerAppConsoleLogs_CL']),
    executable: z.string().default('az'),
  }),
  cloudwatch: z.object({
    region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/),
    logGroup: z.string().min(1),
    profile: z.string().min(1).optional(),
    executable: z.string().default('aws'),
  }),
  'gcp-logging': z.object({
    project: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    filter: z.string().max(2000).default(''),
    executable: z.string().default('gcloud'),
  }),
};
export type CloudLogKind = keyof typeof cloudLogSchemas;
export type CloudLogConfig = {
  [K in CloudLogKind]: z.infer<(typeof cloudLogSchemas)[K]>;
};
const names = z
  .array(z.string().regex(/^[A-Za-z0-9_.-]+$/))
  .min(1)
  .max(20);
export const runtimeSchemas = {
  prometheus: z.object({
    url: z.string().url(),
    token: z.string().optional(),
    queries: z
      .array(z.object({ title: z.string().min(1), expr: z.string().min(1).max(4000) }))
      .min(1)
      .max(20),
  }),
  'azure-service-bus': z.object({
    namespaceId: z
      .string()
      .regex(
        /^\/subscriptions\/[\w-]+\/resourceGroups\/[\w.-]+\/providers\/Microsoft.ServiceBus\/namespaces\/[\w-]+$/i,
      ),
    queues: names,
    executable: z.string().default('az'),
  }),
  kafka: z
    .object({
      brokers: z
        .array(z.string().regex(/^[\w.-]+:\d+$/))
        .min(1)
        .max(10),
      topics: names,
      groups: names,
      ssl: z.boolean().default(true),
      username: z.string().optional(),
      password: z.string().optional(),
      mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).default('plain'),
    })
    .refine(
      (c) => !!c.username === !!c.password,
      'Kafka username and password must be supplied together',
    ),
  firestore: z.object({
    project: cloudLogSchemas['gcp-logging'].shape.project,
    database: z
      .string()
      .regex(/^[\w()-]+$/)
      .default('(default)'),
    collections: z
      .array(z.string().regex(/^[\w.-]+(?:\/[\w.-]+\/[\w.-]+)*$/))
      .min(1)
      .max(20),
    executable: z.string().default('gcloud'),
  }),
  sqlserver: z.object({
    url: z.string().min(1).optional(),
    database: z.string().min(1),
    schema: z
      .string()
      .regex(/^[\w]+$/)
      .default('dbo'),
    tables: names,
  }),
};
export type RuntimeKind = keyof typeof runtimeSchemas;
export type RuntimeConfig = { [K in RuntimeKind]: z.infer<(typeof runtimeSchemas)[K]> };
