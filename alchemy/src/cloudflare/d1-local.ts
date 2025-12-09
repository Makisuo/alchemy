import * as mf from "miniflare";
import { Scope } from "../scope.ts";
import { getDefaultPersistPath } from "./miniflare/paths.ts";

export interface D1LocalMigrationOptions {
  databaseId: string;
  migrationsTable: string;
  migrations: { id: string; sql: string }[];
}

export interface MiniflareD1Options {
  id: string;
  remoteProxyConnectionString?: mf.RemoteProxyConnectionString;
}

export async function makeMiniflareD1(database: MiniflareD1Options) {
  const miniflare = new mf.Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: getDefaultPersistPath(Scope.current.rootDir),
    d1Persist: true,
    d1Databases: {
      DB: database,
    },
    log: process.env.DEBUG ? new mf.Log(mf.LogLevel.DEBUG) : undefined,
  });
  await miniflare.ready;
  return {
    db: await miniflare.getD1Database("DB"),
    dispose: async () => {
      await miniflare.dispose();
    },
  };
}

export const applyLocalD1Migrations = async (
  options: D1LocalMigrationOptions,
) => {
  const { db, dispose } = await makeMiniflareD1({ id: options.databaseId });
  try {
    const session: any = db.withSession("first-primary");
    await session
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${options.migrationsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`,
      )
      .run();
    const appliedMigrations: {
      results: { name: string }[];
    } = await session
      .prepare(
        `SELECT name FROM ${options.migrationsTable} ORDER BY applied_at ASC`,
      )
      .all();
    const insertRecord = session.prepare(
      `INSERT INTO ${options.migrationsTable} (name) VALUES (?)`,
    );
    for (const migration of options.migrations) {
      if (appliedMigrations.results.some((m) => m.name === migration.id)) {
        continue;
      }
      // split large migrations to prevent D1_ERROR: statement too long: SQLITE_TOOBIG
      await session.batch(
        migration.sql
          .split(";")
          .flatMap((statement) =>
            statement.trim() ? session.prepare(statement) : [],
          ),
      );
      await insertRecord.bind(migration.id).run();
    }
  } finally {
    await dispose();
  }
};
