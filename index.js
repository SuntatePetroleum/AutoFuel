// Fuel Scheduler — Cloudflare Worker + D1.
// Serves the single-page app and a JSON API. Every record belongs to one company,
// and every query is filtered by the signed-in user's company.

import UI_HTML from './ui.html';

/* ------------------------------------------------------------------ schema */

// Each entry is one schema version. New versions are appended, never edited,
// so a deployed database upgrades itself on the next request.
const MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','dispatcher','driver')),
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS login_failures (
      email TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(email, at)`,
    `CREATE TABLE IF NOT EXISTS settings (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      safe_fill_pct REAL NOT NULL DEFAULT 0.95,
      floor_days REAL NOT NULL DEFAULT 1,
      floor_min_pct REAL NOT NULL DEFAULT 0.05,
      overfill_margin_l INTEGER NOT NULL DEFAULT 500,
      runout_buffer_h REAL NOT NULL DEFAULT 12,
      min_drop_l INTEGER NOT NULL DEFAULT 5000,
      lookback_weeks INTEGER NOT NULL DEFAULT 8,
      whole_compartments INTEGER NOT NULL DEFAULT 1,
      holiday_region TEXT NOT NULL DEFAULT 'QLD',
      timezone TEXT NOT NULL DEFAULT 'Australia/Brisbane'
    )`,
    `CREATE TABLE IF NOT EXISTS grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      density REAL,
      colour TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (company_id, code)
    )`,
    `CREATE TABLE IF NOT EXISTS terminals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT,
      lat REAL,
      lng REAL,
      open_from TEXT,
      open_until TEXT,
      grades TEXT,
      load_minutes INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (company_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT,
      trading_name TEXT,
      address TEXT,
      postcode TEXT,
      lat REAL,
      lng REAL,
      external_id TEXT,
      delivery_from TEXT,
      delivery_until TEXT,
      max_combination TEXT,
      drop_minutes INTEGER,
      contact_name TEXT,
      contact_phone TEXT,
      sales_code TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (company_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      grade_id INTEGER NOT NULL REFERENCES grades(id),
      name TEXT NOT NULL,
      tank_number TEXT,
      capacity_l INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      calibration_on_file INTEGER,
      notes TEXT,
      UNIQUE (site_id, name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tanks_company ON tanks(company_id)`,
    `CREATE TABLE IF NOT EXISTS trucks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rego TEXT,
      depot TEXT,
      combination_class TEXT,
      max_payload_t REAL,
      available INTEGER NOT NULL DEFAULT 1,
      UNIQUE (company_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      truck_id INTEGER NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      capacity_l INTEGER NOT NULL,
      UNIQUE (truck_id, position)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_compartments_company ON compartments(company_id)`,
    `CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mobile TEXT,
      licence_class TEXT,
      dg_expiry TEXT,
      combinations TEXT,
      usual_shift TEXT,
      max_hours REAL,
      active INTEGER NOT NULL DEFAULT 1
    )`,
  ],
  // v2: tank dips, recorded in litres.
  [
    `CREATE TABLE IF NOT EXISTS dips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      tank_id INTEGER NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
      litres REAL NOT NULL,
      taken_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tank_id, taken_at)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dips_company_time ON dips(company_id, taken_at)`,
    `ALTER TABLE settings ADD COLUMN dip_stale_hours REAL NOT NULL DEFAULT 36`,
  ],
];

let schemaVersionSeen = 0;

async function ensureSchema(env) {
  if (schemaVersionSeen === MIGRATIONS.length) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)').run();
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const statements = MIGRATIONS[version].map((sql) => env.DB.prepare(sql));
    statements.push(
      env.DB.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(String(version + 1))
    );
    await env.DB.batch(statements);
    version += 1;
  }
  schemaVersionSeen = version;
}

/* ------------------------------------------------------------- utilities */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Send the request as JSON.');
  const text = await request.text();
  if (text.length > 2_000_000) throw new HttpError(413, 'That request is too large.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  // 100,000 is the most PBKDF2 iterations Workers allows.
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key,
    256
  );
  return { hash: b64(new Uint8Array(bits)), salt: b64(salt) };
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SESSION_COOKIE = 'fs_session';
const SESSION_DAYS = 30;

function sessionCookie(request, token, maxAge) {
  const url = new URL(request.url);
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${local ? '' : '; Secure'}`;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/* ----------------------------------------------------------- validation */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Turns one incoming value into what the database stores, or throws a readable error.
function coerce(field, spec, raw) {
  const label = spec.label || field;
  if (raw === undefined) return undefined;
  const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (blank) {
    if (spec.required) throw new HttpError(400, `${label} is required.`);
    return null;
  }
  switch (spec.type) {
    case 'text': {
      const v = String(raw).trim();
      if (v.length > (spec.max || 200)) throw new HttpError(400, `${label} is too long.`);
      if (spec.options && !spec.options.includes(v)) {
        throw new HttpError(400, `${label} must be one of: ${spec.options.join(', ')}.`);
      }
      return v;
    }
    case 'int':
    case 'num': {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new HttpError(400, `${label} must be a number.`);
      if (spec.type === 'int' && !Number.isInteger(v)) throw new HttpError(400, `${label} must be a whole number.`);
      if (spec.min !== undefined && v < spec.min) throw new HttpError(400, `${label} must be at least ${spec.min}.`);
      if (spec.max !== undefined && v > spec.max) throw new HttpError(400, `${label} must be at most ${spec.max}.`);
      return v;
    }
    case 'bool': {
      const v = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
      if (v === true || v === 1 || ['1', 'true', 'yes', 'y'].includes(v)) return 1;
      if (v === false || v === 0 || ['0', 'false', 'no', 'n'].includes(v)) return 0;
      throw new HttpError(400, `${label} must be yes or no.`);
    }
    case 'time': {
      const v = String(raw).trim();
      if (!TIME_RE.test(v)) throw new HttpError(400, `${label} must be a time like 05:30.`);
      return v;
    }
    case 'date': {
      const v = String(raw).trim();
      if (!DATE_RE.test(v)) throw new HttpError(400, `${label} must be a date like 2027-03-14.`);
      return v;
    }
    case 'ref': {
      const v = Number(raw);
      if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, `${label} is not valid.`);
      return v;
    }
    default:
      throw new Error(`Unknown field type ${spec.type}`);
  }
}

/* ------------------------------------------------------------- entities */

const COMBINATIONS = ['Any', 'Rigid', 'Semi', 'B-double', 'Road train'];
const TRUCK_CLASSES = ['Rigid', 'Semi', 'B-double', 'Road train'];

const ENTITIES = {
  grades: {
    table: 'grades',
    noun: 'grade',
    fields: {
      code: { type: 'text', required: true, max: 20, label: 'Code' },
      name: { type: 'text', required: true, label: 'Name' },
      density: { type: 'num', min: 0.5, max: 1.2, label: 'Density' },
      colour: { type: 'text', max: 20, label: 'Colour' },
      sort_order: { type: 'int', min: 0, max: 999, label: 'Order' },
    },
    list: `SELECT g.*, (SELECT COUNT(*) FROM tanks t WHERE t.grade_id = g.id) AS tank_count
           FROM grades g WHERE g.company_id = ? ORDER BY g.sort_order, g.code`,
    async beforeDelete(env, companyId, id) {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM tanks WHERE grade_id = ? AND company_id = ?')
        .bind(id, companyId)
        .first();
      if (row.n > 0) throw new HttpError(409, `This grade is used by ${row.n} tank${row.n === 1 ? '' : 's'}. Change or delete those tanks first.`);
    },
  },
  terminals: {
    table: 'terminals',
    noun: 'terminal',
    fields: {
      name: { type: 'text', required: true, label: 'Name' },
      address: { type: 'text', label: 'Address' },
      lat: { type: 'num', min: -90, max: 90, label: 'Latitude' },
      lng: { type: 'num', min: -180, max: 180, label: 'Longitude' },
      open_from: { type: 'time', label: 'Open from' },
      open_until: { type: 'time', label: 'Open until' },
      grades: { type: 'text', max: 200, label: 'Grades available' },
      load_minutes: { type: 'int', min: 0, max: 600, label: 'Average load time' },
      active: { type: 'bool', label: 'Active' },
    },
    list: 'SELECT * FROM terminals WHERE company_id = ? ORDER BY name',
  },
  sites: {
    table: 'sites',
    noun: 'site',
    fields: {
      name: { type: 'text', required: true, label: 'Site name' },
      code: { type: 'text', max: 40, label: 'Site code' },
      trading_name: { type: 'text', label: 'Trading name' },
      address: { type: 'text', label: 'Address' },
      postcode: { type: 'text', max: 10, label: 'Postcode' },
      lat: { type: 'num', min: -90, max: 90, label: 'Latitude' },
      lng: { type: 'num', min: -180, max: 180, label: 'Longitude' },
      external_id: { type: 'text', max: 40, label: 'Price board site ID' },
      delivery_from: { type: 'time', label: 'Deliveries from' },
      delivery_until: { type: 'time', label: 'Deliveries until' },
      max_combination: { type: 'text', options: COMBINATIONS, label: 'Largest combination allowed' },
      drop_minutes: { type: 'int', min: 0, max: 600, label: 'Average drop time' },
      contact_name: { type: 'text', label: 'Site contact' },
      contact_phone: { type: 'text', max: 40, label: 'Contact phone' },
      sales_code: { type: 'text', max: 40, label: 'Sales code' },
      active: { type: 'bool', label: 'Active' },
    },
    list: `SELECT s.*, COUNT(t.id) AS tank_count, COALESCE(SUM(t.capacity_l), 0) AS total_capacity_l
           FROM sites s LEFT JOIN tanks t ON t.site_id = s.id
           WHERE s.company_id = ? GROUP BY s.id ORDER BY s.name`,
  },
  tanks: {
    table: 'tanks',
    noun: 'tank',
    fields: {
      site_id: { type: 'ref', required: true, ref: 'sites', label: 'Site' },
      grade_id: { type: 'ref', required: true, ref: 'grades', label: 'Grade' },
      name: { type: 'text', required: true, label: 'Tank name' },
      tank_number: { type: 'text', max: 20, label: 'Tank number' },
      capacity_l: { type: 'int', required: true, min: 1, max: 1_000_000, label: 'Capacity' },
      active: { type: 'bool', label: 'Active' },
      calibration_on_file: { type: 'bool', label: 'Calibration chart on file' },
      notes: { type: 'text', max: 500, label: 'Notes' },
    },
    list: `SELECT t.*, s.name AS site_name, g.code AS grade_code, g.name AS grade_name
           FROM tanks t JOIN sites s ON s.id = t.site_id JOIN grades g ON g.id = t.grade_id
           WHERE t.company_id = ? ORDER BY s.name, g.sort_order, t.name`,
  },
  trucks: {
    table: 'trucks',
    noun: 'truck',
    fields: {
      name: { type: 'text', required: true, label: 'Truck name' },
      rego: { type: 'text', max: 20, label: 'Rego' },
      depot: { type: 'text', label: 'Home depot' },
      combination_class: { type: 'text', options: TRUCK_CLASSES, label: 'Combination class' },
      max_payload_t: { type: 'num', min: 0, max: 200, label: 'Maximum payload' },
      available: { type: 'bool', label: 'Available' },
    },
    list: 'SELECT * FROM trucks WHERE company_id = ? ORDER BY name',
    async decorate(env, companyId, rows) {
      const { results } = await env.DB.prepare(
        'SELECT truck_id, position, capacity_l FROM compartments WHERE company_id = ? ORDER BY truck_id, position'
      )
        .bind(companyId)
        .all();
      const byTruck = new Map();
      for (const c of results) {
        if (!byTruck.has(c.truck_id)) byTruck.set(c.truck_id, []);
        byTruck.get(c.truck_id).push(c.capacity_l);
      }
      for (const r of rows) {
        r.compartments = byTruck.get(r.id) || [];
        r.total_capacity_l = r.compartments.reduce((a, b) => a + b, 0);
      }
      return rows;
    },
    // Compartments are saved with their truck, as a list of litres in position order.
    async afterSave(env, companyId, id, body) {
      if (!Array.isArray(body.compartments)) return;
      if (body.compartments.length > 20) throw new HttpError(400, 'A truck can have at most 20 compartments.');
      const caps = body.compartments.map((v, i) => coerce('compartment', {
        type: 'int', required: true, min: 1, max: 60000, label: `Compartment ${i + 1}`,
      }, v));
      const stmts = [env.DB.prepare('DELETE FROM compartments WHERE truck_id = ? AND company_id = ?').bind(id, companyId)];
      caps.forEach((cap, i) => {
        stmts.push(
          env.DB.prepare('INSERT INTO compartments (company_id, truck_id, position, capacity_l) VALUES (?, ?, ?, ?)')
            .bind(companyId, id, i + 1, cap)
        );
      });
      await env.DB.batch(stmts);
    },
  },
  drivers: {
    table: 'drivers',
    noun: 'driver',
    fields: {
      name: { type: 'text', required: true, label: 'Name' },
      mobile: { type: 'text', max: 40, label: 'Mobile' },
      licence_class: { type: 'text', max: 10, label: 'Licence class' },
      dg_expiry: { type: 'date', label: 'Dangerous goods licence expiry' },
      combinations: { type: 'text', label: 'Combinations cleared for' },
      usual_shift: { type: 'text', label: 'Usual shift' },
      max_hours: { type: 'num', min: 0, max: 24, label: 'Maximum work hours per shift' },
      active: { type: 'bool', label: 'Active' },
    },
    list: 'SELECT * FROM drivers WHERE company_id = ? ORDER BY name',
  },
};

function friendlyDbError(err, entity) {
  const msg = String(err && err.message);
  if (msg.includes('UNIQUE constraint failed')) {
    if (entity === 'tanks') return new HttpError(409, 'That site already has a tank with this name.');
    if (entity === 'grades') return new HttpError(409, 'A grade with this code already exists.');
    return new HttpError(409, `A ${ENTITIES[entity].noun} with this name already exists.`);
  }
  return err;
}

async function checkRefs(env, companyId, def, values) {
  for (const [field, spec] of Object.entries(def.fields)) {
    if (spec.type !== 'ref' || values[field] == null) continue;
    const row = await env.DB.prepare(`SELECT id FROM ${spec.ref} WHERE id = ? AND company_id = ?`)
      .bind(values[field], companyId)
      .first();
    if (!row) throw new HttpError(400, `${spec.label} was not found.`);
  }
}

function pickValues(def, body, { creating }) {
  const values = {};
  for (const [field, spec] of Object.entries(def.fields)) {
    const v = coerce(field, spec, body[field]);
    if (v !== undefined) values[field] = v;
    else if (creating && spec.required) throw new HttpError(400, `${spec.label} is required.`);
  }
  return values;
}

async function listEntity(env, companyId, name) {
  const def = ENTITIES[name];
  const { results } = await env.DB.prepare(def.list).bind(companyId).all();
  return def.decorate ? def.decorate(env, companyId, results) : results;
}

async function getEntity(env, companyId, name, id) {
  const rows = await listEntity(env, companyId, name);
  return rows.find((r) => r.id === id) || null;
}

async function createEntity(env, companyId, name, body) {
  const def = ENTITIES[name];
  const values = pickValues(def, body, { creating: true });
  await checkRefs(env, companyId, def, values);
  const cols = Object.keys(values);
  const sql = `INSERT INTO ${def.table} (company_id${cols.map((c) => ', ' + c).join('')})
               VALUES (?${cols.map(() => ', ?').join('')}) RETURNING id`;
  let row;
  try {
    row = await env.DB.prepare(sql).bind(companyId, ...cols.map((c) => values[c])).first();
  } catch (err) {
    throw friendlyDbError(err, name);
  }
  if (def.afterSave) await def.afterSave(env, companyId, row.id, body);
  return getEntity(env, companyId, name, row.id);
}

async function updateEntity(env, companyId, name, id, body) {
  const def = ENTITIES[name];
  const values = pickValues(def, body, { creating: false });
  await checkRefs(env, companyId, def, values);
  const exists = await env.DB.prepare(`SELECT id FROM ${def.table} WHERE id = ? AND company_id = ?`).bind(id, companyId).first();
  if (!exists) throw new HttpError(404, `That ${def.noun} was not found.`);
  const cols = Object.keys(values);
  if (cols.length) {
    const sql = `UPDATE ${def.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND company_id = ?`;
    try {
      await env.DB.prepare(sql).bind(...cols.map((c) => values[c]), id, companyId).run();
    } catch (err) {
      throw friendlyDbError(err, name);
    }
  }
  if (def.afterSave) await def.afterSave(env, companyId, id, body);
  return getEntity(env, companyId, name, id);
}

async function deleteEntity(env, companyId, name, id) {
  const def = ENTITIES[name];
  const exists = await env.DB.prepare(`SELECT id FROM ${def.table} WHERE id = ? AND company_id = ?`).bind(id, companyId).first();
  if (!exists) throw new HttpError(404, `That ${def.noun} was not found.`);
  if (def.beforeDelete) await def.beforeDelete(env, companyId, id);
  // Child rows go too: a site's tanks, a truck's compartments.
  const stmts = [];
  if (name === 'sites') stmts.push(env.DB.prepare('DELETE FROM tanks WHERE site_id = ? AND company_id = ?').bind(id, companyId));
  if (name === 'trucks') stmts.push(env.DB.prepare('DELETE FROM compartments WHERE truck_id = ? AND company_id = ?').bind(id, companyId));
  stmts.push(env.DB.prepare(`DELETE FROM ${def.table} WHERE id = ? AND company_id = ?`).bind(id, companyId));
  await env.DB.batch(stmts);
}

/* -------------------------------------------------------------- settings */

const SETTINGS_FIELDS = {
  safe_fill_pct: { type: 'num', min: 0.5, max: 1, label: 'Safe fill limit' },
  floor_days: { type: 'num', min: 0, max: 14, label: 'Safety floor (days of sales)' },
  floor_min_pct: { type: 'num', min: 0, max: 0.5, label: 'Safety floor minimum' },
  overfill_margin_l: { type: 'int', min: 0, max: 20000, label: 'Overfill margin' },
  runout_buffer_h: { type: 'num', min: 0, max: 168, label: 'Run-out buffer' },
  min_drop_l: { type: 'int', min: 0, max: 100000, label: 'Minimum worthwhile drop' },
  lookback_weeks: { type: 'int', min: 1, max: 52, label: 'Forecast lookback' },
  whole_compartments: { type: 'bool', label: 'Whole compartments only' },
  holiday_region: { type: 'text', options: ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA', 'None'], label: 'Public holiday calendar' },
  timezone: { type: 'text', max: 60, label: 'Time zone' },
  dip_stale_hours: { type: 'num', min: 1, max: 720, label: 'Dip out of date after' },
};

async function getSettings(env, companyId) {
  let row = await env.DB.prepare('SELECT * FROM settings WHERE company_id = ?').bind(companyId).first();
  if (!row) {
    await env.DB.prepare('INSERT INTO settings (company_id) VALUES (?)').bind(companyId).run();
    row = await env.DB.prepare('SELECT * FROM settings WHERE company_id = ?').bind(companyId).first();
  }
  return row;
}

async function updateSettings(env, companyId, body) {
  await getSettings(env, companyId);
  const values = {};
  for (const [field, spec] of Object.entries(SETTINGS_FIELDS)) {
    const v = coerce(field, { ...spec, required: true }, body[field]);
    if (v !== undefined) values[field] = v;
  }
  if (values.timezone) {
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: values.timezone });
    } catch {
      throw new HttpError(400, 'Time zone is not recognised. Use a name like Australia/Brisbane.');
    }
  }
  const cols = Object.keys(values);
  if (cols.length) {
    await env.DB.prepare(`UPDATE settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE company_id = ?`)
      .bind(...cols.map((c) => values[c]), companyId)
      .run();
  }
  return getSettings(env, companyId);
}

