// Introspect the migrated database back into a Drizzle schema (exercises the catalogs).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./pulled",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
