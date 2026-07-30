/**
 * views/train.js — 5단계: 학습 실행/감시
 *
 * 학습은 API 와 분리된 자식 프로세스에서 돈다. 그래서 이 화면은 "시작 버튼" 이
 * 아니라 **감시 콘솔**로 만들었다. 진행률·지표·로그를 3초마다 갱신하고, 중단과
 * 이어서(resume)를 같은 자리에 둔다.
 *
 * 기본값은 `test/yolo.py` 에서 검증된 값이고 기본 가중치는 `yolo26l-obb.pt` 다.
 * `workers` 는 Windows 에서 4 이하를 권장한다(spawn 워커마다 RAM 을 물어 후반
 * epoch 에서 DataLoader 가 죽는다).
 */

import { api } from '../api.js';
import {
  $,
  badge,
  bar,
  confirmAction,
  esc,
  fail,
  fmtWhen,
  num,
  ok,
  on,
  pct,
  toast,
} from '../util.js';

const LIVE = ['starting', 'running'];

export async function render(view, params, app) {
  const preDataset = params[0] === 'new' ? params[1] : null;
  const openRun = params[0] && params[0] !== 'new' ? params[0] : null;

  let runs = [];
  let selected = openRun;
  let timer = null;
  let disposed = false;
  const td = (app.meta && app.meta.defaults && app.meta.defaults.train) || {};

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>5 · 학습</h1>
        <div class="sub">데이터셋 + 가중치를 골라 학습한다. 학습은 별도 프로세스에서 돌아 API 를 막지 않는다.</div>
      </div>
      <div class="grow"></div>
      <a class="btn ghost" href="#/datasets">← 데이터셋</a>
      <a class="btn ghost" href="#/models">모델 →</a>
    </div>

    <div class="card">
      <div class="card-head"><h2>학습 시작</h2></div>
      <div class="field-row">
        <label style="flex:2 1 240px">데이터셋
          <select id="t-dataset"></select>
        </label>
        <label style="flex:2 1 240px">사전학습 가중치
          <select id="t-model"></select>
        </label>
      </div>
      <div class="field-row" style="margin-top:8px">
        <label>epochs <input type="number" id="t-epochs" min="1" value="${td.epochs || 100}" /></label>
        <label>imgsz <input type="number" id="t-imgsz" step="32" min="32" value="${td.imgsz || 640}" /></label>
        <label>batch <input type="number" id="t-batch" min="1" value="${td.batch || 16}" /></label>
        <label>workers <input type="number" id="t-workers" min="0" value="${td.workers ?? 4}" /></label>
        <label>patience <input type="number" id="t-patience" min="1" value="${td.patience || 50}" /></label>
        <label>device <input type="text" id="t-device" placeholder="${esc(
          (app.meta && app.meta.device) || '0',
        )}" /></label>
      </div>
      <label style="margin-top:8px">메모 <input type="text" id="t-note" placeholder="무엇을 검증하려는 실험인지" /></label>
      <div id="t-warn" style="margin-top:8px"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="t-start">학습 시작</button>
        <span class="mute2" id="t-hint"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>학습 run</h2>
        <span class="muted" id="run-count"></span>
        <div class="grow"></div>
        <span class="mute2" id="tick"></span>
      </div>
      <div class="table-wrap" id="run-list"></div>
    </div>

    <div class="card hidden" id="detail-card">
      <div class="card-head">
        <h2 id="detail-title">run 상세</h2>
        <div class="grow"></div>
        <button class="btn sm ghost" id="detail-close">닫기</button>
      </div>
      <div id="detail"></div>
    </div>
  `;

  // ── 시작 폼 ───────────────────────────────────────────────────────
  async function fillForm() {
    try {
      const [{ items: datasets }, models] = await Promise.all([api.datasets.list(), api.models.list()]);
      $('#t-dataset', view).innerHTML = datasets.length
        ? datasets
            .map(
              (d) =>
                `<option value="${esc(d.dataset_id)}" data-task="${esc(d.task)}" ${
                  d.dataset_id === preDataset ? 'selected' : ''
                }>${esc(d.name)} · ${esc(d.task)} · ${d.total_frames}장</option>`,
            )
            .join('')
        : '<option value="">데이터셋이 없습니다</option>';

      const weights = models.weights || [];
      $('#t-model', view).innerHTML = [
        `<option value="">기본 (${esc(models.default_model || '')})</option>`,
        ...weights.map(
          (w) =>
            `<option value="${esc(w.path || w.abs_path)}" data-task="${esc(w.task || '')}">${esc(
              w.name,
            )} — ${esc(w.origin)}${w.task ? ` (${esc(w.task)})` : ''}</option>`,
        ),
      ].join('');
      checkTask();
    } catch (e) {
      fail('선택 목록', e);
    }
  }

  /** 모델 태스크와 데이터셋 태스크가 어긋나면 학습 직후 실패한다. 미리 경고한다. */
  function checkTask() {
    const dsOpt = $('#t-dataset', view).selectedOptions[0];
    const mOpt = $('#t-model', view).selectedOptions[0];
    const dsTask = dsOpt && dsOpt.dataset.task;
    const mTask = mOpt && mOpt.dataset.task;
    const box = $('#t-warn', view);
    if (dsTask && mTask && dsTask !== mTask) {
      box.innerHTML = `<div class="note">데이터셋 태스크(<b>${esc(dsTask)}</b>)와 가중치 태스크(<b>${esc(
        mTask,
      )}</b>)가 다릅니다. 회전박스 데이터셋은 OBB 가중치로만 학습됩니다.</div>`;
    } else {
      box.innerHTML = '';
    }
  }
  $('#t-dataset', view).addEventListener('change', checkTask);
  $('#t-model', view).addEventListener('change', checkTask);

  $('#t-start', view).addEventListener('click', async () => {
    const datasetId = $('#t-dataset', view).value;
    if (!datasetId) {
      toast('먼저 데이터셋을 만드세요', 'bad');
      return;
    }
    const spec = {
      dataset_id: datasetId,
      epochs: Number($('#t-epochs', view).value),
      imgsz: Number($('#t-imgsz', view).value),
      batch: Number($('#t-batch', view).value),
      workers: Number($('#t-workers', view).value),
      patience: Number($('#t-patience', view).value),
      note: $('#t-note', view).value.trim() || undefined,
    };
    const model = $('#t-model', view).value;
    if (model) spec.model = model;
    const device = $('#t-device', view).value.trim();
    if (device) spec.device = device;

    const btn = $('#t-start', view);
    btn.disabled = true;
    try {
      const res = await api.train.start(spec);
      ok(`학습 시작: ${res.run_id}`);
      (res.warnings || []).forEach((w) => toast(w));
      selected = res.run_id;
      await refresh();
      showDetail(selected);
    } catch (e) {
      fail('학습 시작', e);
    } finally {
      btn.disabled = false;
    }
  });

  // ── run 목록 ─────────────────────────────────────────────────────
  function runRow(r) {
    const live = LIVE.includes(r.status);
    const kind = { done: 'ok', error: 'bad', stopped: 'warn', unknown: 'warn' }[r.status] || 'info';
    const map50 = r.metrics ? r.metrics['metrics/mAP50(B)'] : null;
    return `<tr data-id="${esc(r.run_id)}" class="${r.run_id === selected ? 'selected' : ''}">
      <td>
        <b class="mono">${esc(r.run_id)}</b>
        <div class="mute2" style="font-size:11.5px">${esc(r.dataset_name || r.dataset_id || '')} · ${esc(
      r.model_name || '',
    )}</div>
      </td>
      <td>${badge(r.status, kind)}${r.task ? ` ${badge(r.task, '')}` : ''}</td>
      <td style="min-width:130px">
        ${bar(r.progress, r.status === 'done' ? 'ok' : '')}
        <div class="mute2 mono" style="font-size:11px">${r.epoch}/${r.epochs} · ${pct(r.progress)}</div>
      </td>
      <td class="num">${map50 !== null && map50 !== undefined ? num(map50, 3) : '-'}</td>
      <td class="mute2 mono">${fmtWhen(r.created_at)}</td>
      <td class="right nowrap">
        <button class="btn sm ghost" data-detail="${esc(r.run_id)}">상세</button>
        ${live ? `<button class="btn sm danger" data-stop="${esc(r.run_id)}">중단</button>` : ''}
        ${!live && r.epoch > 0 && r.status !== 'done' ? `<button class="btn sm" data-resume="${esc(r.run_id)}">이어서</button>` : ''}
        ${!live ? `<button class="btn sm ghost" data-del="${esc(r.run_id)}">삭제</button>` : ''}
      </td>
    </tr>`;
  }

  async function refresh() {
    try {
      const doc = await api.train.list();
      runs = doc.items || [];
    } catch (e) {
      return;
    }
    if (disposed) return;
    $('#run-count', view).textContent = `${runs.length}개`;
    $('#run-list', view).innerHTML = runs.length
      ? `<table><thead><tr>
           <th>run</th><th>상태</th><th>진행</th><th class="num">mAP50</th><th>시작</th><th></th>
         </tr></thead><tbody>${runs.map(runRow).join('')}</tbody></table>`
      : '<div class="empty">학습 기록이 없습니다.</div>';
    $('#tick', view).textContent = `갱신 ${new Date().toLocaleTimeString('ko-KR')}`;
    if (selected) await renderDetail();
  }

  // ── 상세 ─────────────────────────────────────────────────────────
  function metricsTable(metrics) {
    const rows = Object.entries(metrics || {});
    if (!rows.length) return '<div class="mute2">아직 지표가 없습니다(첫 검증 이후 표시).</div>';
    return `<div class="table-wrap"><table><tbody>${rows
      .map(
        ([k, v]) =>
          `<tr><td class="mute2">${esc(k)}</td><td class="num">${
            typeof v === 'number' ? num(v, 5) : esc(v)
          }</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  }

  async function renderDetail() {
    let st;
    try {
      st = await api.train.status(selected, 300);
    } catch (e) {
      $('#detail', view).innerHTML = `<div class="note">${esc(e.message)}</div>`;
      return;
    }
    if (disposed) return;
    const spec = st.spec || {};
    const live = LIVE.includes(st.status);
    const logBox = $('#detail .log', view);
    const keepScroll = logBox ? logBox.scrollTop >= logBox.scrollHeight - logBox.clientHeight - 30 : true;

    $('#detail-title', view).innerHTML = `${esc(selected)} ${badge(
      st.status,
      { done: 'ok', error: 'bad' }[st.status] || 'info',
    )}`;
    $('#detail', view).innerHTML = `
      <div class="stats" style="margin-bottom:12px">
        <div class="stat"><b>${st.epoch}/${st.epochs}</b><span>epoch</span></div>
        <div class="stat"><b>${pct(st.progress)}</b><span>진행</span></div>
        <div class="stat"><b>${esc(spec.dataset_task || '-')}</b><span>태스크</span></div>
        <div class="stat"><b>${esc(spec.model_name || '-')}</b><span>기반 가중치</span></div>
        <div class="stat"><b>${num(st.best_fitness, 4)}</b><span>best fitness</span></div>
      </div>
      ${bar(st.progress, st.status === 'done' ? 'ok' : '')}
      ${st.error ? `<div class="note" style="margin-top:10px">${esc(st.error)}</div>` : ''}

      <div class="row" style="margin-top:12px">
        ${live ? `<button class="btn danger" data-stop="${esc(selected)}">중단</button>` : ''}
        ${!live && st.weights.last ? `<button class="btn" data-resume="${esc(selected)}">이어서 학습</button>` : ''}
        ${
          st.weights.best
            ? `<a class="btn ghost" href="${esc(api.train.weightsUrl(selected, 'best'))}">best.pt 내려받기</a>`
            : ''
        }
        <div class="grow"></div>
        ${
          st.weights.best
            ? `<input type="text" id="pr-alias" placeholder="승격 이름 (예: drone-obb-v1)" style="width:190px" />
               <label class="row tight" style="align-items:center;margin:0">
                 <input type="checkbox" id="pr-deploy" /><span class="mute2">추론 서비스로 배포</span>
               </label>
               <button class="btn ok" id="promote">승격</button>`
            : ''
        }
      </div>

      <div class="grid cols-2" style="margin-top:14px">
        <div>
          <h3>최근 지표</h3>
          ${metricsTable(st.metrics)}
          <h3 style="margin-top:12px">설정</h3>
          <div class="mute2 mono" style="font-size:11.5px">
            데이터셋 ${esc(spec.dataset_name || '')} (${esc(spec.dataset_id || '')})<br />
            epochs ${spec.epochs} · imgsz ${spec.imgsz} · batch ${spec.batch} ·
            workers ${spec.workers} · device ${esc(String(spec.device))}<br />
            프레임 ${JSON.stringify(spec.frames || {})}<br />
            ${spec.note ? `메모: ${esc(spec.note)}` : ''}
          </div>
        </div>
        <div>
          <h3>로그 <span class="mute2" style="font-weight:400">(자동 갱신)</span></h3>
          <pre class="log">${esc(st.log_tail || '(로그 없음)')}</pre>
        </div>
      </div>`;

    const newLog = $('#detail .log', view);
    if (newLog && keepScroll) newLog.scrollTop = newLog.scrollHeight;

    const promoteBtn = $('#promote', view);
    if (promoteBtn) {
      promoteBtn.addEventListener('click', async () => {
        const alias = $('#pr-alias', view).value.trim();
        if (!alias) {
          toast('승격 이름을 입력하세요', 'bad');
          return;
        }
        try {
          const entry = await api.models.promote({
            run_id: selected,
            alias,
            which: 'best',
            deploy: $('#pr-deploy', view).checked,
          });
          ok(`승격 완료: ${entry.alias} (${entry.size_mb} MB)${entry.deployed_to ? ' · 배포됨' : ''}`);
        } catch (e) {
          fail('승격', e);
        }
      });
    }
  }

  function showDetail(runId) {
    selected = runId;
    $('#detail-card', view).classList.remove('hidden');
    renderDetail();
    refresh();
  }

  $('#detail-close', view).addEventListener('click', () => {
    selected = null;
    $('#detail-card', view).classList.add('hidden');
  });

  on(view, 'click', '[data-detail]', (e, el) => showDetail(el.dataset.detail));
  on(view, 'click', '[data-stop]', async (e, el) => {
    if (!confirmAction('학습을 중단합니다. 이후 last.pt 부터 이어서 할 수 있습니다.')) return;
    try {
      const res = await api.train.stop(el.dataset.stop);
      toast(res.stopped ? '중단했습니다' : res.reason || '실행 중이 아닙니다');
      await refresh();
    } catch (e2) {
      fail('중단', e2);
    }
  });
  on(view, 'click', '[data-resume]', async (e, el) => {
    try {
      await api.train.resume(el.dataset.resume);
      ok('이어서 학습을 시작했습니다');
      await refresh();
    } catch (e2) {
      fail('이어서', e2);
    }
  });
  on(view, 'click', '[data-del]', async (e, el) => {
    if (!confirmAction(`run ${el.dataset.del} 을 지웁니다(가중치 포함). 승격한 모델은 남습니다.`)) return;
    try {
      await api.train.del(el.dataset.del);
      if (selected === el.dataset.del) {
        selected = null;
        $('#detail-card', view).classList.add('hidden');
      }
      ok('삭제했습니다');
      await refresh();
    } catch (e2) {
      fail('삭제', e2);
    }
  });

  await fillForm();
  await refresh();
  if (openRun) showDetail(openRun);
  // 학습은 몇 시간짜리다. 열어둔 화면이 스스로 갱신되어야 감시 콘솔 역할을 한다.
  timer = setInterval(refresh, 3000);

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
