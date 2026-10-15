// pi-durable's SqliteDatabase on native SQLite through the bridge (D32).
// One connection per database lives in the host (AgentServices.swift); this
// side serializes everything, like pi-durable's Node adapter: an operation
// waits for all before it, and a transaction holds the queue until its
// callback settles. Statements inside a transaction go through its handle.
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { base64ToBytes, bytesToBase64, call } from "../host";

type Wire = null | number | string | { $bigint: string } | { $blob: string };
type Rows = { columns: string[]; rows: Wire[][] };

function encode(value: SqliteValue): Wire {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $blob: bytesToBase64(value) };
  return value;
}

function decode(value: Wire): SqliteValue {
  if (value !== null && typeof value === "object") {
    if ("$bigint" in value) return BigInt(value.$bigint);
    return base64ToBytes(value.$blob);
  }
  return value;
}

function objects<T>(result: Rows): T[] {
  return result.rows.map((row) => {
    const out: Record<string, SqliteValue> = {};
    result.columns.forEach((name, i) => (out[name] = decode(row[i])));
    return out as T;
  });
}

class Raw implements SqliteExecutor {
  constructor(protected db: string) {}

  protected op<T>(action: string, sql: string, params: SqliteValue[] = []): Promise<T> {
    return call<T>("agent.sql", { action, db: this.db, sql, params: params.map(encode) });
  }

  async exec(sql: string) {
    await this.op("exec", sql);
  }
  async run(sql: string, ...params: SqliteValue[]) {
    await this.op("run", sql, params);
  }
  async get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return objects<T>(await this.op<Rows>("get", sql, params))[0];
  }
  async all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return objects<T>(await this.op<Rows>("all", sql, params));
  }
}

class Transaction extends Raw {
  active = true;
  protected op<T>(action: string, sql: string, params: SqliteValue[] = []): Promise<T> {
    if (!this.active) return Promise.reject(new Error("SQLite transaction handle is no longer active"));
    return super.op(action, sql, params);
  }
}

export class BridgeSqlite implements SqliteDatabase {
  private raw: Raw;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private db: string) {
    this.raw = new Raw(db);
  }

  /** Opening rolls back a transaction a previous page left open. */
  static async open(db: string): Promise<BridgeSqlite> {
    await call("agent.sql", { action: "open", db });
    return new BridgeSqlite(db);
  }

  static async delete(db: string) {
    await call("agent.sql", { action: "delete", db });
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  exec(sql: string) {
    return this.queue(() => this.raw.exec(sql));
  }
  run(sql: string, ...params: SqliteValue[]) {
    return this.queue(() => this.raw.run(sql, ...params));
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.queue(() => this.raw.get<T>(sql, ...params));
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.queue(() => this.raw.all<T>(sql, ...params));
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      await this.raw.exec("BEGIN IMMEDIATE");
      const tx = new Transaction(this.db);
      try {
        const result = await callback(tx);
        tx.active = false;
        await this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        tx.active = false;
        try {
          await this.raw.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
        }
        throw error;
      }
    });
  }

  close() {
    return this.queue(() => call("agent.sql", { action: "close", db: this.db }).then(() => {}));
  }
}