/* ------------------------------------------------------------------ auth */

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT u.id, u.company_id, u.email, u.name, u.role, c.name AS company_name
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN companies c ON c.id = u.company_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(tokenHash, Date.now())
    .first();
}

async function startSession(request, env, userId) {
  const token = newToken();
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), userId, Date.now() + maxAge * 1000),
  ]);
  return sessionCookie(request, token, maxAge);
}

function cleanEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function cleanPassword(raw) {
  const pw = String(raw || '');
  if (pw.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (pw.length > 200) throw new HttpError(400, 'That password is too long.');
  return pw;
}

const DEFAULT_GRADES = [
  ['ULP91', 'Unleaded 91', 0.74, 1],
  ['E10', 'E10', 0.75, 2],
  ['ULP95', 'Premium unleaded 95', 0.75, 3],
  ['ULP98', 'Premium unleaded 98', 0.75, 4],
  ['DSL', 'Diesel', 0.835, 5],
  ['PDSL', 'Premium diesel', 0.835, 6],
];

async function firstRunSetup(request, env) {
  const body = await readJson(request);
  const companyName = coerce('company', { type: 'text', required: true, label: 'Company name' }, body.company_name);
  const name = coerce('name', { type: 'text', required: true, label: 'Your name' }, body.name);
  const email = cleanEmail(body.email);
  const password = cleanPassword(body.password);
  const { hash, salt } = await hashPassword(password);

  // Only allowed while the app has no users at all.
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (existing.n > 0) throw new HttpError(403, 'This app is already set up. Sign in instead.');

  const company = await env.DB.prepare('INSERT INTO companies (name) VALUES (?) RETURNING id').bind(companyName).first();
  const stmts = [
    env.DB.prepare('INSERT INTO settings (company_id) VALUES (?)').bind(company.id),
    ...DEFAULT_GRADES.map(([code, gname, density, order]) =>
      env.DB.prepare('INSERT INTO grades (company_id, code, name, density, sort_order) VALUES (?, ?, ?, ?, ?)')
        .bind(company.id, code, gname, density, order)
    ),
  ];
  await env.DB.batch(stmts);
  const user = await env.DB.prepare(
    "INSERT INTO users (company_id, email, name, role, pass_hash, pass_salt) VALUES (?, ?, ?, 'admin', ?, ?) RETURNING id"
  )
    .bind(company.id, email, name, hash, salt)
    .first();
  const cookie = await startSession(request, env, user.id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function login(request, env) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?')
    .bind(email, now - 15 * 60 * 1000)
    .first();
  if (recent.n >= 10) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');

  const user = await env.DB.prepare('SELECT id, pass_hash, pass_salt FROM users WHERE email = ?').bind(email).first();
  const check = await hashPassword(password, user ? user.pass_salt : b64(new Uint8Array(16)));
  if (!user || !sameString(check.hash, user.pass_hash)) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - 60 * 60 * 1000),
      env.DB.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, now),
    ]);
    throw new HttpError(401, 'That email and password don’t match.');
  }
  const cookie = await startSession(request, env, user.id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
}

