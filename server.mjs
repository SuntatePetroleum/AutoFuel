// Local test server: runs the Worker in Node with a SQLite stand-in for D1.
// Usage: node dev/server.mjs [port] [dbfile]
import http from 'node:http';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
register('./html-loader.mjs', import.meta.url);
const { default: worker } = await import('../src/index.js');

const port = Number(process.argv[2] || 8787);
const db = new DatabaseSync(process.argv[3] || ':memory:');
db.exec('PRAGMA foreign_keys = ON');

const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
const plain = (r) => (r ? { ...r } : r);

class Stmt {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.sql, params); }
  async all() { return { results: db.prepare(this.sql).all(...norm(this.params)).map(plain), success: true, meta: {} }; }
  async first(col) {
    const r = db.prepare(this.sql).get(...norm(this.params));
    if (!r) return null;
    return col ? r[col] : plain(r);
  }
  async run() {
    const info = db.prepare(this.sql).run(...norm(this.params));
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
}
const D1 = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push({ results: db.prepare(s.sql).all(...norm(s.params)).map(plain), success: true });
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};
const env = { DB: D1 };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
  const response = await worker.fetch(request, env, {});
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`listening on http://localhost:${port}`));
