'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const judge = require('../src/judge');

const SITE = 'site-1';

function baseline(id, effectiveFrom, items, createdAt = '2026-01-01T00:00:00.000Z') {
  return { id, siteId: SITE, effectiveFrom, items, note: '', createdAt };
}

const summer = baseline('bl-summer', '2026-06-01T00:00', {
  temperature: { min: 15.2, max: 17.2 },
  humidity: { min: 87, max: 97 },
  co2: { min: 400, max: 800 }
});

const autumn = baseline('bl-autumn', '2026-09-15T00:00', {
  temperature: { min: 14.8, max: 16.8 },
  humidity: { min: 90, max: 98 },
  co2: { min: 400, max: 700 }
}, '2026-09-15T02:00:00.000Z');

function survey(overrides) {
  return {
    id: 'sv-1',
    siteId: SITE,
    surveyor: '沈宁',
    date: '2026-09-05',
    temperature: 16,
    humidity: 93,
    co2: 720,
    status: '正常',
    judgment: null,
    history: [],
    ...overrides
  };
}

test('巡测按发生当天生效的版本判定，而不是今天的版本', () => {
  // 9月5日的补录巡测：按夏季版（CO2上限800）正常；若误用9月15日生效的秋季版（上限700）会误报
  const judgment = judge.judgeSurvey(survey({}), [summer, autumn]);
  assert.equal(judgment.baselineId, 'bl-summer');
  assert.equal(judgment.result, '正常');
  assert.equal(judgment.pass, true);

  // 9月20日的巡测才轮到秋季版
  const later = judge.judgeSurvey(survey({ date: '2026-09-20' }), [summer, autumn]);
  assert.equal(later.baselineId, 'bl-autumn');
  assert.equal(later.result, '超限'); // co2 720 > 700
  assert.equal(later.items.co2.pass, false);
});

test('三项都在范围才正常，任一超限即转待复查', () => {
  const ok = judge.judgeSurvey(survey({}), [summer]);
  assert.equal(ok.result, '正常');
  assert.equal(judge.statusFor(ok), '正常');

  const over = judge.judgeSurvey(survey({ temperature: 17.4, co2: 920 }), [summer]);
  assert.equal(over.result, '超限');
  assert.equal(judge.statusFor(over), '异常待复查');
  assert.equal(over.items.temperature.pass, false);
  assert.equal(over.items.humidity.pass, true);
  assert.equal(over.items.co2.pass, false);
});

test('巡测日没有任何生效版本时判为缺基准', () => {
  const judgment = judge.judgeSurvey(survey({ date: '2026-05-01' }), [summer, autumn]);
  assert.equal(judgment.baselineId, null);
  assert.equal(judgment.result, '缺基准');
  assert.equal(judge.statusFor(judgment), '异常待复查');
});

test('基准补录后重算受影响巡测，人工结论不能盖住新结果', () => {
  const db = {
    baselines: [summer, autumn],
    surveys: [
      survey({ id: 'sv-backfill', date: '2026-09-05', status: '正常' }),
      survey({
        id: 'sv-reviewed',
        date: '2026-09-20',
        co2: 720,
        status: '已复查',
        reviewNote: '人工复核通过',
        judgment: judge.judgeSurvey(survey({ date: '2026-09-20', co2: 720 }), [summer, autumn])
      })
    ]
  };
  // 先让 sv-reviewed 在旧口径下是超限→人工复查通过；sv-backfill 正常
  db.surveys[0].judgment = judge.judgeSurvey(db.surveys[0], db.baselines);

  // 月中补录一版 9月1日生效、CO2 上限收紧到 650 的基准
  const tightened = baseline('bl-tight', '2026-09-01T00:00', {
    temperature: { min: 15.2, max: 17.2 },
    humidity: { min: 87, max: 97 },
    co2: { min: 400, max: 650 }
  }, '2026-09-27T03:00:00.000Z');
  db.baselines.push(tightened);

  const result = judge.recalcSite(db, SITE, { at: '2026-09-27T04:00:00.000Z', reason: '基准登记重算' });
  assert.equal(result.total, 2);
  assert.equal(result.changed, 2);

  const [backfilled, reviewed] = db.surveys;
  // 9月5日的巡测改用补录版：720 > 650，正常被翻为待复查
  assert.equal(backfilled.judgment.baselineId, 'bl-tight');
  assert.equal(backfilled.status, '异常待复查');
  // 已复查记录同样重算，人工结论不能盖住新结果
  assert.equal(reviewed.status, '异常待复查');
  assert.equal(reviewed.judgment.result, '超限');
  assert.ok(reviewed.history[0].note.includes('人工复查结论不覆盖新结果'));
});

test('基准修订后按新限值重算', () => {
  const db = {
    baselines: [baseline('bl-only', '2026-06-01T00:00', {
      temperature: { min: 15, max: 17 },
      humidity: { min: 87, max: 97 },
      co2: { min: 400, max: 800 }
    })],
    surveys: [survey({ date: '2026-06-18', co2: 760, status: '正常' })]
  };
  db.surveys[0].judgment = judge.judgeSurvey(db.surveys[0], db.baselines);
  assert.equal(db.surveys[0].status, '正常');

  db.baselines[0].items = { ...db.baselines[0].items, co2: { min: 400, max: 700 } };
  const result = judge.recalcSite(db, SITE, { at: '2026-09-27T04:00:00.000Z', reason: '基准修订重算' });
  assert.equal(result.changed, 1);
  assert.equal(db.surveys[0].status, '异常待复查');
  assert.equal(db.surveys[0].judgment.items.co2.pass, false);
});

test('基准入参校验：限值缺失或下限大于上限要报错', () => {
  assert.deepEqual(judge.validateBaselinePayload({
    siteId: SITE,
    effectiveFrom: '2026-09-15T00:00',
    items: {
      temperature: { min: 15, max: 17 },
      humidity: { min: 87, max: 97 },
      co2: { min: 400, max: 800 }
    }
  }), []);

  const errors = judge.validateBaselinePayload({
    siteId: SITE,
    effectiveFrom: 'bad',
    items: {
      temperature: { min: 17, max: 15 },
      humidity: { min: 87 },
      co2: { min: 400, max: 800 }
    }
  });
  assert.ok(errors.some((text) => text.includes('生效时刻')));
  assert.ok(errors.some((text) => text.includes('下限不能大于上限')));
  assert.ok(errors.some((text) => text.includes('湿度')));
});