async function changeOwnPassword(request, env, user) {
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').bind(user.id).first();
  const check = await hashPassword(String(body.current_password || ''), row.pass_salt);
  if (!sameString(check.hash, row.pass_hash)) throw new HttpError(400, 'Your current password is not right.');
  const { hash, salt } = await hashPassword(cleanPassword(body.new_password));
  await env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, user.id).run();
  return json({ ok: true });
}

/* ----------------------------------------------------------------- users */

const ROLES = ['admin', 'dispatcher', 'driver'];

async function listUsers(env, companyId) {
  const { results } = await env.DB.prepare(
    'SELECT id, email, name, role, created_at FROM users WHERE company_id = ? ORDER BY name'
  )
    .bind(companyId)
    .all();
  return results;
}

async function createUser(request, env, me) {
  const body = await readJson(request);
  const name = coerce('name', { type: 'text', required: true, label: 'Name' }, body.name);
  const role = coerce('role', { type: 'text', required: true, options: ROLES, label: 'Role' }, body.role);
  const email = cleanEmail(body.email);
  const { hash, salt } = await hashPassword(cleanPassword(body.password));
  try {
    await env.DB.prepare('INSERT INTO users (company_id, email, name, role, pass_hash, pass_salt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(me.company_id, email, name, role, hash, salt)
      .run();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Someone already uses that email address.');
    throw err;
  }
  return json(await listUsers(env, me.company_id));
}

async function updateUser(request, env, me, id) {
  const body = await readJson(request);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND company_id = ?').bind(id, me.company_id).first();
  if (!target) throw new HttpError(404, 'That user was not found.');
  const updates = {};
  if (body.name !== undefined) updates.name = coerce('name', { type: 'text', required: true, label: 'Name' }, body.name);
  if (body.role !== undefined) {
    updates.role = coerce('role', { type: 'text', required: true, options: ROLES, label: 'Role' }, body.role);
    if (id === me.id && updates.role !== 'admin') throw new HttpError(400, 'You can’t remove your own admin access.');
  }
  if (body.password) {
    const { hash, salt } = await hashPassword(cleanPassword(body.password));
    updates.pass_hash = hash;
    updates.pass_salt = salt;
  }
  const cols = Object.keys(updates);
  if (cols.length) {
    await env.DB.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND company_id = ?`)
      .bind(...cols.map((c) => updates[c]), id, me.company_id)
      .run();
  }
  if (updates.pass_hash && id !== me.id) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  return json(await listUsers(env, me.company_id));
}

async function deleteUser(env, me, id) {
  if (id === me.id) throw new HttpError(400, 'You can’t delete your own account.');
  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').bind(id, me.company_id).first();
  if (!target) throw new HttpError(404, 'That user was not found.');
  await env.DB.prepare('DELETE FROM users WHERE id = ? AND company_id = ?').bind(id, me.company_id).run();
  return json(await listUsers(env, me.company_id));
}

/* ---------------------------------------------------------------- import */

// Loads grades, sites, tanks, trucks and compartments from the setup spreadsheet
// (parsed in the browser). Rows are matched by name; blank cells leave existing
// values alone. Everything is checked first, then written in one transaction.
async function importSetup(request, env, me) {
  const body = await readJson(request);
  const cid = me.company_id;
  const errors = [];
  const rowsOf = (key) => (Array.isArray(body[key]) ? body[key] : []);

  const grabExisting = async (sql) => (await env.DB.prepare(sql).bind(cid).all()).results;
  const existingGrades = new Set((await grabExisting('SELECT code FROM grades WHERE company_id = ?')).map((r) => r.code));
  const existingSites = new Set((await grabExisting('SELECT name FROM sites WHERE company_id = ?')).map((r) => r.name));
  const existingTrucks = new Set((await grabExisting('SELECT name FROM trucks WHERE company_id = ?')).map((r) => r.name));
  const existingTanks = new Set(
    (await grabExisting('SELECT s.name AS site, t.name AS tank FROM tanks t JOIN sites s ON s.id = t.site_id WHERE t.company_id = ?'))
      .map((r) => `${r.site}\u0000${r.tank}`)
  );

  // Validate one sheet's rows against an entity's field rules.
  const clean = (sheet, rows, fields, keyField) => {
    const out = [];
    const seen = new Set();
    rows.forEach((raw, i) => {
      const where = `${sheet} row ${raw._row || i + 2}`;
      try {
        const values = {};
        for (const [field, spec] of Object.entries(fields)) {
          if (!(field in raw)) continue;
          const v = coerce(field, spec, raw[field]);
          if (v !== null && v !== undefined) values[field] = v;
        }
        for (const [field, spec] of Object.entries(fields)) {
          if (spec.required && values[field] === undefined) throw new HttpError(400, `${spec.label} is required.`);
        }
        const key = typeof keyField === 'function' ? keyField(values) : values[keyField];
        if (seen.has(key)) throw new HttpError(400, 'This row appears twice.');
        seen.add(key);
        out.push(values);
      } catch (err) {
        errors.push(`${where}: ${err.message}`);
      }
    });
    return out;
  };

  const gradeFields = { ...ENTITIES.grades.fields };
  const siteFields = { ...ENTITIES.sites.fields };
  const truckFields = { ...ENTITIES.trucks.fields };
  const tankFields = {
    site: { type: 'text', required: true, label: 'Site name' },
    grade: { type: 'text', required: true, label: 'Grade' },
    name: ENTITIES.tanks.fields.name,
    tank_number: ENTITIES.tanks.fields.tank_number,
    capacity_l: ENTITIES.tanks.fields.capacity_l,
    active: ENTITIES.tanks.fields.active,
    calibration_on_file: ENTITIES.tanks.fields.calibration_on_file,
  };
  const compFields = {
    truck: { type: 'text', required: true, label: 'Truck' },
    position: { type: 'int', required: true, min: 1, max: 20, label: 'Compartment' },
    capacity_l: { type: 'int', required: true, min: 1, max: 60000, label: 'Capacity' },
  };

  const grades = clean('Grades', rowsOf('grades'), gradeFields, 'code');
  const sites = clean('Sites', rowsOf('sites'), siteFields, 'name');
  const tanks = clean('Tanks', rowsOf('tanks'), tankFields, (v) => `${v.site}\u0000${v.name}`);
  const trucks = clean('Trucks', rowsOf('trucks'), truckFields, 'name');
  const comps = clean('Compartments', rowsOf('compartments'), compFields, (v) => `${v.truck}\u0000${v.position}`);

  // Cross-checks: every tank's site and grade, every compartment's truck, must exist after import.
  const gradeCodes = new Set([...existingGrades, ...grades.map((g) => g.code)]);
  const siteNames = new Set([...existingSites, ...sites.map((s) => s.name)]);
  const truckNames = new Set([...existingTrucks, ...trucks.map((t) => t.name)]);
  for (const t of tanks) {
    if (!siteNames.has(t.site)) errors.push(`Tanks: "${t.name}" is at site "${t.site}", which isn't on the Sites tab or in the app.`);
    if (!gradeCodes.has(t.grade)) errors.push(`Tanks: "${t.site} ${t.name}" uses grade "${t.grade}", which isn't on the Grades tab or in the app.`);
  }
  for (const c of comps) {
    if (!truckNames.has(c.truck)) errors.push(`Compartments: truck "${c.truck}" isn't on the Trucks tab or in the app.`);
  }
  const compsByTruck = new Map();
  for (const c of comps) {
    if (!compsByTruck.has(c.truck)) compsByTruck.set(c.truck, []);
    compsByTruck.get(c.truck).push(c);
  }
  for (const [truck, list] of compsByTruck) {
    const positions = list.map((c) => c.position).sort((a, b) => a - b);
    if (positions.some((p, i) => p !== i + 1)) errors.push(`Compartments: truck "${truck}" should be numbered 1, 2, 3 and so on with no gaps.`);
  }

  if (errors.length) return json({ ok: false, errors }, 400);
  if (!grades.length && !sites.length && !tanks.length && !trucks.length && !comps.length) {
    throw new HttpError(400, 'The file had nothing to import.');
  }

  // Upsert helper: insert, or update only the columns this row supplies.
  const upsert = (table, conflict, values, extraCols = {}, extraSql = {}) => {
    const cols = [...Object.keys(extraCols), ...Object.keys(extraSql), ...Object.keys(values)];
    const placeholders = [
      ...Object.keys(extraCols).map(() => '?'),
      ...Object.values(extraSql).map((s) => s.sql),
      ...Object.keys(values).map(() => '?'),
    ];
    const params = [
      ...Object.values(extraCols),
      ...Object.values(extraSql).flatMap((s) => s.params),
      ...Object.values(values),
    ];
    const updates = Object.keys(values).filter((c) => !conflict.includes(c));
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
                 ON CONFLICT(${conflict.join(', ')}) DO ${updates.length ? 'UPDATE SET ' + updates.map((c) => `${c} = excluded.${c}`).join(', ') : 'NOTHING'}`;
    return env.DB.prepare(sql).bind(...params);
  };

  const stmts = [];
  for (const g of grades) stmts.push(upsert('grades', ['company_id', 'code'], g, { company_id: cid }));
  for (const s of sites) stmts.push(upsert('sites', ['company_id', 'name'], s, { company_id: cid }));
  for (const t of trucks) stmts.push(upsert('trucks', ['company_id', 'name'], t, { company_id: cid }));
  for (const t of tanks) {
    const { site, grade, ...rest } = t;
    stmts.push(
      upsert('tanks', ['site_id', 'name'], rest, { company_id: cid }, {
        site_id: { sql: '(SELECT id FROM sites WHERE company_id = ? AND name = ?)', params: [cid, site] },
        grade_id: { sql: '(SELECT id FROM grades WHERE company_id = ? AND code = ?)', params: [cid, grade] },
      })
    );
    // A re-import can move a tank to a different grade.
    stmts.push(
      env.DB.prepare(
        `UPDATE tanks SET grade_id = (SELECT id FROM grades WHERE company_id = ? AND code = ?)
         WHERE company_id = ? AND name = ? AND site_id = (SELECT id FROM sites WHERE company_id = ? AND name = ?)`
      ).bind(cid, grade, cid, t.name, cid, site)
    );
  }
  // Each truck listed on the Compartments tab gets exactly that set of compartments.
  for (const [truck, list] of compsByTruck) {
    const truckId = { sql: '(SELECT id FROM trucks WHERE company_id = ? AND name = ?)', params: [cid, truck] };
    stmts.push(
      env.DB.prepare('DELETE FROM compartments WHERE company_id = ? AND truck_id = (SELECT id FROM trucks WHERE company_id = ? AND name = ?)')
        .bind(cid, cid, truck)
    );
    for (const c of list) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO compartments (company_id, truck_id, position, capacity_l) VALUES (?, ${truckId.sql}, ?, ?)`
        ).bind(cid, ...truckId.params, c.position, c.capacity_l)
      );
    }
  }
  await env.DB.batch(stmts);

  const count = (rows, existing, key) => {
    const updated = rows.filter((r) => existing.has(key(r))).length;
    return { created: rows.length - updated, updated };
  };
  return json({
    ok: true,
    summary: {
      grades: count(grades, existingGrades, (g) => g.code),
      sites: count(sites, existingSites, (s) => s.name),
      tanks: count(tanks, existingTanks, (t) => `${t.site}\u0000${t.name}`),
      trucks: count(trucks, existingTrucks, (t) => t.name),
      compartments: { trucks: compsByTruck.size, compartments: comps.length },
    },
  });
}

