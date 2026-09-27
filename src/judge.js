'use strict';

/**
 * 判定层：巡测按“发生当天生效的基准版本”判定，基准补录/修订后重算受影响记录。
 * 本模块只做纯计算，不碰存储；存储见 src/archive.js，接口见 server.js。
 */

// 参与判定的三项指标
const ITEMS = [
  { key: 'temperature', label: '温度', unit: '℃' },
  { key: 'humidity', label: '湿度', unit: '%' },
  { key: 'co2', label: 'CO2', unit: 'ppm' }
];

const STATUS_NORMAL = '正常';
const STATUS_PENDING = '异常待复查';
const STATUS_REVIEWED = '已复查';

const RESULT_OK = '正常';
const RESULT_OVER = '超限';
const RESULT_NO_BASELINE = '缺基准';

function dayOf(isoLike) {
  return String(isoLike || '').slice(0, 10);
}

function fmtMoment(isoLike) {
  return String(isoLike || '').slice(0, 16).replace('T', ' ');
}

function baselineLabel(version) {
  if (!version) return '无生效基准';
  const at = `${fmtMoment(version.effectiveFrom)} 生效`;
  return version.note ? `${at} · ${version.note}` : at;
}

/**
 * 取巡测发生当天生效的基准版本：
 * 生效日期不晚于巡测日的版本里，生效时刻最新的一版（同一时刻取登记在后者）。
 */
function effectiveBaseline(baselines, siteId, surveyDate) {
  let best = null;
  for (const version of baselines) {
    if (version.siteId !== siteId) continue;
    if (dayOf(version.effectiveFrom) > surveyDate) continue;
    const newer = !best
      || String(version.effectiveFrom) > String(best.effectiveFrom)
      || (String(version.effectiveFrom) === String(best.effectiveFrom)
        && String(version.createdAt || '') > String(best.createdAt || ''));
    if (newer) best = version;
  }
  return best;
}

/** 用生效版本判定一条巡测：三项都在范围才正常，任一超限即转待复查。 */
function judgeSurvey(survey, baselines, judgedAt) {
  const at = judgedAt || new Date().toISOString();
  const version = effectiveBaseline(baselines, survey.siteId, survey.date);
  if (!version) {
    return {
      baselineId: null,
      baselineLabel: baselineLabel(null),
      result: RESULT_NO_BASELINE,
      pass: false,
      judgedAt: at,
      items: {}
    };
  }
  const items = {};
  let pass = true;
  for (const meta of ITEMS) {
    const limit = version.items[meta.key] || {};
    const value = Number(survey[meta.key]);
    const min = Number(limit.min);
    const max = Number(limit.max);
    const ok = Number.isFinite(value) && value >= min && value <= max;
    items[meta.key] = { value, min, max, pass: ok };
    if (!ok) pass = false;
  }
  return {
    baselineId: version.id,
    baselineLabel: baselineLabel(version),
    result: pass ? RESULT_OK : RESULT_OVER,
    pass,
    judgedAt: at,
    items
  };
}

function statusFor(judgment) {
  return judgment.pass ? STATUS_NORMAL : STATUS_PENDING;
}

/**
 * 把判定结果落到巡测记录上。
 * 人工结论（已复查）不能盖住新结果：重算后状态一律以新判定为准，
 * 被推翻的人工结论留在履历里备查。
 */
function applyJudgment(survey, judgment, { at, reason }) {
  const wasReviewed = survey.status === STATUS_REVIEWED;
  survey.judgment = judgment;
  survey.status = statusFor(judgment);
  survey.updatedAt = at;
  const notes = [`${judgment.baselineLabel} → ${judgment.result}`];
  if (wasReviewed) notes.push('人工复查结论不覆盖新结果');
  survey.history = survey.history || [];
  survey.history.unshift({ at, action: reason || '判定', note: notes.join('；') });
  return survey;
}

/**
 * 基准补录/修订/删除后，重算该样点全部巡测（含已复查记录）。
 * 返回 { total, changed }，只有判定口径或结果变化的记录才写入履历。
 */
function recalcSite(db, siteId, { at, reason }) {
  const surveys = (db.surveys || []).filter((survey) => survey.siteId === siteId);
  let changed = 0;
  for (const survey of surveys) {
    const judgment = judgeSurvey(survey, db.baselines || [], at);
    const before = `${survey.status}|${survey.judgment?.baselineId || ''}|${survey.judgment?.result || ''}`;
    const after = `${statusFor(judgment)}|${judgment.baselineId || ''}|${judgment.result}`;
    if (before !== after) {
      changed += 1;
      applyJudgment(survey, judgment, { at, reason });
    }
  }
  return { total: surveys.length, changed };
}

/** 基准版本登记/修订的入参校验，返回错误列表（空数组为通过）。 */
function validateBaselinePayload(body) {
  const errors = [];
  if (!body.siteId) errors.push('缺少样点');
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(body.effectiveFrom || ''))) {
    errors.push('生效时刻无效');
  }
  for (const meta of ITEMS) {
    const limit = body.items?.[meta.key];
    const min = Number(limit?.min);
    const max = Number(limit?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      errors.push(`${meta.label}限值缺失或无效`);
    } else if (min > max) {
      errors.push(`${meta.label}下限不能大于上限`);
    }
  }
  return errors;
}

/** 巡测登记/修订的入参校验，返回错误列表（空数组为通过）。 */
function validateSurveyPayload(body) {
  const errors = [];
  if (!body.siteId) errors.push('缺少样点');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) errors.push('巡测日期无效');
  if (!String(body.surveyor || '').trim()) errors.push('缺少巡测人员');
  for (const meta of ITEMS) {
    if (!Number.isFinite(Number(body[meta.key]))) errors.push(`${meta.label}数值无效`);
  }
  return errors;
}

/** 生效时刻统一存为 'YYYY-MM-DDTHH:mm'（缺省 00:00），与巡测日同口径比较。 */
function normalizeEffectiveFrom(value) {
  const text = String(value);
  return text.length === 10 ? `${text}T00:00` : text.slice(0, 16);
}

module.exports = {
  ITEMS,
  STATUS_NORMAL,
  STATUS_PENDING,
  STATUS_REVIEWED,
  RESULT_OK,
  RESULT_OVER,
  RESULT_NO_BASELINE,
  baselineLabel,
  effectiveBaseline,
  judgeSurvey,
  statusFor,
  applyJudgment,
  recalcSite,
  validateBaselinePayload,
  validateSurveyPayload,
  normalizeEffectiveFrom
};
