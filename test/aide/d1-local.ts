// Base D1 simulée pour les tests : SQLite intégré à Node, mêmes migrations que la production.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1PreparedStatement, D1Result } from "../../src/types.ts";

type Valeur = string | number | bigint | null | Uint8Array;

class Requete implements D1PreparedStatement {
  private valeurs: Valeur[] = [];
  private readonly db: DatabaseSync;
  readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...values: unknown[]): D1PreparedStatement {
    const r = new Requete(this.db, this.sql);
    r.valeurs = values.map((v) => {
      if (v === undefined) throw new Error(`Valeur undefined liée dans : ${this.sql}`);
      if (typeof v === "boolean") return v ? 1 : 0;
      return v as Valeur;
    });
    return r;
  }
  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.valeurs);
    return (row ? { ...row } : null) as T | null;
  }
  async all<T>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.valeurs);
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run(): Promise<D1Result> {
    return this.executer();
  }
  executer(): D1Result {
    const r = this.db.prepare(this.sql).run(...this.valeurs);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
}

export function creerD1(): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const dossier = join(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dossier).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dossier, f), "utf8"));
  }
  return {
    sqlite: db,
    prepare: (sql: string) => new Requete(db, sql),
    // Comme D1 : le lot est atomique, tout ou rien.
    async batch(statements: D1PreparedStatement[]) {
      db.exec("BEGIN");
      try {
        const res = statements.map((s) => (s as Requete).executer());
        db.exec("COMMIT");
        return res;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
