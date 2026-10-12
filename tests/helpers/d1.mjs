import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../../drizzle/", import.meta.url);
    this.sqlite.exec(readFileSync(new URL("0000_current_schema.sql", directory), "utf8"));
  }
  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async all() { return { success: true, results: statement.all(...values) }; },
      async first(column) { const row = statement.get(...values) ?? null; return column && row ? row[column] : row; },
      async run() { return { success: true, meta: { changes: Number(statement.run(...values).changes) } }; },
    };
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}

export function setupPlaylists(db, ids = ["A", "B"]) {
  db.sqlite.exec("UPDATE instance_config SET status = 'ready', account_uid = '42', binding_version = 1");
  const insert = db.sqlite.prepare(`INSERT INTO monitored_playlists
    (id, name, owner_uid, owner_name, list_order, baseline_established, bound_at)
    VALUES (?, ?, '42', 'Owner', ?, 1, '2026-10-01')`);
  ids.forEach((id, index) => insert.run(id, id, index));
}