/* ------------------------------------------------------------------ dips */

const LOCAL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;

// A wall-clock time in the company's time zone, like "2026-10-05T06:30", to epoch milliseconds.
function zonedToUtc(local, timeZone) {
  const m = String(local).trim().match(LOCAL_TIME_RE);
  if (!m) throw new HttpError(400, `"${local}" isn't a date and time the app understands. Use a format like 05/10/2026 06:30.`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new HttpError(400, `"${local}" isn't a real date and time.`);
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return utc;
}

function checkDipTime(ms) {
  if (ms > Date.now() + 15 * 60 * 1000) throw new HttpError(400, 'A dip can’t be in the future.');
  if (ms < Date.now() - 2 * 365 * 86400000) throw new HttpError(400, 'That dip is more than two years old.');
  return ms;
}

function cleanLitres(raw, label) {
  const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
  const v = typeof raw === 'string' ? Number(raw.replace(/[,\s]/g, '').replace(/l$/i, '')) : Number(raw);
  if (blank || !Number.isFinite(v)) throw new HttpError(400, `${label} needs a number of litres.`);
  if (v < 0) throw new HttpError(400, `${label} can’t be negative.`);
  if (v > 1_000_000) throw new HttpError(400, `${label} is too large.`);
  return Math.round(v);
}

async function companyTanks(env, companyId) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.capacity_l, t.active, s.name AS site_name, g.code AS grade_code
     FROM tanks t JOIN sites s ON s.id = t.site_id JOIN grades g ON g.id = t.grade_id WHERE t.company_id = ?`
  )
    .bind(companyId)
    .all();
  return results;
}

function overCapacity(tank, litres) {
  if (litres <= tank.capacity_l) return null;
  return `${tank.site_name} ${tank.name}: ${litres.toLocaleString('en-AU')} L is more than its listed capacity of ` +
    `${tank.capacity_l.toLocaleString('en-AU')} L. Check the dip or the tank’s capacity.`;
}

// A second reading for the same tank at the same minute replaces the first.
function saveDip(env, companyId, userId, tankId, litres, takenAt, source) {
  return env.DB.prepare(
    `INSERT INTO dips (company_id, tank_id, litres, taken_at, source, entered_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tank_id, taken_at) DO UPDATE SET litres = excluded.litres, source = excluded.source, entered_by = excluded.entered_by`
  ).bind(companyId, tankId, litres, takenAt, source, userId);
}

async function latestDips(env, companyId) {
  const { results } = await env.DB.prepare(
    `SELECT id, tank_id, litres, taken_at, source, entered_by_name FROM (
       SELECT d.id, d.tank_id, d.litres, d.taken_at, d.source, u.name AS entered_by_name,
              ROW_NUMBER() OVER (PARTITION BY d.tank_id ORDER BY d.taken_at DESC, d.id DESC) AS rn
       FROM dips d LEFT JOIN users u ON u.id = d.entered_by
       WHERE d.company_id = ?
     ) WHERE rn = 1`
  )
    .bind(companyId)
    .all();
  return results;
}

async function dipHistory(env, companyId, tankId) {
  if (!tankId) throw new HttpError(400, 'Choose a tank.');
  const tank = await env.DB.prepare('SELECT id FROM tanks WHERE id = ? AND company_id = ?').bind(tankId, companyId).first();
  if (!tank) throw new HttpError(404, 'That tank was not found.');
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.litres, d.taken_at, d.source, u.name AS entered_by_name
     FROM dips d LEFT JOIN users u ON u.id = d.entered_by
     WHERE d.tank_id = ? AND d.company_id = ? ORDER BY d.taken_at DESC, d.id DESC LIMIT 60`
  )
    .bind(tankId, companyId)
    .all();
  return results;
}

