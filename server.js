'use strict';

/**
 * 接口入口：只做 HTTP 映射与参数校验，档案读写走 src/archive.js，
 * 判定与重算走 src/judge.js。
 */
const express = require('express');
const path = require('path');
const config = require('./project.config');
const archive = require('./src/archive');
const judge = require('./src/judge');

const app = express();
const PORT = process.env.PORT || config.port || 3912;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);
const notFound = (message = '记录不存在') => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);

function requireFields(body, fields) {
  for (const [name, label] of fields) {
    if (!String(body[name] ?? '').trim()) throw badRequest(`缺少${label}`);
  }
}

function assertValid(errors) {
  if (errors.length) throw badRequest(errors.join('；'));
}

/** 读接口：无需加锁。 */
function query(handler) {
  return async (req, res) => {
    try {
      const db = await archive.load();
      const out = await handler(db, req);
      res.status(out.status || 200).json(out.body);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };
}

/** 写接口：串行执行，成功后落盘。 */
function mutate(handler) {
  return async (req, res) => {
    try {
      const out = await archive.withLock(async () => {
        const db = await archive.load();
        const result = await handler(db, req);
        await archive.save(db);
        return result;
      });
      res.status(out.status || 200).json(out.body);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };
}

app.get('/api/config', (req, res) => {
  res.json({
    title: config.title,
    lede: config.lede,
    tones: config.tones,
    siteStatuses: config.siteStatuses,
    sensitivities: config.sensitivities,
    items: judge.ITEMS
  });
});

app.get('/api/state', query(async (db) => ({ body: archive.snapshot(db) })));

// ---------- 样点档案 ----------

app.post('/api/sites', mutate(async (db, req) => {
  requireFields(req.body, [['cave', '洞穴'], ['zone', '分区'], ['pointCode', '样点编号'], ['route', '巡测路线']]);
  const site = archive.insert(db, 'sites', {
    cave: req.body.cave.trim(),
    zone: req.body.zone.trim(),
    pointCode: req.body.pointCode.trim(),
    route: req.body.route.trim(),
    sensitivity: config.sensitivities.includes(req.body.sensitivity) ? req.body.sensitivity : config.sensitivities[0],
    protectedStatus: config.siteStatuses.includes(req.body.protectedStatus) ? req.body.protectedStatus : config.siteStatuses[0],
    note: String(req.body.note || '').trim()
  }, '样点建档');
  return { status: 201, body: site };
}));

app.patch('/api/sites/:id', mutate(async (db, req) => {
  const site = archive.find(db, 'sites', req.params.id);
  if (!site) throw notFound('样点不存在');
  for (const name of ['cave', 'zone', 'pointCode', 'route', 'note']) {
    if (req.body[name] !== undefined) site[name] = String(req.body[name]).trim();
  }
  if (config.sensitivities.includes(req.body.sensitivity)) site.sensitivity = req.body.sensitivity;
  if (config.siteStatuses.includes(req.body.protectedStatus)) site.protectedStatus = req.body.protectedStatus;
  archive.touch(site, '修订', '样点档案更新');
  return { body: site };
}));

app.delete('/api/sites/:id', mutate(async (db, req) => {
  const site = archive.find(db, 'sites', req.params.id);
  if (!site) throw notFound('样点不存在');
  if (db.surveys.some((survey) => survey.siteId === site.id)) {
    throw conflict('该样点已有巡测记录，不能删除');
  }
  db.baselines = db.baselines.filter((version) => version.siteId !== site.id);
  archive.remove(db, 'sites', site.id);
  return { status: 204, body: {} };
}));

app.post('/api/sites/:id/status', mutate(async (db, req) => {
  const site = archive.find(db, 'sites', req.params.id);
  if (!site) throw notFound('样点不存在');
  if (!config.siteStatuses.includes(req.body.status)) throw badRequest('保护状态无效');
  site.protectedStatus = req.body.status;
  archive.touch(site, '保护状态调整', req.body.status);
  return { body: site };
}));

/** 手工触发重算：基准数据修复后兜底用。 */
app.post('/api/sites/:id/recalc', mutate(async (db, req) => {
  const site = archive.find(db, 'sites', req.params.id);
  if (!site) throw notFound('样点不存在');
  const recalc = judge.recalcSite(db, site.id, { at: new Date().toISOString(), reason: '手工重算' });
  return { body: { recalc } };
}));

// ---------- 基准版本（按生效时刻登记） ----------

function readBaselinePayload(db, req) {
  const body = req.body || {};
  assertValid(judge.validateBaselinePayload(body));
  if (!archive.find(db, 'sites', body.siteId)) throw notFound('样点不存在');
  const items = {};
  for (const meta of judge.ITEMS) {
    items[meta.key] = { min: Number(body.items[meta.key].min), max: Number(body.items[meta.key].max) };
  }
  return {
    siteId: body.siteId,
    effectiveFrom: judge.normalizeEffectiveFrom(body.effectiveFrom),
    items,
    note: String(body.note || '').trim()
  };
}

app.post('/api/baselines', mutate(async (db, req) => {
  const fields = readBaselinePayload(db, req);
  const baseline = archive.insert(db, 'baselines', fields, fields.note || '基准版本登记');
  const recalc = judge.recalcSite(db, fields.siteId, { at: new Date().toISOString(), reason: '基准登记重算' });
  return { status: 201, body: { baseline, recalc } };
}));

app.patch('/api/baselines/:id', mutate(async (db, req) => {
  const baseline = archive.find(db, 'baselines', req.params.id);
  if (!baseline) throw notFound('基准版本不存在');
  const fields = readBaselinePayload(db, req);
  // 修订只改生效时刻与限值，版本不跨样点迁移
  Object.assign(baseline, fields, { siteId: baseline.siteId });
  archive.touch(baseline, '修订', fields.note || '基准版本修订');
  const recalc = judge.recalcSite(db, baseline.siteId, { at: new Date().toISOString(), reason: '基准修订重算' });
  return { body: { baseline, recalc } };
}));

app.delete('/api/baselines/:id', mutate(async (db, req) => {
  const baseline = archive.find(db, 'baselines', req.params.id);
  if (!baseline) throw notFound('基准版本不存在');
  archive.remove(db, 'baselines', baseline.id);
  const recalc = judge.recalcSite(db, baseline.siteId, { at: new Date().toISOString(), reason: '基准删除重算' });
  return { body: { recalc } };
}));

// ---------- 巡测记录（按发生当天版本判定） ----------

function readSurveyPayload(db, req) {
  const body = req.body || {};
  assertValid(judge.validateSurveyPayload(body));
  const site = archive.find(db, 'sites', body.siteId);
  if (!site) throw notFound('样点不存在');
  return {
    siteId: site.id,
    surveyor: String(body.surveyor).trim(),
    date: body.date,
    temperature: Number(body.temperature),
    humidity: Number(body.humidity),
    co2: Number(body.co2),
    dripRate: Number.isFinite(Number(body.dripRate)) ? Number(body.dripRate) : null,
    disturbance: String(body.disturbance || '').trim(),
    photoUrl: String(body.photoUrl || '').trim()
  };
}

app.post('/api/surveys', mutate(async (db, req) => {
  const fields = readSurveyPayload(db, req);
  const survey = archive.insert(db, 'surveys', {
    ...fields,
    status: judge.STATUS_PENDING,
    judgment: null,
    reviewNote: '',
    reviewedAt: null
  }, '巡测登记');
  const at = new Date().toISOString();
  judge.applyJudgment(survey, judge.judgeSurvey(survey, db.baselines, at), { at, reason: '巡测判定' });
  return { status: 201, body: survey };
}));

app.patch('/api/surveys/:id', mutate(async (db, req) => {
  const survey = archive.find(db, 'surveys', req.params.id);
  if (!survey) throw notFound('巡测记录不存在');
  Object.assign(survey, readSurveyPayload(db, req));
  const at = new Date().toISOString();
  judge.applyJudgment(survey, judge.judgeSurvey(survey, db.baselines, at), { at, reason: '巡测修订重判' });
  return { body: survey };
}));

app.delete('/api/surveys/:id', mutate(async (db, req) => {
  if (!archive.remove(db, 'surveys', req.params.id)) throw notFound('巡测记录不存在');
  return { status: 204, body: {} };
}));

/** 人工复查：只针对异常待复查的记录；结论可被后续基准重算推翻。 */
app.post('/api/surveys/:id/review', mutate(async (db, req) => {
  const survey = archive.find(db, 'surveys', req.params.id);
  if (!survey) throw notFound('巡测记录不存在');
  if (survey.status !== judge.STATUS_PENDING) throw conflict('仅“异常待复查”的巡测可以复查');
  survey.status = judge.STATUS_REVIEWED;
  survey.reviewNote = String(req.body.note || '').trim() || '人工复查通过';
  survey.reviewedAt = new Date().toISOString();
  archive.touch(survey, '复查', survey.reviewNote);
  return { body: survey };
}));

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
