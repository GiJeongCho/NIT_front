/**
 * views/segments.js — 2단계: 정상/비정상 구간 지정 + 프레임 추출
 *
 * 요구의 핵심이 여기다. 영상 전체를 학습에 쓰지 않고 사람이 "쓸 구간(정상)" 과
 * "못 쓸 구간(비정상)" 을 눌러 가려낸다. 그래서 조작을 두 가지로 만들었다.
 *
 * - 재생하면서 키보드로 마킹: <kbd>I</kbd> 시작 → <kbd>O</kbd> 끝. 영상을 보며
 *   손이 마우스로 옮겨가지 않는다(수십 분짜리 영상을 훑을 때 이게 유일하게 견딘다).
 * - 타임라인 드래그: 이미 아는 구간을 빠르게 긋는다.
 *
 * 저장은 전체 교체(PUT)다. 서버가 같은 종류끼리 병합하고 `정상 - 비정상` 을 계산해
 * 실제 추출 대상 구간을 돌려주므로, 프런트는 그것을 그대로 보여만 준다.
 */

import { api, pollJob } from '../api.js';
import { $, $$, bar, clamp, confirmAction, esc, fail, fmtDur, fmtSec, ok, on, toast } from '../util.js';

const MIN_LEN = 0.05;

export async function render(view, params, app) {
  const videoId = params[0] || app.videoId;
  if (!videoId) {
    view.innerHTML = `<div class="empty">먼저 <a href="#/videos">영상</a>을 등록·선택하세요.</div>`;
    return {};
  }

  let doc;
  try {
    doc = await api.videos.get(videoId);
  } catch (e) {
    view.innerHTML = `<div class="empty">영상을 불러올 수 없습니다.<br /><span class="mute2">${esc(
      e.message,
    )}</span></div>`;
    return {};
  }
  app.setVideo(videoId, doc);

  const duration = Number(doc.duration_sec) || 0;
  /** 편집 중인 구간 목록(저장 전). 서버가 병합하므로 여기서는 겹쳐도 된다. */
  let segs = (doc.segments || []).map((s) => ({ ...s }));
  let dirty = false;
  let kind = 'normal';
  let markIn = null;
  let jobId = null;
  let disposed = false;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>2 · 구간</h1>
        <div class="sub">${esc(doc.original_name)} — ${doc.width}×${doc.height} · ${doc.fps}fps · ${fmtDur(
    duration,
  )}</div>
      </div>
      <div class="grow"></div>
      <a class="btn ghost" href="#/videos">영상 목록</a>
      <a class="btn" href="#/label/${esc(videoId)}">라벨링으로 →</a>
    </div>

    <div class="player">
      <div class="card">
        <video class="stage" id="v" src="${esc(api.videos.streamUrl(videoId))}" controls preload="metadata"></video>

        <div class="timeline" id="tl">
          <div class="cursor" id="cursor" style="left:0"></div>
          <div class="ticks" id="ticks"></div>
        </div>

        <div class="row" style="margin-top:10px">
          <div class="row tight">
            <button class="btn sm ${''}" id="kind-normal">정상 구간</button>
            <button class="btn sm ghost" id="kind-abnormal">비정상 구간</button>
          </div>
          <div class="grow"></div>
          <button class="btn sm" id="mark-in">시작 (I)</button>
          <button class="btn sm" id="mark-out">끝 (O)</button>
          <span class="mute2 mono" id="mark-state">—</span>
        </div>
        <div class="keys" style="margin-top:6px">
          <kbd>Space</kbd> 재생/정지 · <kbd>←</kbd><kbd>→</kbd> 1초 · <kbd>Shift</kbd>+←→ 5초 ·
          <kbd>I</kbd> 구간 시작 · <kbd>O</kbd> 구간 끝 · 타임라인 <b>드래그</b>로 직접 긋기 ·
          위쪽 초록 = 정상, 아래쪽 빨강 = 비정상
        </div>
      </div>

      <div class="col">
        <div class="card">
          <div class="card-head">
            <h3>구간 목록</h3>
            <span class="muted" id="seg-count"></span>
            <div class="grow"></div>
            <button class="btn sm ghost" id="clear">전체 삭제</button>
          </div>
          <div class="seg-list" id="seg-list"></div>
          <div class="row" style="margin-top:10px">
            <button class="btn primary grow" id="save">구간 저장</button>
          </div>
          <div id="selection" class="mute2 mono" style="margin-top:8px;font-size:11.5px"></div>
        </div>

        <div class="card">
          <div class="card-head"><h3>프레임 추출 + 자동 라벨</h3></div>
          <p class="muted" style="font-size:12.5px">
            정상 구간에서 프레임을 뽑아 저장하고, YOLO 로 회전박스 초안을 만든다.
            사람은 그 초안을 고치기만 한다.
          </p>
          <div class="field-row">
            <label>초당 장수 (fps)
              <input type="number" id="ex-fps" step="0.5" min="0" value="2" />
            </label>
            <label>최대 장수
              <input type="number" id="ex-max" min="1" value="20000" />
            </label>
          </div>
          <div class="field-row">
            <label>신뢰도 conf
              <input type="number" id="ex-conf" step="0.05" min="0" max="1" value="0.25" />
            </label>
            <label>IoU
              <input type="number" id="ex-iou" step="0.05" min="0" max="1" value="0.7" />
            </label>
            <label>imgsz
              <input type="number" id="ex-imgsz" step="32" min="32" value="640" />
            </label>
          </div>
          <label>초안 생성 가중치
            <select id="ex-model"><option value="">기본 (서버 설정)</option></select>
          </label>
          <div class="note" style="margin-top:8px">
            사전학습 가중치(COCO·DOTA)는 <b>탑다운 드론 영상의 작은 표적을 거의 못 잡는다.</b>
            초안이 0개로 나오면 정상이다. 이때는 ① 기존 데이터셋으로 한 번 학습해 승격한 뒤
            그 모델(<code>promoted</code>)을 여기서 고르거나, ② 라벨링 화면에서 직접 박스를 그린다.
          </div>
          <div class="field-row" style="margin-top:8px">
            <label class="row tight" style="align-items:center">
              <input type="checkbox" id="ex-track" checked />
              <span>track_id 부여 (객체 단위 일괄 라벨)</span>
            </label>
          </div>
          <label>재실행 정책
            <select id="ex-overwrite">
              <option value="skip">skip — 기존 라벨 보존</option>
              <option value="auto">auto — 검수 전 초안만 갱신</option>
              <option value="all">all — 전부 재생성 (사람 수정 소실)</option>
            </select>
          </label>
          <div class="row" style="margin-top:10px">
            <button class="btn primary grow" id="extract">추출 시작</button>
            <button class="btn ghost hidden" id="cancel-job">취소</button>
          </div>
          <div id="job" style="margin-top:10px"></div>
        </div>
      </div>
    </div>
  `;

  const v = $('#v', view);
  const tl = $('#tl', view);
  const cursor = $('#cursor', view);

  // ── 기본값 채우기 ─────────────────────────────────────────────────
  if (app.meta && app.meta.defaults) {
    const d = app.meta.defaults.extract || {};
    $('#ex-fps', view).value = d.fps ?? 2;
    $('#ex-max', view).value = d.max_frames ?? 20000;
    $('#ex-conf', view).value = d.conf ?? 0.25;
    $('#ex-iou', view).value = d.iou ?? 0.7;
    $('#ex-imgsz', view).value = d.imgsz ?? 640;
    $('#ex-track', view).checked = d.track !== false;
  }
  api.models
    .weights()
    .then(({ items }) => {
      const sel = $('#ex-model', view);
      (items || []).forEach((w) => {
        const o = document.createElement('option');
        o.value = w.path || w.abs_path;
        o.textContent = `${w.name} (${w.origin}${w.task ? `, ${w.task}` : ''})`;
        sel.appendChild(o);
      });
    })
    .catch(() => {});

  // ── 타임라인 ─────────────────────────────────────────────────────
  const xToSec = (clientX) => {
    const r = tl.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * duration, 0, duration);
  };
  const secToPct = (s) => (duration > 0 ? (s / duration) * 100 : 0);

  function drawTicks() {
    if (duration <= 0) return;
    // 눈금 간격은 "10개 남짓" 이 되도록 1/5/10/30/60초 중에서 고른다.
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => duration / s <= 12) || 600;
    let html = '';
    for (let t = 0; t <= duration + 1e-6; t += step) {
      html += `<span class="tick" style="left:${secToPct(t)}%">${fmtSec(t)}</span>`;
    }
    $('#ticks', view).innerHTML = html;
  }

  function drawSegments(draft = null) {
    $$('.seg', tl).forEach((el) => el.remove());
    const all = draft ? [...segs, { ...draft, draft: true }] : segs;
    for (const s of all) {
      const el = document.createElement('div');
      el.className = `seg ${s.kind}${s.draft ? ' draft' : ''}`;
      el.style.left = `${secToPct(s.start_sec)}%`;
      el.style.width = `${Math.max(0.3, secToPct(s.end_sec - s.start_sec))}%`;
      el.title = `${s.kind} ${fmtSec(s.start_sec)} ~ ${fmtSec(s.end_sec)}`;
      tl.appendChild(el);
    }
  }

  function renderSegList() {
    const box = $('#seg-list', view);
    $('#seg-count', view).textContent = `${segs.length}개`;
    if (!segs.length) {
      box.innerHTML = `<div class="mute2" style="padding:6px">구간이 없습니다. 정상 구간을 하나도 안 넣으면 <b>영상 전체</b>를 정상으로 봅니다.</div>`;
      return;
    }
    const sorted = [...segs].sort((a, b) => a.start_sec - b.start_sec);
    box.innerHTML = sorted
      .map((s) => {
        const i = segs.indexOf(s);
        const cls = s.kind === 'normal' ? 'ok' : 'bad';
        return `<div class="seg-item" data-i="${i}">
          <span class="badge ${cls} kind" data-toggle="${i}" title="클릭하면 정상↔비정상">${
          s.kind === 'normal' ? '정상' : '비정상'
        }</span>
          <input type="number" step="0.1" data-f="start_sec" value="${s.start_sec.toFixed(2)}" />
          <input type="number" step="0.1" data-f="end_sec" value="${s.end_sec.toFixed(2)}" />
          <button class="btn sm ghost" data-rm="${i}" title="삭제">×</button>
        </div>`;
      })
      .join('');
  }

  function refresh() {
    drawSegments();
    renderSegList();
    $('#save', view).classList.toggle('primary', dirty);
    $('#save', view).textContent = dirty ? '구간 저장 *' : '구간 저장';
  }

  function addSeg(a, b, k = kind) {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < MIN_LEN) return false;
    segs.push({ kind: k, start_sec: start, end_sec: end, duration_sec: end - start, note: '' });
    dirty = true;
    refresh();
    return true;
  }

  // 드래그로 구간 긋기. 짧게 클릭하면 그 지점으로 탐색(seek)한다.
  let dragFrom = null;
  tl.addEventListener('pointerdown', (e) => {
    dragFrom = xToSec(e.clientX);
    tl.setPointerCapture(e.pointerId);
  });
  tl.addEventListener('pointermove', (e) => {
    if (dragFrom === null) return;
    const to = xToSec(e.clientX);
    drawSegments({ kind, start_sec: Math.min(dragFrom, to), end_sec: Math.max(dragFrom, to) });
  });
  tl.addEventListener('pointerup', (e) => {
    if (dragFrom === null) return;
    const to = xToSec(e.clientX);
    if (Math.abs(to - dragFrom) < MIN_LEN) {
      v.currentTime = to;
      drawSegments();
    } else {
      addSeg(dragFrom, to);
    }
    dragFrom = null;
  });

  v.addEventListener('timeupdate', () => {
    cursor.style.left = `${secToPct(v.currentTime)}%`;
  });
  v.addEventListener('loadedmetadata', drawTicks);

  // ── 구간 목록 편집 ────────────────────────────────────────────────
  const segList = $('#seg-list', view);
  on(segList, 'click', '[data-rm]', (e, el) => {
    segs.splice(Number(el.dataset.rm), 1);
    dirty = true;
    refresh();
  });
  on(segList, 'click', '[data-toggle]', (e, el) => {
    const s = segs[Number(el.dataset.toggle)];
    s.kind = s.kind === 'normal' ? 'abnormal' : 'normal';
    dirty = true;
    refresh();
  });
  on(segList, 'change', 'input[data-f]', (e, el) => {
    const s = segs[Number(el.closest('.seg-item').dataset.i)];
    s[el.dataset.f] = clamp(Number(el.value) || 0, 0, duration || Number(el.value) || 0);
    if (s.end_sec < s.start_sec) [s.start_sec, s.end_sec] = [s.end_sec, s.start_sec];
    s.duration_sec = s.end_sec - s.start_sec;
    dirty = true;
    refresh();
  });

  $('#clear', view).addEventListener('click', () => {
    if (!segs.length || !confirmAction('구간을 전부 지웁니다. 계속할까요?')) return;
    segs = [];
    dirty = true;
    refresh();
  });

  // ── 종류 선택 / 마킹 ──────────────────────────────────────────────
  function setKind(k) {
    kind = k;
    $('#kind-normal', view).className = `btn sm ${k === 'normal' ? '' : 'ghost'}`;
    $('#kind-abnormal', view).className = `btn sm ${k === 'abnormal' ? 'danger' : 'ghost'}`;
  }
  setKind('normal');
  $('#kind-normal', view).addEventListener('click', () => setKind('normal'));
  $('#kind-abnormal', view).addEventListener('click', () => setKind('abnormal'));

  function doMarkIn() {
    markIn = v.currentTime;
    $('#mark-state', view).textContent = `시작 ${fmtSec(markIn)} — 끝(O)을 누르세요`;
  }
  function doMarkOut() {
    if (markIn === null) {
      toast('먼저 시작(I)을 누르세요');
      return;
    }
    const added = addSeg(markIn, v.currentTime);
    $('#mark-state', view).textContent = added
      ? `${kind === 'normal' ? '정상' : '비정상'} 구간 추가`
      : '너무 짧습니다';
    markIn = null;
  }
  $('#mark-in', view).addEventListener('click', doMarkIn);
  $('#mark-out', view).addEventListener('click', doMarkOut);

  function onKey(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const step = e.shiftKey ? 5 : 1;
    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        v.paused ? v.play() : v.pause();
        break;
      case 'arrowleft':
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - step);
        break;
      case 'arrowright':
        e.preventDefault();
        v.currentTime = Math.min(duration || v.duration, v.currentTime + step);
        break;
      case 'i':
        doMarkIn();
        break;
      case 'o':
        doMarkOut();
        break;
      default:
        break;
    }
  }
  window.addEventListener('keydown', onKey);

  // ── 저장 / 선택 미리보기 ──────────────────────────────────────────
  async function showSelection() {
    try {
      const sel = await api.videos.selection(videoId, ['normal']);
      $('#selection', view).innerHTML = sel.ranges.length
        ? `실제 추출 대상 (정상 − 비정상): ${sel.ranges.length}구간 / 총 ${fmtDur(
            sel.total_sec,
          )}<br />${sel.ranges.map(([a, b]) => `${fmtSec(a)}~${fmtSec(b)}`).join(', ')}`
        : '추출 대상 구간이 없습니다.';
    } catch (e) {
      $('#selection', view).textContent = '';
    }
  }

  async function save() {
    try {
      const res = await api.videos.putSegments(
        videoId,
        segs.map((s) => ({ kind: s.kind, start_sec: s.start_sec, end_sec: s.end_sec, note: s.note || '' })),
      );
      segs = (res.segments || []).map((s) => ({ ...s }));
      dirty = false;
      refresh();
      ok(`구간 저장 (${segs.length}개, 병합 후)`);
      await showSelection();
    } catch (e) {
      fail('구간 저장', e);
    }
  }
  $('#save', view).addEventListener('click', save);

  // ── 추출 잡 ───────────────────────────────────────────────────────
  function renderJob(j) {
    const box = $('#job', view);
    if (!j) {
      box.innerHTML = '';
      return;
    }
    const kindLabel = { queued: '대기', running: '진행 중', done: '완료', error: '실패', canceled: '취소' }[
      j.status
    ];
    box.innerHTML = `
      ${bar(j.progress, j.status === 'done' ? 'ok' : '')}
      <div class="mute2 mono" style="margin-top:4px;font-size:11.5px">
        ${kindLabel} ${j.done}/${j.total || '?'} · ${j.rate_per_sec || 0}/s · ${esc(j.message || '')}
      </div>
      ${j.error ? `<div class="note" style="margin-top:6px">${esc(j.error)}</div>` : ''}`;
  }

  $('#extract', view).addEventListener('click', async () => {
    if (dirty && !confirmAction('저장하지 않은 구간 변경이 있습니다. 저장하고 추출할까요?')) return;
    if (dirty) await save();

    const btn = $('#extract', view);
    btn.disabled = true;
    $('#cancel-job', view).classList.remove('hidden');
    const opts = {
      kinds: ['normal'],
      fps: Number($('#ex-fps', view).value),
      conf: Number($('#ex-conf', view).value),
      iou: Number($('#ex-iou', view).value),
      imgsz: Number($('#ex-imgsz', view).value),
      max_frames: Number($('#ex-max', view).value),
      track: $('#ex-track', view).checked,
      overwrite: $('#ex-overwrite', view).value,
    };
    const model = $('#ex-model', view).value;
    if (model) opts.model = model;

    try {
      const started = await api.videos.extract(videoId, opts);
      jobId = started.job_id;
      const final = await pollJob(jobId, (j) => {
        if (!disposed) renderJob(j);
      });
      if (final.status === 'done') {
        const res = final.result || {};
        ok(`추출 완료: ${res.frames_written ?? final.done}장 · 객체 ${res.objects ?? 0}개 · 트랙 ${
          res.tracks ?? 0
        }개`);
        if (!res.objects) {
          toast(
            `자동 초안이 0개입니다 (${res.model}). 이 가중치는 이 영상의 표적을 모릅니다 — ` +
              '라벨링 화면에서 직접 그리거나, 학습·승격한 모델로 다시 추출하세요.',
            'bad',
          );
        }
        setTimeout(() => {
          if (!disposed) location.hash = `#/label/${videoId}`;
        }, 1200);
      } else if (final.status === 'error') {
        fail('추출', new Error(final.error || '알 수 없는 오류'));
      }
    } catch (e) {
      fail('추출 시작', e);
    } finally {
      jobId = null;
      btn.disabled = false;
      $('#cancel-job', view).classList.add('hidden');
    }
  });

  $('#cancel-job', view).addEventListener('click', async () => {
    if (!jobId) return;
    try {
      await api.jobs.cancel(jobId);
      toast('취소를 요청했습니다 (진행 중인 프레임까지 저장 후 멈춥니다)');
    } catch (e) {
      fail('취소', e);
    }
  });

  drawTicks();
  refresh();
  await showSelection();

  // 이미 돌고 있는 추출 잡이 있으면 이어서 보여준다(새로고침해도 진행률이 보이게).
  try {
    const { items } = await api.jobs.list({ kind: 'extract', target: videoId, limit: 1 });
    if (items && items[0] && ['queued', 'running'].includes(items[0].status)) {
      jobId = items[0].id;
      $('#extract', view).disabled = true;
      $('#cancel-job', view).classList.remove('hidden');
      pollJob(jobId, (j) => !disposed && renderJob(j)).finally(() => {
        if (disposed) return;
        jobId = null;
        $('#extract', view).disabled = false;
        $('#cancel-job', view).classList.add('hidden');
      });
    }
  } catch {
    /* 잡 목록 실패는 화면을 막을 이유가 없다 */
  }

  return {
    dispose() {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      v.pause();
    },
  };
}