// Readings typed in on the Dips screen: one time, one or more tanks.
async function enterDips(request, env, me) {
  const body = await readJson(request);
  const { timezone } = await getSettings(env, me.company_id);
  const takenAt = checkDipTime(body.taken_at ? zonedToUtc(body.taken_at, timezone) : Date.now());
  const readings = Array.isArray(body.readings) ? body.readings : [];
  if (!readings.length) throw new HttpError(400, 'Enter at least one dip.');
  if (readings.length > 200) throw new HttpError(400, 'Enter at most 200 dips at a time.');
  const tanks = new Map((await companyTanks(env, me.company_id)).map((t) => [t.id, t]));
  const warnings = [];
  const stmts = [];
  const seen = new Set();
  for (const r of readings) {
    const tank = tanks.get(Number(r.tank_id));
    if (!tank) throw new HttpError(400, 'One of those tanks was not found.');
    if (seen.has(tank.id)) throw new HttpError(400, `${tank.name} is listed twice.`);
    seen.add(tank.id);
    const litres = cleanLitres(r.litres, `${tank.site_name} ${tank.name}`);
    const warning = overCapacity(tank, litres);
    if (warning) warnings.push(warning);
    stmts.push(saveDip(env, me.company_id, me.id, tank.id, litres, takenAt, 'manual'));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, saved: stmts.length, warnings });
}

