'use strict';

/**
 * 页面入口：看板 / 样点档案（含基准版本登记） / 巡测台账。
 * 判定口径在服务端 src/judge.js，这里只负责展示与提交。
 */
const state = {
  config: null,
  sites: [],
  baselines: [],
  surveys: [],
  tab: 'dashboard',
  editingBaselineId: null,
  expanded: new Set(),
  query: '',
  statusFilter: ''
};

const TABS = [
  { id: 'dashboard', label: '看板' },
  { id: 'sites', label: '样点档案' },
  { id: 'ledger', label: '巡测台账' }
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtStamp(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function todayInput() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nowLocalInput() {
  const now = new Date();
  return `${todayInput()}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function pill(value, extra = '') {
  return `<span class="pill ${toneFor(value)} ${extra}">${escapeHtml(value || '-')}</span>`;
}

function siteById(id) {
  return state.sites.find((site) => site.id === id);
}

function siteShort(id) {
  const site = siteById(id);
  return site ? `${site.pointCode} / ${site.zone}` : '样点已删除';
}

function siteFull(id) {
  const site = siteById(id);
  return site ? `${site.cave} · ${site.zone} · ${site.pointCode}` : '样点已删除';
}

function baselinesOf(siteId) {
  return state.baselines.filter((version) => version.siteId === siteId);
}

function limitsText(version) {
  return state.config.items
    .map((meta) => `${meta.label} ${version.items[meta.key].min}~${version.items[meta.key].max}${meta.unit}`)
    .join(' · ');
}

function historyHtml(item, limit = 5) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, limit).map((entry) => `
    <div class="history-item"><span>${fmtStamp(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function itemPill(survey, key) {
  const item = survey.judgment?.items?.[key];
  if (!item) return pill('缺基准', 'sm');
  const text = item.pass ? '在限' : '超限';
  return `<span title="限值 ${item.min} ~ ${item.max}">${pill(text, 'sm')}</span>`;
}

// ---------- 看板 ----------

function renderStats() {
  const pending = state.surveys.filter((survey) => survey.status === '异常待复查').length;
  const stats = [
    ['样点', state.sites.length],
    ['基准版本', state.baselines.length],
    ['巡测记录', state.surveys.length],
    ['异常待复查', pending]
  ];
  return `<div class="stats">${stats.map(([label, value]) => `
    <div class="stat"><span>${label}</span><strong>${value}</strong></div>
  `).join('')}</div>`;
}

function renderPendingCard(survey) {
  const items = state.config.items.map((meta) => {
    const detail = survey.judgment?.items?.[meta.key];
    const value = detail ? detail.value : survey[meta.key];
    return `<div>${meta.label}<br><strong>${escapeHtml(value ?? '-')}</strong> ${itemPill(survey, meta.key)}</div>`;
  }).join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(survey.date)} · ${escapeHtml(siteShort(survey.siteId))}</h3>${pill(survey.status)}</div>
    <div class="meta">${escapeHtml(siteFull(survey.siteId))} · 巡测人 ${escapeHtml(survey.surveyor)} · 采用 ${escapeHtml(survey.judgment?.baselineLabel || '无生效基准')}</div>
    ${survey.disturbance ? `<p>${escapeHtml(survey.disturbance)}</p>` : ''}
    <div class="detail">${items}</div>
    <div class="actions">
      <button data-survey-review="${survey.id}">登记复查</button>
      <button class="ghost" data-goto-ledger="${survey.id}">台账查看</button>
    </div>
  </article>`;
}

function renderDashboard() {
  const pending = state.surveys.filter((survey) => survey.status === '异常待复查');
  return `<section class="view" id="view-dashboard">
    ${renderStats()}
    <div class="panel">
      <h2>异常与复查</h2>
      <div class="list">${pending.length ? pending.map(renderPendingCard).join('') : '<div class="empty">暂无待复查事项</div>'}</div>
    </div>
  </section>`;
}

// ---------- 样点档案 + 基准版本 ----------

function renderSiteForm() {
  return `<form class="panel" id="form-site">
    <h2>新增样点</h2>
    <div class="form-grid">
      <label>洞穴<input name="cave" required></label>
      <label>分区<input name="zone" required></label>
      <label>样点编号<input name="pointCode" required></label>
      <label>巡测路线<input name="route" required></label>
      <label>敏感等级<select name="sensitivity">${state.config.sensitivities.map((option) => `<option>${option}</option>`).join('')}</select></label>
      <label>保护状态<select name="protectedStatus">${state.config.siteStatuses.map((option) => `<option>${option}</option>`).join('')}</select></label>
      <label class="wide">备注<textarea name="note"></textarea></label>
    </div>
    <div class="actions"><button>保存样点</button></div>
  </form>`;
}

function renderBaselineForm() {
  const editing = state.editingBaselineId
    ? state.baselines.find((version) => version.id === state.editingBaselineId)
    : null;
  const siteOptions = state.sites.map((site) => {
    const selected = editing && editing.siteId === site.id ? ' selected' : '';
    return `<option value="${site.id}"${selected}>${escapeHtml(site.cave)} / ${escapeHtml(site.zone)} / ${escapeHtml(site.pointCode)}</option>`;
  }).join('');
  const limitFields = state.config.items.map((meta) => {
    const limit = editing?.items?.[meta.key] || {};
    return `<label>${meta.label}下限<input type="number" step="any" name="${meta.key}.min" value="${limit.min ?? ''}" required></label>
      <label>${meta.label}上限<input type="number" step="any" name="${meta.key}.max" value="${limit.max ?? ''}" required></label>`;
  }).join('');
  return `<form class="panel" id="form-baseline" data-editing="${editing ? editing.id : ''}">
    <h2>${editing ? '修订基准版本' : '登记基准版本'}</h2>
    <div class="form-grid">
      <label class="wide">样点<select name="siteId" required>${siteOptions}</select></label>
      <label class="wide">生效时刻<input type="datetime-local" name="effectiveFrom" value="${editing ? escapeHtml(editing.effectiveFrom) : nowLocalInput()}" required></label>
      ${limitFields}
      <label class="wide">版本说明<input name="note" value="${escapeHtml(editing?.note || '')}" placeholder="如：秋季换季收紧"></label>
    </div>
    ${editing ? '<p class="hint">修订不改变所属样点；保存后按新口径重算该样点全部巡测与复查记录。</p>' : '<p class="hint">生效时刻决定巡测采用哪版基准；补录历史基准同样会触发重算。</p>'}
    <div class="actions">
      <button>${editing ? '保存修订' : '登记版本'}</button>
      ${editing ? '<button type="button" class="ghost" data-baseline-cancel>取消修订</button>' : ''}
    </div>
  </form>`;
}

function renderVersionRow(version) {
  return `<div class="version">
    <div class="version-head">
      <strong>${escapeHtml(version.effectiveFrom.replace('T', ' '))} 生效</strong>
      ${version.note ? `<span class="pill">${escapeHtml(version.note)}</span>` : ''}
    </div>
    <div class="meta">${escapeHtml(limitsText(version))}</div>
    <div class="inline-actions">
      <button class="ghost" data-baseline-edit="${version.id}">修订</button>
      <button class="ghost" data-baseline-delete="${version.id}">删除</button>
    </div>
  </div>`;
}

function renderSiteCard(site) {
  const versions = baselinesOf(site.id);
  const statusButtons = state.config.siteStatuses
    .filter((status) => status !== site.protectedStatus)
    .map((status) => `<button class="ghost" data-site-status="${status}" data-id="${site.id}">${status}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(site.pointCode)} / ${escapeHtml(site.zone)}</h3>${pill(site.protectedStatus)}</div>
    <div class="meta">${escapeHtml(site.cave)} · ${escapeHtml(site.route)} · 敏感等级 ${escapeHtml(site.sensitivity)}</div>
    ${site.note ? `<p>${escapeHtml(site.note)}</p>` : ''}
    <div class="versions">
      <div class="meta"><strong>基准版本（${versions.length}）</strong></div>
      ${versions.length ? versions.map(renderVersionRow).join('') : '<div class="empty">尚未登记基准版本，巡测将无法判定</div>'}
    </div>
    <div class="actions">
      ${statusButtons}
      <button class="ghost" data-site-recalc="${site.id}">重算巡测</button>
      <button class="danger" data-site-delete="${site.id}">删除样点</button>
    </div>
    ${historyHtml(site)}
  </article>`;
}

function renderSites() {
  return `<section class="view" id="view-sites">
    <div class="grid">
      <div class="form-stack">
        ${renderSiteForm()}
        ${renderBaselineForm()}
      </div>
      <div class="panel">
        <h2>样点列表</h2>
        <div class="list">${state.sites.length ? state.sites.map(renderSiteCard).join('') : '<div class="empty">暂无样点</div>'}</div>
      </div>
    </div>
  </section>`;
}

// ---------- 巡测台账 ----------

function renderSurveyForm() {
  const siteOptions = state.sites.map((site) =>
    `<option value="${site.id}">${escapeHtml(site.cave)} / ${escapeHtml(site.zone)} / ${escapeHtml(site.pointCode)}</option>`
  ).join('');
  return `<form class="panel" id="form-survey">
    <h2>登记巡测</h2>
    <div class="form-grid cols-3">
      <label class="wide">样点<select name="siteId" required>${siteOptions}</select></label>
      <label>巡测人员<input name="surveyor" required></label>
      <label>巡测日期<input type="date" name="date" value="${todayInput()}" required></label>
      <label>滴水频率(次/分)<input type="number" step="any" name="dripRate"></label>
      <label>温度(℃)<input type="number" step="any" name="temperature" required></label>
      <label>湿度(%)<input type="number" step="any" name="humidity" required></label>
      <label>CO2(ppm)<input type="number" step="any" name="co2" required></label>
      <label class="wide">照片链接<input name="photoUrl"></label>
      <label class="wide">游客干扰痕迹<textarea name="disturbance"></textarea></label>
    </div>
    <p class="hint">补录历史巡测时按巡测日期当天生效的基准版本判定，不按今天的限值。</p>
    <div class="actions"><button>保存巡测</button></div>
  </form>`;
}

function renderLedgerRow(survey) {
  const cells = state.config.items.map((meta) => {
    const detail = survey.judgment?.items?.[meta.key];
    const value = detail ? detail.value : survey[meta.key];
    return `<td><strong>${escapeHtml(value ?? '-')}</strong> ${itemPill(survey, meta.key)}</td>`;
  }).join('');
  const reviewButton = survey.status === '异常待复查'
    ? `<button data-survey-review="${survey.id}">复查</button>` : '';
  const expanded = state.expanded.has(survey.id);
  const expandRow = expanded ? `<tr class="expand-row"><td colspan="10">
      <div class="meta">巡测人 ${escapeHtml(survey.surveyor)} · 判定时间 ${fmtStamp(survey.judgment?.judgedAt)}${survey.reviewNote ? ` · 复查结论：${escapeHtml(survey.reviewNote)}` : ''}${survey.disturbance ? ` · 干扰：${escapeHtml(survey.disturbance)}` : ''}</div>
      ${historyHtml(survey, 8)}
    </td></tr>` : '';
  return `<tr>
    <td>${escapeHtml(survey.date)}</td>
    <td>${escapeHtml(siteShort(survey.siteId))}</td>
    <td>${escapeHtml(survey.surveyor)}</td>
    ${cells}
    <td class="baseline-cell">${escapeHtml(survey.judgment?.baselineLabel || '无生效基准')}</td>
    <td>${pill(survey.judgment?.result || '缺基准')}</td>
    <td>${pill(survey.status)}</td>
    <td class="table-actions">
      ${reviewButton}
      <button class="ghost" data-survey-toggle="${survey.id}">${expanded ? '收起' : '履历'}</button>
      <button class="ghost" data-survey-delete="${survey.id}">删除</button>
    </td>
  </tr>${expandRow}`;
}

function renderLedgerTable() {
  const query = state.query.trim();
  let rows = [...state.surveys];
  if (state.statusFilter) rows = rows.filter((survey) => survey.status === state.statusFilter);
  if (query) {
    rows = rows.filter((survey) =>
      [survey.surveyor, survey.disturbance, survey.date, siteFull(survey.siteId)]
        .some((text) => String(text || '').includes(query)));
  }
  if (!rows.length) return '<div class="empty">暂无巡测记录</div>';
  const itemHeads = state.config.items.map((meta) => `<th>${meta.label}</th>`).join('');
  return `<table class="ledger">
    <thead><tr>
      <th>日期</th><th>样点</th><th>人员</th>${itemHeads}<th>采用基准</th><th>判定</th><th>状态</th><th>操作</th>
    </tr></thead>
    <tbody>${rows.map(renderLedgerRow).join('')}</tbody>
  </table>`;
}

function renderLedger() {
  const statusOptions = ['正常', '异常待复查', '已复查']
    .map((option) => `<option${state.statusFilter === option ? ' selected' : ''}>${option}</option>`).join('');
  return `<section class="view" id="view-ledger">
    ${renderSurveyForm()}
    <div class="panel">
      <h2>巡测台账</h2>
      <div class="toolbar">
        <input id="ledger-search" placeholder="搜索人员、干扰痕迹、日期、样点" value="${escapeHtml(state.query)}">
        <select id="ledger-status">
          <option value="">全部状态</option>
          ${statusOptions}
        </select>
      </div>
      <div id="ledger-table">${renderLedgerTable()}</div>
    </div>
  </section>`;
}

// ---------- 渲染与事件 ----------

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#tabs').innerHTML = TABS.map((tab) =>
    `<button class="tab${state.tab === tab.id ? ' active' : ''}" data-tab="${tab.id}">${tab.label}</button>`
  ).join('');
  $('#main').innerHTML = renderDashboard() + renderSites() + renderLedger();
  setTab(state.tab);
}

function setTab(tabId) {
  state.tab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${tabId}`));
}

async function load() {
  const data = await api('/api/state');
  state.sites = data.sites;
  state.baselines = data.baselines;
  state.surveys = data.surveys;
  render();
}

async function run(action) {
  try {
    await action();
    await load();
  } catch (error) {
    toast(error.message);
  }
}

function recalcToast(prefix, recalc) {
  return recalc ? `${prefix}，重算巡测 ${recalc.changed}/${recalc.total} 条` : prefix;
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-tab],[data-site-status],[data-site-recalc],[data-site-delete],[data-baseline-edit],[data-baseline-cancel],[data-baseline-delete],[data-survey-review],[data-survey-toggle],[data-survey-delete],[data-goto-ledger]');
  if (!target) return;
  const data = target.dataset;

  if (data.tab) return setTab(data.tab);
  if (data.gotoLedger) {
    state.expanded.add(data.gotoLedger);
    setTab('ledger');
    $('#ledger-table').innerHTML = renderLedgerTable();
    return;
  }
  if (target.hasAttribute('data-baseline-cancel')) {
    state.editingBaselineId = null;
    return render();
  }
  if (data.baselineEdit) {
    state.editingBaselineId = data.baselineEdit;
    render();
    setTab('sites');
    $('#form-baseline')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (data.siteStatus) {
    return run(async () => {
      await api(`/api/sites/${data.id}/status`, { method: 'POST', body: JSON.stringify({ status: data.siteStatus }) });
      toast('保护状态已更新');
    });
  }
  if (data.siteRecalc) {
    return run(async () => {
      const result = await api(`/api/sites/${data.siteRecalc}/recalc`, { method: 'POST' });
      toast(recalcToast('重算完成', result.recalc));
    });
  }
  if (data.siteDelete) {
    if (!confirm('删除该样点及其全部基准版本？已有巡测的样点会被拒绝。')) return;
    return run(async () => {
      await api(`/api/sites/${data.siteDelete}`, { method: 'DELETE' });
      toast('样点已删除');
    });
  }
  if (data.baselineDelete) {
    if (!confirm('删除该基准版本？相关巡测将按剩余版本重算。')) return;
    return run(async () => {
      const result = await api(`/api/baselines/${data.baselineDelete}`, { method: 'DELETE' });
      toast(recalcToast('基准版本已删除', result.recalc));
    });
  }
  if (data.surveyReview) {
    const note = prompt('复查结论（人工结论不覆盖后续基准重算结果）', '现场复核无异常');
    if (note === null) return;
    return run(async () => {
      await api(`/api/surveys/${data.surveyReview}/review`, { method: 'POST', body: JSON.stringify({ note }) });
      toast('复查已登记');
    });
  }
  if (data.surveyToggle) {
    if (state.expanded.has(data.surveyToggle)) state.expanded.delete(data.surveyToggle);
    else state.expanded.add(data.surveyToggle);
    $('#ledger-table').innerHTML = renderLedgerTable();
    return;
  }
  if (data.surveyDelete) {
    if (!confirm('删除该巡测记录？')) return;
    return run(async () => {
      await api(`/api/surveys/${data.surveyDelete}`, { method: 'DELETE' });
      toast('巡测已删除');
    });
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'ledger-search') {
    state.query = event.target.value;
    $('#ledger-table').innerHTML = renderLedgerTable();
  }
  if (event.target.id === 'ledger-status') {
    state.statusFilter = event.target.value;
    $('#ledger-table').innerHTML = renderLedgerTable();
  }
});

