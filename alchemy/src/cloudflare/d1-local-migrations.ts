import * as mf from "miniflare";
import type { D1SqlFile } from "./d1-sql-file.ts";
import { getDefaultPersistPath } from "./miniflare/paths.ts";

export interface D1LocalMigrationOptions {
  rootDir: string;
  databaseId: string;
  migrationsTable: string;
  migrations: Array<D1SqlFile>;
  imports: Array<D1SqlFile>;
}

export const applyLocalD1Migrations = async (
  options: D1LocalMigrationOptions,
) => {
  const miniflare = new mf.Miniflare({
    script: "",
    modules: true,
    defaultPersistRoot: getDefaultPersistPath(options.rootDir),
    d1Persist: true,
    d1Databases: { DB: options.databaseId },
    log: process.env.DEBUG ? new mf.Log(mf.LogLevel.DEBUG) : undefined,
  });
  try {
    await miniflare.ready;
    const db = await miniflare.getD1Database("DB");
    const session = db.withSession("first-primary");
    const tableInfo = await session
      .prepare(`PRAGMA table_info(${options.migrationsTable});`)
      .all<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>();
    if (tableInfo.results.length === 0) {
      await session
        .prepare(
          `CREATE TABLE ${options.migrationsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        type TEXT NOT NULL
    )`,
        )
        .run();
    } else if (!tableInfo.results.some((col) => col.name === "type")) {
      await session
        .prepare(
          `ALTER TABLE ${options.migrationsTable} ADD COLUMN type TEXT NOT NULL DEFAULT 'migration';`,
        )
        .run();
    }
    const applied: {
      results: { name: string; type: "migration" | "import" }[];
    } = await session
      .prepare(
        `SELECT name, type FROM ${options.migrationsTable} ORDER BY applied_at ASC`,
      )
      .all();
    const insertRecord = session.prepare(
      `INSERT INTO ${options.migrationsTable} (name, type) VALUES (?, ?)`,
    );
    for (const { id, sql } of options.migrations) {
      if (applied.results.some((m) => m.name === id)) {
        continue;
      }
      const statements = splitSqlStatements(sql).map((s) =>
        session.prepare(s),
      );
      statements.push(insertRecord.bind(id, "migration"));
      await session.batch(statements);
    }
    for (const { id, sql, hash } of options.imports) {
      const name = `${id}-${hash}`;
      if (applied.results.some((m) => m.name === name)) {
        continue;
      }
      // Split into statements to prevent D1_ERROR: statement too long: SQLITE_TOOBIG.
      const statements = splitSqlStatements(sql).map((s) =>
        session.prepare(s),
      );
      statements.push(insertRecord.bind(name, "import"));
      await session.batch(statements);
    }
  } finally {
    await miniflare.dispose();
  }
};

/**
 * Vendored from https://github.com/cloudflare/workers-sdk/blob/ae2459c6ef0dc2d5419bc692dea4a936c1859c21/packages/wrangler/src/d1/splitter.ts
 */

/**
 * Format a SQL string into a trimmed array of statements
 */
function splitSqlStatements(sql: string): string[] {
  const trimmedSql = trimSqlQuery(sql);
  if (!mayContainMultipleStatements(trimmedSql)) {
    return [trimmedSql];
  }
  const split = splitSqlIntoStatements(trimmedSql);
  if (split.length === 0) {
    return [trimmedSql];
  } else {
    return split;
  }
}

/**
 * Is the given `sql` string likely to contain multiple statements.
 *
 * If `mayContainMultipleStatements()` returns `false` you can be confident that the sql
 * does not contain multiple statements. Otherwise you have to check further.
 */
function mayContainMultipleStatements(sql: string): boolean {
  const trimmed = sql.trimEnd();
  const semiColonIndex = trimmed.indexOf(";");
  return semiColonIndex !== -1 && semiColonIndex !== trimmed.length - 1;
}

