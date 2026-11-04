// Sauna's own migrations folder, applied unchanged; only DATABASE_URL points somewhere else.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: process.env.MIGRATIONS ?? "/Users/robertchandler/conductor/workspaces/sauna-v1/vilnius-v1/packages/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
