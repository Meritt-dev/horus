import { z } from 'zod';
import { redactSecrets } from '@horus/core';

const sensitiveField =
  /(password|secret|token|authorization|credential|api_?key|__proto__|constructor|prototype)/i;
/** Parent projections can contain secret descendants; redact names recursively. */
export function redactRecordValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactRecordValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveField.test(key) ? '[REDACTED]' : redactRecordValue(item),
      ]),
    );
  return value;
}

// Equality only, projected fields only. Never accept Mongo operators or executable queries.
export const recordFieldSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/)
  .refine((value) => !sensitiveField.test(value), 'Sensitive or unsafe field');
export const stateRecordQuerySchema = z
  .object({
    collection: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    where: z
      .array(
        z
          .object({
            field: recordFieldSchema,
            value: z.union([
              z.string().min(1).max(512),
              z.number().finite(),
              z.boolean(),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    fields: z.array(recordFieldSchema).min(1).max(30),
    limit: z.number().int().min(1).max(5).default(1),
  })
  .strict();
export type StateRecordQuery = z.infer<typeof stateRecordQuerySchema>;
