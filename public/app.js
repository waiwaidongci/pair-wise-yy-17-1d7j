const state = {
  config: null,
  db: {},
  activeTab: '',
  editingId: null
};

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

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

// datetime-local 控件需要本地时区的 YYYY-MM-DDTHH:mm
function localDatetimeInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields, selectedId) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const step = field.step ? `step="${field.step}"` : '';
  const hint = field.hint ? `<small class="hint">${escapeHtml(field.hint)}</small>` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea>${hint}</label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select>${hint}</label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select>${hint}</label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${step} ${required}>${hint}</label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function detailValue(item, field) {
  if (field.type === 'relation') return relationLabel(field, item[field.name]);
  if (field.type === 'datetime') return fmtDate(item[field.name]);
  if (field.type === 'baselineMetric') {
    const base = Number(item[field.baseline]);
    const tol = Number(item[`${field.baseline}Tolerance`]);
    return `${base} ± ${tol}（${Math.round((base - tol) * 100) / 100} ~ ${Math.round((base + tol) * 100) / 100}）`;
  }
  return item[field.name];
}

// 巡测台账：展示采用的是哪版基准，以及温度/湿度/CO2 三项逐项结果
function judgmentHtml(item) {
  const j = item.judgment;
  if (!j) return '';
  if (j.missing) {
    return `<div class="judgment"><div class="judgment-head">${pill('无适用基准', 'bad')}<span class="meta">巡测当日没有生效的基准版本</span></div></div>`;
  }
  const chips = Object.values(j.items).map((metric) => `
    <div class="metric ${metric.inRange ? 'ok' : 'bad'}">
      <div class="metric-label">${escapeHtml(metric.label)} ${metric.inRange ? pill('在范围', 'ok') : pill('超限', 'bad')}</div>
      <div class="metric-value">${escapeHtml(metric.value)} ${escapeHtml(metric.unit)}</div>
      <div class="metric-range">范围 ${metric.min} ~ ${metric.max} ${escapeHtml(metric.unit)}<br>基准 ${metric.baseline} ± ${metric.tolerance}</div>
    </div>`).join('');
  const review = item.reviewedAt
    ? `<div class="review">人工复查：${escapeHtml(item.reviewNote || '已复核')}（${escapeHtml(item.reviewedBy || '-')}，${fmtDate(item.reviewedAt)}）</div>`
    : '';
  return `<div class="judgment">
    <div class="judgment-head">判定基准 ${pill(`${j.label}`, j.allInRange ? 'ok' : 'warn')}<span class="meta">${fmtDate(j.effectiveAt)} 生效 · 判定于 ${fmtDate(j.judgedAt)}</span></div>
    <div class="metric-grid">${chips}</div>
    ${review}
  </div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  let title;
  if (view.titlePrefix) {
    title = `${view.titlePrefix} v${item.versionNo}`;
  } else {
    title = (view.titleFields || []).map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  }
  const statusValue = view.statusField ? item[view.statusField] : '';
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const value = detailValue(item, field);
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');

  const actionButtons = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`);

  // 复查按钮只给“异常待复查”；状态由判定决定，前端不提供手工改判
  if (state.config.reviewAction && collection === state.config.reviewAction.collection &&
      (!view.actionStatusFilter || item.status === view.actionStatusFilter)) {
    actionButtons.push(`<button data-review="${item.id}">${escapeHtml(state.config.reviewAction.label)}</button>`);
  }
  if (view.revision) {
    actionButtons.push(`<button class="ghost" data-revise="${item.id}">修订</button>`);
  }
  const actions = actionButtons.join('');

  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${view.showJudgment ? judgmentHtml(item) : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)) ||
      (view.titlePrefix && `v${item.versionNo}`.includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  const statusFilter = view.statusField ? `
    <select id="status-${view.id}">
      <option value="">全部状态</option>
      ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
    </select>` : '<span></span>';
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions">
          <button type="submit" class="submit-btn">${escapeHtml(view.submitLabel || '保存')}</button>
          <button type="button" class="ghost cancel-edit" hidden>取消修订</button>
        </div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          ${statusFilter}
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view)).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
  state.editingId = null;
}

function startRevision(button) {
  const view = state.config.views.find((entry) => entry.collection === 'baselines');
  const form = $(`form[data-view="${view.id}"]`);
  const item = state.db.baselines.find((entry) => entry.id === button.dataset.revise);
  if (!item) return;
  for (const field of view.fields) {
    const input = form.elements[field.name];
    if (!input) continue;
    input.value = field.type === 'datetime-local' ? localDatetimeInput(item[field.name]) : (item[field.name] ?? '');
  }
  state.editingId = item.id;
  form.querySelector('.submit-btn').textContent = '保存修订并重算';
  form.querySelector('.cancel-edit').hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('已填入该版本内容，保存后按新版本重算受影响巡测');
}

function cancelRevision() {
  const view = state.config.views.find((entry) => entry.collection === 'baselines');
  const form = $(`form[data-view="${view.id}"]`);
  form.reset();
  state.editingId = null;
  form.querySelector('.submit-btn').textContent = view.submitLabel;
  form.querySelector('.cancel-edit').hidden = true;
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const revise = event.target.closest('[data-revise]');
  const review = event.target.closest('[data-review]');
  if (tab) setTab(tab.dataset.tab);
  if (revise) startRevision(revise);
  if (event.target.closest('.cancel-edit')) cancelRevision();
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (review) {
    const note = window.prompt('复查说明（三项按当前版本仍在范围时才能完成复查）', '异常已复核');
    if (note === null) return;
    try {
      await api(`/api/surveys/${review.dataset.review}/review`, {
        method: 'POST',
        body: JSON.stringify({ reviewNote: note })
      });
      await load();
      toast('复查完成');
    } catch (error) {
      await load();
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const payload = values(form, view);
  try {
    if (state.editingId) {
      const result = await api(`/api/${form.dataset.create}/${state.editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      cancelRevision();
      await load();
      toast(`修订完成，${result.recomputed || 0} 条受影响记录已重算`);
    } else {
      await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      await load();
      toast('已保存');
    }
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
