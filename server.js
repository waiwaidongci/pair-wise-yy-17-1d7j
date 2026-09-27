const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const judgment = require('./lib/judgment');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function num(value, name, errors) {
  const result = Number(value);
  if (!Number.isFinite(result)) errors.push(`${name}必须是数字`);
  return result;
}

function parseEffectiveAt(value, errors) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    errors.push('生效时刻格式应为日期+时间');
    return '';
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    errors.push('生效时刻不是有效时间');
    return '';
  }
  return instant.toISOString();
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// ---- 样点档案 -------------------------------------------------------------

app.post('/api/sites', async (req, res) => {
  const db = await readDb();
  const now = new Date().toISOString();
  const item = {
    id: `sites-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    cave: req.body.cave || '',
    zone: req.body.zone || '',
    pointCode: req.body.pointCode || '',
    route: req.body.route || '',
    sensitivity: req.body.sensitivity || '',
    protectedStatus: req.body.protectedStatus || '常规观察',
    note: req.body.note || '',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || '样点建档')]
  };
  db.sites.push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/sites/:id', async (req, res) => {
  const db = await readDb();
  const item = db.sites.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const editable = ['cave', 'zone', 'pointCode', 'route', 'sensitivity', 'protectedStatus', 'note'];
  for (const field of editable) {
    if (req.body[field] !== undefined) item[field] = req.body[field];
  }
  item.updatedAt = new Date().toISOString();
  item.history = item.history || [];
  item.history.unshift(stamp(req.body.historyAction || '档案修订', req.body.note || ''));
  await writeDb(db);
  res.json(item);
});

// ---- 基准版本档案（补录 / 修订 / 删除均登记生效时刻与基准值） --------------

function readBaselinePayload(body, db, current) {
  const errors = [];
  const siteId = body.siteId || current?.siteId || '';
  if (!db.sites.some((site) => site.id === siteId)) errors.push('请选择有效样点');

  const values = {};
  for (const field of ['temp', 'humidity', 'co2', 'tempTolerance', 'humidityTolerance', 'co2Tolerance']) {
    values[field] = num(body[field], config.baselineFields[field].label, errors);
  }
  if (values.tempTolerance < 0 || values.humidityTolerance < 0 || values.co2Tolerance < 0) {
    errors.push('允许波动不能为负数');
  }

  const effectiveAt = body.effectiveAt
    ? parseEffectiveAt(body.effectiveAt, errors)
    : current?.effectiveAt || '';

  return { errors, siteId, values, effectiveAt };
}

app.post('/api/baselines', async (req, res) => {
  const db = await readDb();
  const { errors, siteId, values, effectiveAt } = readBaselinePayload(req.body, db);
  if (errors.length) return res.status(400).json({ error: errors.join('；') });

  const now = new Date().toISOString();
  const siblings = db.baselines.filter((entry) => entry.siteId === siteId);
  const backdated = siblings.some((entry) => Date.parse(entry.effectiveAt) > Date.parse(effectiveAt));
  const item = {
    id: `baselines-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId,
    versionNo: siblings.length ? Math.max(...siblings.map((entry) => entry.versionNo || 0)) + 1 : 1,
    effectiveAt,
    ...values,
    note: req.body.note || '',
    createdAt: now,
    updatedAt: now,
    history: [stamp(backdated ? '补录' : '登记', `${backdated ? '按历史生效时刻补录' : '新版本登记'}，立即按新版本重算受影响巡测`)]
  };
  db.baselines.push(item);
  const recomputed = judgment.recomputeSite(db, siteId, backdated ? '基准补录' : '基准登记', now);
  await writeDb(db);
  res.status(201).json({ item, recomputed });
});

app.patch('/api/baselines/:id', async (req, res) => {
  const db = await readDb();
  const item = db.baselines.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const { errors, values, effectiveAt } = readBaselinePayload(req.body, db, item);
  if (errors.length) return res.status(400).json({ error: errors.join('；') });

  Object.assign(item, values, { effectiveAt });
  if (req.body.note !== undefined) item.note = req.body.note;
  item.updatedAt = new Date().toISOString();
  item.history = item.history || [];
  item.history.unshift(stamp('基准修订', '修订生效时刻或基准值，受影响巡测按新版本重算'));
  const now = item.updatedAt;
  const recomputed = judgment.recomputeSite(db, item.siteId, '基准修订', now);
  await writeDb(db);
  res.json({ item, recomputed });
});

