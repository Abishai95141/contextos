import { defineConfig } from "drizzle-kit";

// DATABASE_URL_MIGRATE must be the DIRECT Supabase connection string
// (postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres)
// NOT the session pooler URL — DDL migrations are not safe through Supavisor.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL!,
  },
});
