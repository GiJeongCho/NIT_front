/**
 * views/datasets.js — 4단계: 학습 전 데이터셋 만들기/관리
 *
 * 산출물은 `tracker_py/train_data/preprocessed_obb` 와 같은 구조다
 * (`data.yaml` + `{train,valid,test}/{images,labels}`). 이 화면이 하는 일은 셋이다.
 *
 * 1. **빌드**: 검수 완료된 프레임을 모아 새 데이터셋을 만든다.
 * 2. **등록**: 이미 있는 그 구조의 폴더를 그대로 목록에 올린다(복사 없이 학습 가능).
 * 3. **병합**: 빌드할 때 기존 데이터셋을 같이 넣는다. 기존 5,834장 + 새로 라벨한
 *    프레임으로 학습하는 것이 실제 운용 흐름이다.
 *
 * 클래스는 인덱스가 아니라 **이름**으로 매핑되므로, 서로 다른 출처를 합쳐도 정답이
 * 뒤바뀌지 않는다(서버가 매핑 표를 manifest 에 남긴다).
 */

import { api, pollJob } from '../api.js';
import {
  $,
  $$,
  badge,
  bar,
  confirmAction,
  esc,
  fail,
  fmtWhen,
  histogram,
  ok,
  on,
  toast,
} from '../util.js';

