// 判定领域逻辑：与档案存储、页面入口分开，纯函数，不读写文件。
// 基准版本按“生效时刻”对样点生效；巡测按发生当天所处的版本判定三项范围。

const METRICS = [
  { key: 'temperature', baselineKey: 'temp', label: '温度', unit: '℃' },
  { key: 'humidity', baselineKey: 'humidity', label: '湿度', unit: '%RH' },
  { key: 'co2', baselineKey: 'co2', label: 'CO2', unit: 'ppm' }
];

function round(value) {
  return Math.round(value * 100) / 100;
}

// 巡测只有日期没有时刻：当天（含当天）生效的版本都适用于这条巡测。
function dayEndInstant(date) {
  return new Date(`${date}T23:59:59`).toISOString();
}

function effectiveVersion(versions, atIso) {
  const target = Date.parse(atIso);
  return [...versions]
    .filter((version) => Date.parse(version.effectiveAt) <= target)
    .sort(
      (a, b) =>
        Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) ||
        (b.versionNo || 0) - (a.versionNo || 0)
    )[0] || null;
}

function versionForDate(versions, date) {
  return effectiveVersion(versions, dayEndInstant(date));
}

function versionLabel(version) {
  return `v${version.versionNo}`;
}

function signature(version) {
  return JSON.stringify({
    effectiveAt: version.effectiveAt,
    temp: version.temp,
    tempTolerance: version.tempTolerance,
    humidity: version.humidity,
    humidityTolerance: version.humidityTolerance,
    co2: version.co2,
    co2Tolerance: version.co2Tolerance
  });
}

// 按一个基准版本判定一条巡测，留下版本快照与三项明细。
function judge(survey, version, now = new Date().toISOString()) {
  if (!version) {
    return { missing: true, allInRange: false, items: {}, judgedAt: now };
  }
  const items = {};
  let allInRange = true;
  for (const metric of METRICS) {
    const baseline = Number(version[metric.baselineKey]);
    const tolerance = Number(version[`${metric.baselineKey}Tolerance`]);
    const min = round(baseline - tolerance);
    const max = round(baseline + tolerance);
    const value = Number(survey[metric.key]);
    const inRange = value >= min && value <= max;
    allInRange = allInRange && inRange;
    items[metric.key] = {
      label: metric.label,
      unit: metric.unit,
      value,
      baseline,
      tolerance,
      min,
      max,
      inRange
    };
  }
  return {
    missing: false,
    baselineId: version.id,
    label: versionLabel(version),
    versionNo: version.versionNo,
    effectiveAt: version.effectiveAt,
    items,
    allInRange,
    sig: signature(version),
    judgedAt: now
  };
}

function statusOf(judgment) {
  return judgment && !judgment.missing && judgment.allInRange ? '正常' : '异常待复查';
}

function outLabels(judgment) {
  return METRICS.filter((metric) => judgment.items[metric.key] && !judgment.items[metric.key].inRange).map(
    (metric) => metric.label
  );
}

function describe(judgment) {
  if (judgment.missing) return '巡测当日没有生效的基准版本，转待复查';
  const outs = outLabels(judgment);
  const head = `${judgment.label}（${String(judgment.effectiveAt).slice(0, 16).replace('T', ' ')} 生效）`;
  return outs.length
    ? `按基准${head}重算：${outs.join('、')}超限，转待复查`
    : `按基准${head}重算：三项均在范围`;
}

function sameJudgment(current, next) {
  if (!current) return false;
  if (next.missing) return current.missing === true;
  return !current.missing && current.baselineId === next.baselineId && current.sig === next.sig;
}

// 状态机：
// - 新版本判定超限：一律转“异常待复查”，已复查也会被打回（人工结论不能盖住新结果）
// - 新版本判定在范围：已复查维持已复查；此前“无基准待复查”（基准补录）转正常；
//   其余待复查保留待复查，由人工完成复查闭环
function nextStatus(previousStatus, previousMissing, judgment) {
  if (judgment.missing || !judgment.allInRange) return '异常待复查';
  if (previousStatus === '已复查') return '已复查';
  if (previousMissing) return '正常';
  return previousStatus || '异常待复查';
}

// 用当前基准集重算一条巡测；版本未变、基准值未变则不动，保证只处理“受影响”的记录。
function recomputeSurvey(survey, versions, reason, now = new Date().toISOString()) {
  const version = versionForDate(versions, survey.date);
  const judgment = judge(survey, version, now);
  if (sameJudgment(survey.judgment, judgment)) return { changed: false, judgment };

  const previousStatus = survey.status;
  const previousMissing = survey.judgment && survey.judgment.missing === true;
  survey.judgment = judgment;
  survey.status = nextStatus(previousStatus, previousMissing, judgment);
  survey.updatedAt = now;
  survey.history = survey.history || [];

  let note;
  if (judgment.missing) {
    note = describe(judgment);
  } else if (judgment.allInRange) {
    note = `${describe(judgment)}，`;
    if (previousStatus === '已复查') note += '维持已复查';
    else if (previousMissing) note += '基准补录后误报解除，转正常';
    else note += '可完成复查';
  } else {
    note = describe(judgment);
    if (previousStatus === '已复查') note += '；原人工复查结论不再覆盖系统判定';
  }
  survey.history.unshift({
    at: now,
    action: reason === '创建' ? '判定' : `${reason}重算`,
    note
  });
  return { changed: true, judgment, previousStatus };
}

// 复查：先按当前版本重判；仍超限则拒绝完成，在范围内才落人工复查结论。
function reviewSurvey(survey, versions, payload, now = new Date().toISOString()) {
  const version = versionForDate(versions, survey.date);
  const judgment = judge(survey, version, now);
  survey.judgment = judgment;
  survey.updatedAt = now;
  if (judgment.missing || !judgment.allInRange) {
    return { ok: false, judgment };
  }
  survey.status = '已复查';
  survey.reviewNote = payload.note || '异常已复核';
  survey.reviewedBy = payload.reviewer || survey.surveyor || '';
  survey.reviewedAt = now;
  survey.history = survey.history || [];
  survey.history.unshift({ at: now, action: '完成复查', note: survey.reviewNote });
  return { ok: true, judgment };
}

// 基准补录/修订后，重算该样点下受影响的巡测与复查记录。
function recomputeSite(db, siteId, reason, now = new Date().toISOString()) {
  const versions = (db.baselines || []).filter((version) => version.siteId === siteId);
  let count = 0;
  for (const survey of (db.surveys || []).filter((entry) => entry.siteId === siteId)) {
    if (recomputeSurvey(survey, versions, reason, now).changed) count += 1;
  }
  return count;
}

module.exports = {
  METRICS,
  round,
  dayEndInstant,
  effectiveVersion,
  versionForDate,
  versionLabel,
  signature,
  judge,
  statusOf,
  outLabels,
  recomputeSurvey,
  recomputeSite,
  reviewSurvey
};