// A sheet of readings. Each row names its site, and its tank by name (or by grade
// when the site has only one tank of that grade). Nothing is saved if any row is wrong.
async function importDips(request, env, me) {
  const body = await readJson(request);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, 'The file had no dips in it. Fill in the Litres column and upload it again.');
  if (rows.length > 5000) throw new HttpError(400, 'Upload at most 5,000 dips at a time.');
  const { timezone } = await getSettings(env, me.company_id);
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const bySite = new Map();
  for (const t of await companyTanks(env, me.company_id)) {
    const key = norm(t.site_name);
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(t);
  }
  const errors = [];
  const warnings = [];
  const stmts = [];
  const seen = new Set();
  const dipped = new Set();
  const now = Date.now();
  rows.forEach((r, i) => {
    try {
      if (!r.site) throw new HttpError(400, 'Site is blank.');
      const siteTanks = bySite.get(norm(r.site));
      if (!siteTanks) throw new HttpError(400, `Site "${r.site}" isn’t in the app, or has no tanks.`);
      let tank = r.tank ? siteTanks.find((t) => norm(t.name) === norm(r.tank)) : null;
      if (!tank && !r.tank && r.grade) {
        const matches = siteTanks.filter((t) => norm(t.grade_code) === norm(r.grade));
        const active = matches.filter((t) => t.active);
        if (matches.length === 1) tank = matches[0];
        else if (active.length === 1) tank = active[0];
        else if (matches.length > 1) throw new HttpError(400, `${r.site} has more than one ${r.grade} tank, so fill in the Tank column.`);
      }
      if (!tank) throw new HttpError(400, `${r.site} has no tank called "${r.tank || r.grade || ''}".`);
      const litres = cleanLitres(r.litres, 'Litres');
      const takenAt = checkDipTime(r.taken_at ? zonedToUtc(r.taken_at, timezone) : now);
      const key = `${tank.id}:${takenAt}`;
      if (seen.has(key)) throw new HttpError(400, `${tank.site_name} ${tank.name} has two dips at the same time.`);
      seen.add(key);
      dipped.add(tank.id);
      const warning = overCapacity(tank, litres);
      if (warning) warnings.push(warning);
      stmts.push(saveDip(env, me.company_id, me.id, tank.id, litres, takenAt, 'upload'));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      errors.push(`Row ${r._row || i + 2}: ${err.message}`);
    }
  });
  if (errors.length) return json({ ok: false, errors }, 400);
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return json({ ok: true, saved: stmts.length, tanks: dipped.size, warnings });
}