export async function render(view, params, app) {
  let datasets = [];
  let videos = [];
  let jobId = null;
  let disposed = false;
  const defaults = (app.meta && app.meta.defaults && app.meta.defaults.dataset) || {};
  const splits = defaults.splits || { train: 0.8, valid: 0.15, test: 0.05 };

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>4 · 데이터셋</h1>
        <div class="sub">
          검수된 라벨 → YOLO 학습 구조. 기존 <code>train_data</code> 폴더를 등록하거나 합칠 수 있다.
        </div>
      </div>
      <div class="grow"></div>
      <button class="btn ghost" id="reload">새로고침</button>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h2>새 데이터셋 빌드</h2></div>
        <div class="field-row">
          <label style="flex:2 1 200px">이름
            <input type="text" id="ds-name" placeholder="drone-obb-v1" />
          </label>
          <label>태스크
            <select id="ds-task">
              <option value="obb">obb — 회전박스 (8좌표)</option>
              <option value="detect">detect — 축정렬 (cxcywh)</option>
            </select>
          </label>
        </div>

        <label style="margin-top:8px">영상 (선택 안 하면 전체 · Ctrl 로 다중 선택)
          <select id="ds-videos" multiple size="5"></select>
        </label>

        <label style="margin-top:8px">같이 넣을 기존 데이터셋 (병합 · 원래 분할 유지)
          <select id="ds-base" multiple size="4"></select>
        </label>
        <label style="margin-top:6px">또는 폴더 경로 직접 입력 (줄바꿈으로 여러 개)
          <textarea id="ds-base-paths" placeholder="C:\\project\\tracker_py\\train_data\\preprocessed_obb"></textarea>
        </label>

        <div class="field-row" style="margin-top:8px">
          <label>train
            <input type="number" id="ds-train" step="0.05" min="0" max="1" value="${splits.train}" />
          </label>
          <label>valid
            <input type="number" id="ds-valid" step="0.05" min="0" max="1" value="${splits.valid}" />
          </label>
          <label>test
            <input type="number" id="ds-test" step="0.05" min="0" max="1" value="${splits.test}" />
          </label>
        </div>
        <div class="field-row">
          <label>분할 방식
            <select id="ds-mode">
              <option value="chunk">chunk — 연속 프레임 블록 (누수 방지, 기본)</option>
              <option value="random">random — 완전 무작위</option>
              <option value="video">video — 영상 단위</option>
            </select>
          </label>
          <label>블록 크기
            <input type="number" id="ds-chunk" min="1" value="${defaults.chunk_size || 30}" />
          </label>
          <label>seed
            <input type="number" id="ds-seed" value="0" />
          </label>
        </div>
        <label class="row tight" style="margin-top:8px;align-items:center">
          <input type="checkbox" id="ds-approved" ${defaults.only_approved === false ? '' : 'checked'} />
          <span>승인된 프레임만 넣기 (권장)</span>
        </label>

        <div class="note info" style="margin-top:10px">
          <b>chunk</b> 분할이 기본인 이유: 인접 프레임은 사실상 같은 그림이다. 무작위로 나누면
          train 과 valid 에 같은 장면이 들어가 검증 점수가 부풀려진다.
        </div>

        <div class="row" style="margin-top:10px">
          <button class="btn primary grow" id="build">빌드 시작</button>
          <button class="btn ghost hidden" id="cancel-job">취소</button>
        </div>
        <div id="job" style="margin-top:10px"></div>
      </div>

      <div class="col">
        <div class="card">
          <div class="card-head"><h2>기존 YOLO 폴더 등록</h2></div>
          <p class="muted" style="font-size:12.5px">
            이미 완성된 학습 전 구조를 그대로 올린다. 다시 만들지 않고 바로 학습에 쓸 수 있다.
          </p>
          <div class="row">
            <input type="text" id="imp-path" class="grow"
                   placeholder="C:\\project\\tracker_py\\train_data\\preprocessed_obb" />
            <button class="btn" id="imp-check">확인</button>
          </div>
          <div id="imp-info" style="margin-top:8px"></div>
          <div class="field-row" style="margin-top:8px">
            <label style="flex:2 1 160px">이름
              <input type="text" id="imp-name" placeholder="(생략 시 폴더 이름)" />
            </label>
            <label class="row tight" style="align-items:center;flex:1 1 160px">
              <input type="checkbox" id="imp-copy" />
              <span>워크스페이스로 복사(스냅샷 고정)</span>
            </label>
          </div>
          <button class="btn primary" id="imp-run" style="margin-top:8px" disabled>등록</button>
          <div class="note" style="margin-top:10px">
            복사하지 않으면 원본 폴더를 그대로 참조한다(수천 장 중복 저장 방지).
            대신 원본이 바뀌면 데이터셋도 바뀐다 — 실험을 고정하려면 복사를 켠다.
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>클래스 (순서 = 학습 클래스 id)</h3>
          </div>
          <div id="class-list" class="row tight"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>데이터셋 목록</h2>
        <span class="muted" id="ds-count"></span>
      </div>
      <div class="table-wrap" id="list"></div>
    </div>

    <div class="card hidden" id="detail-card">
      <div class="card-head">
        <h2 id="detail-title">상세</h2>
        <div class="grow"></div>
        <button class="btn sm ghost" id="detail-close">닫기</button>
      </div>
      <div id="detail"></div>
    </div>
  `;

  function renderClasses() {
    $('#class-list', view).innerHTML = app.classes
      .map((n, i) => `<span class="badge info mono">${i} · ${esc(n)}</span>`)
      .join('');
  }

  async function reload() {
    try {
      [datasets, videos] = await Promise.all([
        api.datasets.list().then((d) => d.items || []),
        api.videos.list().then((d) => d.items || []),
      ]);
    } catch (e) {
      fail('목록 조회', e);
      return;
    }

    $('#ds-videos', view).innerHTML = videos
      .map((v) => {
        const lab = v.labeling || {};
        return `<option value="${esc(v.video_id)}" ${v.video_id === app.videoId ? 'selected' : ''}>
          ${esc(v.original_name)} — 승인 ${lab.approved || 0}/${lab.frames || 0}
        </option>`;
      })
      .join('');

    $('#ds-base', view).innerHTML = datasets
      .map(
        (d) =>
          `<option value="${esc(d.dataset_id)}">${esc(d.name)} · ${esc(d.task)} · ${
            d.total_frames
          }장${d.imported ? ' (등록)' : ''}</option>`,
      )
      .join('');

    $('#ds-count', view).textContent = `${datasets.length}개`;
    $('#list', view).innerHTML = datasets.length
      ? `<table>
          <thead><tr>
            <th>이름</th><th>태스크</th><th class="num">train</th><th class="num">valid</th>
            <th class="num">test</th><th class="num">객체</th><th>클래스</th><th>생성</th><th></th>
          </tr></thead>
          <tbody>${datasets.map(row).join('')}</tbody>
        </table>`
      : '<div class="empty">데이터셋이 없습니다. 왼쪽에서 빌드하거나 기존 폴더를 등록하세요.</div>';
    renderClasses();
  }

  function row(d) {
    const c = d.counts || {};
    return `<tr data-id="${esc(d.dataset_id)}">
      <td>
        <b>${esc(d.name)}</b>
        ${d.imported ? badge('등록', 'info') : ''}
        ${d.n_sources ? badge(`병합 ${d.n_sources}`, '') : ''}
        ${(d.warnings || []).length ? badge('경고', 'warn') : ''}
        <div class="mute2 mono" style="font-size:10.5px">${esc(d.dataset_id)}</div>
      </td>
      <td>${badge(d.task, d.task === 'obb' ? 'info' : '')}</td>
      <td class="num">${c.train ?? '-'}</td>
      <td class="num">${c.valid ?? '-'}</td>
      <td class="num">${c.test ?? '-'}</td>
      <td class="num">${d.total_objects ?? '-'}</td>
      <td class="mute2">${(d.class_names || []).length}개</td>
      <td class="mute2 mono">${fmtWhen(d.created_at)}</td>
      <td class="right nowrap">
        <button class="btn sm ghost" data-detail="${esc(d.dataset_id)}">상세</button>
        <button class="btn sm" data-train="${esc(d.dataset_id)}">학습 →</button>
        <button class="btn sm ghost" data-del="${esc(d.dataset_id)}">삭제</button>
      </td>
    </tr>`;
  }

  // ── 빌드 ─────────────────────────────────────────────────────────
  function renderJob(j) {
    const box = $('#job', view);
    if (!j) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `${bar(j.progress, j.status === 'done' ? 'ok' : '')}
      <div class="mute2 mono" style="margin-top:4px;font-size:11.5px">
        ${esc(j.status)} ${j.done}/${j.total || '?'} · ${esc(j.message || '')}
      </div>
      ${j.error ? `<div class="note" style="margin-top:6px">${esc(j.error)}</div>` : ''}`;
  }

  $('#build', view).addEventListener('click', async () => {
    const pickedVideos = $$('#ds-videos option:checked', view).map((o) => o.value);
    const baseIds = $$('#ds-base option:checked', view).map((o) => o.value);
    const basePaths = $('#ds-base-paths', view)
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const base = [...baseIds, ...basePaths];

    const spec = {
      name: $('#ds-name', view).value.trim() || undefined,
      task: $('#ds-task', view).value,
      splits: {
        train: Number($('#ds-train', view).value),
        valid: Number($('#ds-valid', view).value),
        test: Number($('#ds-test', view).value),
      },
      split_mode: $('#ds-mode', view).value,
      chunk_size: Number($('#ds-chunk', view).value),
      seed: Number($('#ds-seed', view).value),
      only_approved: $('#ds-approved', view).checked,
    };
    // 영상을 하나도 고르지 않았고 병합 소스가 있으면 "기존 데이터셋만" 이라는 뜻이다.
    if (pickedVideos.length) spec.video_ids = pickedVideos;
    else if (base.length) spec.video_ids = [];
    if (base.length) spec.base_datasets = base;

    const btn = $('#build', view);
    btn.disabled = true;
    $('#cancel-job', view).classList.remove('hidden');
    try {
      const started = await api.datasets.create(spec);
      jobId = started.job_id;
      const final = await pollJob(jobId, (j) => !disposed && renderJob(j));
      if (final.status === 'done') {
        const m = final.result || {};
        ok(`데이터셋 완성: ${m.total_frames}장 / 객체 ${m.total_objects}개`);
        (m.warnings || []).forEach((w) => toast(w, 'bad'));
        await reload();
        showDetail(m.dataset_id);
      } else if (final.status === 'error') {
        fail('데이터셋 빌드', new Error(final.error));
      }
    } catch (e) {
      fail('빌드 시작', e);
    } finally {
      jobId = null;
      btn.disabled = false;
      $('#cancel-job', view).classList.add('hidden');
    }
  });

  $('#cancel-job', view).addEventListener('click', async () => {
    if (jobId) await api.jobs.cancel(jobId).catch(() => {});
  });

  // ── 등록 ─────────────────────────────────────────────────────────
  let inspected = null;

  $('#imp-check', view).addEventListener('click', async () => {
    const path = $('#imp-path', view).value.trim();
    if (!path) return;
    $('#imp-info', view).innerHTML = '<span class="mute2">확인 중…</span>';
    try {
      inspected = await api.datasets.inspect(path);
      const s = inspected.splits || {};
      const missing = (inspected.names || []).filter((n) => !app.classes.includes(n));
      $('#imp-info', view).innerHTML = `
        <div class="row tight">
          ${badge(inspected.task || 'task 불명', inspected.task === 'obb' ? 'info' : 'warn')}
          ${badge(`${inspected.total_images}장`, '')}
          ${badge(`클래스 ${(inspected.names || []).length}개`, '')}
          ${inspected.yaml ? badge(inspected.yaml, 'ok') : badge('data.yaml 없음', 'warn')}
        </div>
        <div class="mute2 mono" style="margin-top:6px;font-size:11.5px">
          ${Object.entries(s)
            .map(([k, v]) => `${k}: 이미지 ${v.images} / 라벨 ${v.labels} (${v.dir}/)`)
            .join('<br />')}
        </div>
        <div class="mute2" style="margin-top:6px">${esc((inspected.names || []).join(', '))}</div>
        ${
          missing.length
            ? `<div class="note" style="margin-top:8px">현재 클래스 목록에 없는 이름: <b>${esc(
                missing.join(', '),
              )}</b><br />복사(스냅샷) 등록이나 병합을 하려면 먼저 클래스를 추가해야 한다.</div>`
            : ''
        }`;
      $('#imp-run', view).disabled = false;
      if (!$('#imp-name', view).value) {
        $('#imp-name', view).placeholder = String(inspected.dir).split('/').pop();
      }
    } catch (e) {
      inspected = null;
      $('#imp-run', view).disabled = true;
      $('#imp-info', view).innerHTML = `<div class="note">${esc(e.message)}</div>`;
    }
  });

  $('#imp-run', view).addEventListener('click', async () => {
    const btn = $('#imp-run', view);
    btn.disabled = true;
    try {
      const m = await api.datasets.import({
        path: $('#imp-path', view).value.trim(),
        name: $('#imp-name', view).value.trim() || undefined,
        copy: $('#imp-copy', view).checked,
      });
      ok(`등록 완료: ${m.name} (${m.total_frames}장, ${m.task})`);
      (m.warnings || []).forEach((w) => toast(w));
      await reload();
      showDetail(m.dataset_id);
    } catch (e) {
      fail('등록', e);
    } finally {
      btn.disabled = false;
    }
  });

  // ── 상세 ─────────────────────────────────────────────────────────
  async function showDetail(id) {
    const card = $('#detail-card', view);
    card.classList.remove('hidden');
    $('#detail', view).innerHTML = '<div class="loading">불러오는 중…</div>';
    try {
      const [m, yaml] = await Promise.all([
        api.datasets.get(id),
        api.datasets.yaml(id).catch(() => '(data.yaml 없음)'),
      ]);
      $('#detail-title', view).innerHTML = `${esc(m.name)} <span class="mute2 mono">${esc(id)}</span>`;
      const c = m.counts || {};
      $('#detail', view).innerHTML = `
        <div class="stats" style="margin-bottom:14px">
          <div class="stat"><b>${m.total_frames}</b><span>이미지</span></div>
          <div class="stat"><b>${m.total_objects}</b><span>객체</span></div>
          <div class="stat"><b>${c.train || 0}</b><span>train</span></div>
          <div class="stat"><b>${c.valid || 0}</b><span>valid</span></div>
          <div class="stat"><b>${c.test || 0}</b><span>test</span></div>
          <div class="stat"><b>${esc(m.task)}</b><span>태스크</span></div>
        </div>
        ${(m.warnings || []).map((w) => `<div class="note" style="margin-bottom:6px">${esc(w)}</div>`).join('')}
        ${
          m.imported
            ? `<div class="note info" style="margin-bottom:10px">
                 등록된 데이터셋 · 원본: <code>${esc(m.source_dir)}</code>
                 ${m.copied ? ' (워크스페이스로 복사됨)' : ' (참조만)'}
               </div>`
            : ''
        }
        <div class="grid cols-2">
          <div>
            <h3>클래스 분포</h3>
            ${histogram(m.class_histogram)}
          </div>
          <div>
            <h3>data.yaml</h3>
            <pre class="log" style="max-height:220px">${esc(yaml)}</pre>
          </div>
        </div>
        ${
          (m.sources || []).length
            ? `<h3 style="margin-top:14px">병합한 데이터셋</h3>
               <div class="table-wrap"><table>
                 <thead><tr><th>이름</th><th>경로</th><th>접두사</th><th class="num">train</th>
                   <th class="num">valid</th><th class="num">test</th></tr></thead>
                 <tbody>${m.sources
                   .map(
                     (s) => `<tr>
                       <td>${esc(s.name)}</td>
                       <td class="mute2 mono" style="font-size:11px">${esc(s.dir)}</td>
                       <td class="mono">${esc(s.prefix)}</td>
                       <td class="num">${s.added.train}</td>
                       <td class="num">${s.added.valid}</td>
                       <td class="num">${s.added.test}</td>
                     </tr>`,
                   )
                   .join('')}</tbody>
               </table></div>`
            : ''
        }
        ${
          Object.keys(m.per_video_frames || {}).length
            ? `<h3 style="margin-top:14px">영상별 프레임</h3>${histogram(m.per_video_frames)}`
            : ''
        }
        ${
          Object.keys(m.excluded || {}).length
            ? `<h3 style="margin-top:14px">제외된 프레임 사유</h3>${histogram(m.excluded)}`
            : ''
        }
        <div class="row" style="margin-top:14px">
          <a class="btn primary" href="#/train/new/${esc(id)}">이 데이터셋으로 학습 →</a>
        </div>`;
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      $('#detail', view).innerHTML = `<div class="note">${esc(e.message)}</div>`;
    }
  }

  $('#detail-close', view).addEventListener('click', () => $('#detail-card', view).classList.add('hidden'));
  $('#reload', view).addEventListener('click', reload);

  const list = $('#list', view);
  on(list, 'click', '[data-detail]', (e, el) => showDetail(el.dataset.detail));
  on(list, 'click', '[data-train]', (e, el) => {
    location.hash = `#/train/new/${el.dataset.train}`;
  });
  on(list, 'click', '[data-del]', async (e, el) => {
    const id = el.dataset.del;
    const d = datasets.find((x) => x.dataset_id === id);
    const extra = d && d.imported && d.source_dir ? '\n\n원본 폴더는 지우지 않습니다.' : '';
    if (!confirmAction(`데이터셋 ${id} 을 지웁니다.${extra}`)) return;
    try {
      await api.datasets.del(id);
      ok('삭제했습니다');
      $('#detail-card', view).classList.add('hidden');
      await reload();
    } catch (e2) {
      fail('삭제', e2);
    }
  });

  if (app.meta && app.meta.default_task) $('#ds-task', view).value = app.meta.default_task;
  await reload();
  if (params[0]) showDetail(params[0]);

  return {
    dispose() {
      disposed = true;
    },
  };
}
