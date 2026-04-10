import { z } from 'zod';

export const FeaturePackContentSchema = z.object({
  description: z.string(),
  architecture: z.string().optional(),
  adrs: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['accepted', 'deprecated', 'superseded']),
        context: z.string(),
        decision: z.string(),
        consequences: z.string(),
      }),
    )
    .optional(),
  constraints: z.array(z.string()).optional(),
  toolPermissions: z
    .array(
      z.object({
        tool: z.string(),
        allowed: z.boolean(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  testStrategy: z.string().optional(),
  references: z
    .array(
      z.object({
        path: z.string(),
        description: z.string().optional(),
        lastKnownHash: z.string().optional(),
      }),
    )
    .optional(),
});

export const FeaturePackSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  version: z.number().int().positive(),
  parentPackId: z.string().uuid().optional(),
  content: FeaturePackContentSchema,
  sourceFiles: z.array(z.string()).optional(),
  isActive: z.boolean(),
  isStale: z.boolean(),
  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const GetFeaturePackInputSchema = z.object({
  projectSlug: z.string().min(1).max(100).describe('The slug identifier for the project (e.g., "my-app")'),
  packSlug: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Specific pack slug to retrieve. If omitted, returns the active root pack.'),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Specific version. If omitted, returns the latest active version.'),
});

export const GetFeaturePackOutputSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  version: z.number().int(),
  resolvedContent: FeaturePackContentSchema,
  inheritanceChain: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      version: z.number().int(),
    }),
  ),
  projectId: z.string().uuid(),
  isStale: z.boolean(),
  retrievedAt: z.string().datetime(),
});

export type GetFeaturePackInput = z.infer<typeof GetFeaturePackInputSchema>;
export type GetFeaturePackOutput = z.infer<typeof GetFeaturePackOutputSchema>;
