'use strict';

/**
 * 档案层：样点、基准版本、巡测记录的存取与履历。
 * 只做存储与完整性维护，判定逻辑见 src/judge.js，接口见 server.js。
 */
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const COLLECTIONS = ['sites', 'baselines', 'surveys'];

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

async function load() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  for (const name of COLLECTIONS) {
    if (!Array.isArray(db[name])) db[name] = [];
  }
  return db;
}

async function save(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

// 串行化读写，避免并发请求交错写坏档案文件
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function insert(db, collection, fields, note) {
  const now = new Date().toISOString();
  const item = {
    id: newId(collection),
    ...fields,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', note)]
  };
  db[collection].push(item);
  return item;
}

function find(db, collection, id) {
  return db[collection].find((entry) => entry.id === id);
}

function touch(item, action, note) {
  item.updatedAt = new Date().toISOString();
  item.history = item.history || [];
  if (action) item.history.unshift(stamp(action, note));
  return item;
}

function remove(db, collection, id) {
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  return db[collection].length !== before;
}

function baselinesOf(db, siteId) {
  return db.baselines
    .filter((version) => version.siteId === siteId)
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
}

/** 台账口径排序：巡测按发生日期倒序，其余按更新时间倒序。 */
function snapshot(db) {
  const byUpdated = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  return {
    sites: [...db.sites].sort(byUpdated),
    baselines: [...db.baselines].sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom))),
    surveys: [...db.surveys].sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  };
}

module.exports = {
  DB_FILE,
  COLLECTIONS,
  stamp,
  load,
  save,
  withLock,
  insert,
  find,
  touch,
  remove,
  baselinesOf,
  snapshot
};
