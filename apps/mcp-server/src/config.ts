import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  MCP_SERVER_PORT: z.coerce.number().int().positive().default(3100),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  CLERK_SECRET_KEY: z.string().min(1, 'CLERK_SECRET_KEY is required'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NL_ASSEMBLY_URL: z.string().url().optional(),
  SEMANTIC_DIFF_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`MCP Server configuration error:\n${issues}`);
}

export const config = parsed.data;
