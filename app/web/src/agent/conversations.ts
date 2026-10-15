// The app's index of agent conversations (D36): pi-durable has no way to list
// conversations, so their project, title, activity and archived flag live in
// a small database of our own next to the agent's ("conversations"), on the
// same native SQLite bridge (D32). It also keeps the IDE context each
// conversation was last told about, so a change is reported once.
import { BridgeSqlite } from "./sqlite";

export interface ConversationRow {
  id: number;
  /** The folder the conversation works on (its cwd), as the app addresses it. */
  project: string;
  title: string | null;
  created: number;
  /** Last activity: a message sent, a run that ended. */
  updated: number;
  /** When the user last had it on screen; unread when `updated` is later. */
  seen: number;
  archived: boolean;
  /** The IDE context the model last got (ide.ts `contextKey`). */
  ide: string | null;
}

type Raw = Omit<ConversationRow, "archived"> & { archived: number };

const row = (r: Raw): ConversationRow => ({ ...r, archived: !!r.archived });

/** Rows of `project` and of the folders inside it (conversations from before D36 work on subfolders). */
const UNDER = "(project = ? OR (? != '' AND substr(project, 1, length(?) + 1) = ? || '/'))";
const under = (project: string) => [project, project, project, project];

export class ConversationIndex {
  private constructor(private db: BridgeSqlite) {}

  static async open(): Promise<ConversationIndex> {
    const db = await BridgeSqlite.open("conversations");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        title TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        ide TEXT
      );
      CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project, updated);
    `);
    return new ConversationIndex(db);
  }

  async add(id: number, project: string, title: string | null = null, at = Date.now()) {
    await this.db.run(
      "INSERT OR IGNORE INTO conversations (id, project, title, created, updated, seen) VALUES (?, ?, ?, ?, ?, ?)",
      id, project, title, at, at, at,
    );
  }

  async get(id: number): Promise<ConversationRow | undefined> {
    const r = await this.db.get<Raw>("SELECT * FROM conversations WHERE id = ?", id);
    return r && row(r);
  }

  /** The most recent conversation of the project that is not archived. */
  async latest(project: string): Promise<ConversationRow | undefined> {
    const r = await this.db.get<Raw>(`SELECT * FROM conversations WHERE ${UNDER} AND archived = 0 ORDER BY updated DESC LIMIT 1`, ...under(project));
    return r && row(r);
  }

  /** The project's conversations (and those of folders inside it), newest first. */
  async list(project: string): Promise<ConversationRow[]> {
    return (await this.db.all<Raw>(`SELECT * FROM conversations WHERE ${UNDER} ORDER BY updated DESC LIMIT 200`, ...under(project))).map(row);
  }

  async touch(id: number, at = Date.now()) {
    await this.db.run("UPDATE conversations SET updated = ? WHERE id = ?", at, id);
  }

  async markSeen(id: number, at = Date.now()) {
    await this.db.run("UPDATE conversations SET seen = ? WHERE id = ? AND seen < updated", at, id);
  }

  async setTitle(id: number, title: string | null) {
    await this.db.run("UPDATE conversations SET title = ? WHERE id = ?", title, id);
  }

  async setArchived(id: number, archived: boolean) {
    await this.db.run("UPDATE conversations SET archived = ? WHERE id = ?", archived ? 1 : 0, id);
  }

  async setIDE(id: number, key: string | null) {
    await this.db.run("UPDATE conversations SET ide = ? WHERE id = ?", key, id);
  }

  /** A folder was renamed or moved: its conversations follow. Returns the changed rows. */
  async move(from: string, to: string): Promise<ConversationRow[]> {
    const rows = (await this.db.all<Raw>(`SELECT * FROM conversations WHERE ${UNDER}`, ...under(from))).map(row);
    for (const r of rows) {
      r.project = to + r.project.slice(from.length);
      await this.db.run("UPDATE conversations SET project = ? WHERE id = ?", r.project, r.id);
    }
    return rows;
  }
}