app.delete('/api/baselines/:id', async (req, res) => {
  const db = await readDb();
  const item = db.baselines.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const inUse = (db.surveys || []).some(
    (survey) => survey.judgment && survey.judgment.baselineId === item.id
  );
  if (inUse) return res.status(409).json({ error: '该版本已被巡测台账引用，不能删除，可再补录新版本覆盖' });

  db.baselines = db.baselines.filter((entry) => entry.id !== item.id);
  const now = new Date().toISOString();
  const recomputed = judgment.recomputeSite(db, item.siteId, '基准删除', now);
  await writeDb(db);
  res.json({ recomputed });
});

// ---- 巡测记录：保存时按当天版本判定，不接受人工状态/结论覆盖 ----------------

const SURVEY_FIELDS = ['surveyor', 'date', 'temperature', 'humidity', 'co2', 'dripRate', 'photoUrl', 'disturbance'];

app.post('/api/surveys', async (req, res) => {
  const db = await readDb();
  const errors = [];
  const siteId = req.body.siteId || '';
  if (!db.sites.some((site) => site.id === siteId)) errors.push('请选择有效样点');
  const date = String(req.body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('巡测日期格式应为 YYYY-MM-DD');
  const numbers = {};
  for (const field of ['temperature', 'humidity', 'co2', 'dripRate']) {
    numbers[field] = num(req.body[field], config.surveyMetricLabels[field], errors);
  }
  if (errors.length) return res.status(400).json({ error: errors.join('；') });

  const now = new Date().toISOString();
  const survey = {
    id: `surveys-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId,
    surveyor: req.body.surveyor || '',
    date,
    ...numbers,
    photoUrl: req.body.photoUrl || '',
    disturbance: req.body.disturbance || '',
    reviewNote: '',
    reviewedBy: '',
    reviewedAt: '',
    createdAt: now,
    updatedAt: now,
    history: []
  };
  const version = judgment.versionForDate(db.baselines.filter((entry) => entry.siteId === siteId), date);
  survey.judgment = judgment.judge(survey, version, now);
  survey.status = judgment.statusOf(survey.judgment);
  const outs = judgment.outLabels(survey.judgment);
  const detail = survey.judgment.missing
    ? '当日尚无生效基准版本，转待复查，补录基准后自动重算'
    : outs.length
      ? `按当天${survey.judgment.label}判定：${outs.join('、')}超限，转待复查`
      : `按当天${survey.judgment.label}判定：三项均在范围，判定正常`;
  survey.history.unshift(stamp('创建', detail));
  db.surveys.push(survey);
  await writeDb(db);
  res.status(201).json(survey);
});

// 巡测档案不允许通用字段覆盖；状态与判定结果只能来自判定 / 复查动作
app.patch('/api/surveys/:id', (req, res) => {
  res.status(405).json({ error: '巡测记录不能直接改判，超限记录请走复查流程；判定结果由基准版本重算' });
});

// 复查：先按当前版本重算，仍超限则不能完成，人工结论不能盖住新结果
app.post('/api/surveys/:id/review', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((entry) => entry.id === req.params.id);
  if (!survey) return res.status(404).json({ error: 'not found' });

  const now = new Date().toISOString();
  const versions = db.baselines.filter((entry) => entry.siteId === survey.siteId);
  const result = judgment.reviewSurvey(
    survey,
    versions,
    { note: req.body.reviewNote, reviewer: req.body.reviewedBy },
    now
  );
  if (!result.ok) {
    await writeDb(db);
    const reason = result.judgment.missing
      ? '当日没有生效的基准版本'
      : `${judgment.outLabels(result.judgment).join('、')}仍超限`;
    return res.status(409).json({ error: `${reason}，不能完成复查`, survey });
  }
  await writeDb(db);
  res.json(survey);
});

// ---- 样点保护状态等通用动作 -------------------------------------------------

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  return { item };
}

// 启动时兜底：历史巡测若与当前版本不一致（如手工改过库），先重算一次
async function reconcile() {
  const db = await readDb();
  if (!Array.isArray(db.baselines)) db.baselines = [];
  if (!Array.isArray(db.surveys)) db.surveys = [];
  let dirty = false;
  for (const survey of db.surveys) {
    const versions = db.baselines.filter((entry) => entry.siteId === survey.siteId);
    const result = judgment.recomputeSurvey(survey, versions, '启动校对', new Date().toISOString());
    if (result.changed) dirty = true;
  }
  if (dirty) await writeDb(db);
}

reconcile()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`${config.title} running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('启动失败', error);
    process.exit(1);
  });