function formValues(form, numericFields) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const name of numericFields) {
    if (payload[name] !== undefined && payload[name] !== '') payload[name] = Number(payload[name]);
  }
  return payload;
}

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();

  if (form.id === 'form-site') {
    return run(async () => {
      await api('/api/sites', { method: 'POST', body: JSON.stringify(formValues(form, [])) });
      toast('样点已保存');
    });
  }

  if (form.id === 'form-baseline') {
    const raw = Object.fromEntries(new FormData(form).entries());
    const items = {};
    for (const meta of state.config.items) {
      items[meta.key] = { min: Number(raw[`${meta.key}.min`]), max: Number(raw[`${meta.key}.max`]) };
    }
    const payload = { siteId: raw.siteId, effectiveFrom: raw.effectiveFrom, items, note: raw.note || '' };
    const editingId = form.dataset.editing;
    return run(async () => {
      const result = editingId
        ? await api(`/api/baselines/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/baselines', { method: 'POST', body: JSON.stringify(payload) });
      state.editingBaselineId = null;
      toast(recalcToast(editingId ? '基准版本已修订' : '基准版本已登记', result.recalc));
    });
  }

  if (form.id === 'form-survey') {
    const payload = formValues(form, ['temperature', 'humidity', 'co2', 'dripRate']);
    return run(async () => {
      const survey = await api('/api/surveys', { method: 'POST', body: JSON.stringify(payload) });
      toast(survey.judgment?.pass ? '巡测已保存，判定：正常' : `巡测已保存，判定：${survey.judgment?.result || '超限'}，已转待复查`);
    });
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  await load();
}

boot().catch((error) => toast(error.message));