async function deleteDip(env, me, id) {
  const row = await env.DB.prepare('SELECT id FROM dips WHERE id = ? AND company_id = ?').bind(id, me.company_id).first();
  if (!row) throw new HttpError(404, 'That dip was not found.');
  await env.DB.prepare('DELETE FROM dips WHERE id = ? AND company_id = ?').bind(id, me.company_id).run();
  return json({ ok: true });
}

/* ---------------------------------------------------------------- router */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/setup-status' && method === 'GET') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ needs_setup: row.n === 0 });
  }
  if (path === '/api/setup' && method === 'POST') return firstRunSetup(request, env);
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') return logout(request, env);

  const me = await currentUser(request, env);
  if (!me) throw new HttpError(401, 'Please sign in.');
  const isAdmin = me.role === 'admin';
  const canRead = me.role === 'admin' || me.role === 'dispatcher';
  const requireAdmin = () => {
    if (!isAdmin) throw new HttpError(403, 'Only an admin can change setup data.');
  };

  if (path === '/api/me' && method === 'GET') return json(me);
  if (path === '/api/me/password' && method === 'POST') return changeOwnPassword(request, env, me);

  if (!canRead) throw new HttpError(403, 'Your account doesn’t have access to setup data.');

  if (path === '/api/settings') {
    if (method === 'GET') return json(await getSettings(env, me.company_id));
    if (method === 'PUT') {
      requireAdmin();
      return json(await updateSettings(env, me.company_id, await readJson(request)));
    }
  }

  // Dips: admins and dispatchers can read and record them.
  if (path === '/api/dips/latest' && method === 'GET') return json(await latestDips(env, me.company_id));
  if (path === '/api/dips' && method === 'GET') return json(await dipHistory(env, me.company_id, Number(url.searchParams.get('tank'))));
  if (path === '/api/dips' && method === 'POST') return enterDips(request, env, me);
  if (path === '/api/dips/import' && method === 'POST') return importDips(request, env, me);
  const dipMatch = path.match(/^\/api\/dips\/(\d+)$/);
  if (dipMatch && method === 'DELETE') return deleteDip(env, me, Number(dipMatch[1]));

  if (path === '/api/import' && method === 'POST') {
    requireAdmin();
    return importSetup(request, env, me);
  }

  if (path === '/api/users' || path.startsWith('/api/users/')) {
    requireAdmin();
    const id = Number(path.split('/')[3]);
    if (path === '/api/users' && method === 'GET') return json(await listUsers(env, me.company_id));
    if (path === '/api/users' && method === 'POST') return createUser(request, env, me);
    if (id && method === 'PUT') return updateUser(request, env, me, id);
    if (id && method === 'DELETE') return deleteUser(env, me, id);
  }

  const m = path.match(/^\/api\/([a-z]+)(?:\/(\d+))?$/);
  if (m && ENTITIES[m[1]]) {
    const name = m[1];
    const id = m[2] ? Number(m[2]) : null;
    if (!id && method === 'GET') return json(await listEntity(env, me.company_id, name));
    if (id && method === 'GET') {
      const row = await getEntity(env, me.company_id, name, id);
      if (!row) throw new HttpError(404, `That ${ENTITIES[name].noun} was not found.`);
      return json(row);
    }
    requireAdmin();
    if (!id && method === 'POST') return json(await createEntity(env, me.company_id, name, await readJson(request)), 201);
    if (id && method === 'PUT') return json(await updateEntity(env, me.company_id, name, id, await readJson(request)));
    if (id && method === 'DELETE') {
      await deleteEntity(env, me.company_id, name, id);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      return new Response(UI_HTML, { headers: PAGE_HEADERS });
    }
    try {
      await ensureSchema(env);
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server. Try again, and tell your admin if it keeps happening.' }, 500);
    }
  },
};