function splitSqlIntoStatements(sql: string): string[] {
  const statements: string[] = [];
  let str = "";
  const compoundStatementStack: ((s: string) => boolean)[] = [];

  const iterator = sql[Symbol.iterator]();
  let next = iterator.next();
  while (!next.done) {
    const char = next.value;

    if (compoundStatementStack[0]?.(str + char)) {
      compoundStatementStack.shift();
    }

    switch (char) {
      case `'`:
      case `"`:
      case "`":
        str += char + consumeUntilMarker(iterator, char);
        break;
      case `$`: {
        const dollarQuote =
          "$" + consumeWhile(iterator, isDollarQuoteIdentifier);
        str += dollarQuote;
        if (dollarQuote.endsWith("$")) {
          str += consumeUntilMarker(iterator, dollarQuote);
        }
        break;
      }
      case `-`:
        next = iterator.next();
        if (!next.done && next.value === "-") {
          // Skip to the end of the comment
          consumeUntilMarker(iterator, "\n");
          // Maintain the newline character
          str += "\n";
          break;
        } else {
          str += char;
          continue;
        }
      case `/`:
        next = iterator.next();
        if (!next.done && next.value === "*") {
          // Skip to the end of the comment
          consumeUntilMarker(iterator, "*/");
          break;
        } else {
          str += char;
          continue;
        }
      case `;`:
        if (compoundStatementStack.length === 0) {
          statements.push(str);
          str = "";
        } else {
          str += char;
        }
        break;
      default:
        str += char;
        break;
    }

    if (isCompoundStatementStart(str)) {
      compoundStatementStack.unshift(isCompoundStatementEnd);
    }

    next = iterator.next();
  }
  statements.push(str);

  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Pulls characters from the string iterator while the predicate remains true.
 */
function consumeWhile(
  iterator: Iterator<string>,
  predicate: (str: string) => boolean,
) {
  let next = iterator.next();
  let str = "";
  while (!next.done) {
    str += next.value;
    if (!predicate(str)) {
      break;
    }
    next = iterator.next();
  }
  return str;
}

/**
 * Pulls characters from the string iterator until the `endMarker` is found.
 */
function consumeUntilMarker(iterator: Iterator<string>, endMarker: string) {
  return consumeWhile(iterator, (str) => !str.endsWith(endMarker));
}

/**
 * Returns true if the `str` ends with a dollar-quoted string marker.
 * See https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING.
 */
function isDollarQuoteIdentifier(str: string) {
  const lastChar = str.slice(-1);
  return (
    // The $ marks the end of the identifier
    lastChar !== "$" &&
    // we allow numbers, underscore and letters with diacritical marks
    (/[0-9_]/i.test(lastChar) ||
      lastChar.toLowerCase() !== lastChar.toUpperCase())
  );
}

/**
 * Returns true if the `str` ends with a compound statement `BEGIN` or `CASE` marker.
 */
function isCompoundStatementStart(str: string) {
  return /\s(BEGIN|CASE)\s$/i.test(str);
}

/**
 * Returns true if the `str` ends with a compound statement `END` marker.
 */
function isCompoundStatementEnd(str: string) {
  return /\sEND[;\s]$/.test(str);
}

/**
 * A function to remove transaction statements from the start and end of SQL files, as the D1 API already does it for us.
 * @param sql a potentially large string of SQL statements
 * @returns the initial input, without `BEGIN TRANSACTION`/`COMMIT`
 */
function trimSqlQuery(sql: string): string {
  if (!mayContainTransaction(sql)) {
    return sql;
  }

  //note that we are intentionally not using greedy replace here, as we're targeting sqlite's dump command
  const trimmedSql = sql
    .replace("BEGIN TRANSACTION;", "")
    .replace("COMMIT;", "");
  //if the trimmed output STILL contains transactions, we should just tell them to remove them and try again.
  if (mayContainTransaction(trimmedSql)) {
    throw new Error(
      "Alchemy could not process the provided SQL file, as it contains several transactions.\nD1 runs your SQL in a transaction for you.\nPlease export an SQL file from your SQLite database and try again.",
    );
  }

  return trimmedSql;
}

// sqlite may start an sql dump file with pragmas,
// so we can't just use sql.startsWith here.
function mayContainTransaction(sql: string): boolean {
  return sql.includes("BEGIN TRANSACTION");
}
