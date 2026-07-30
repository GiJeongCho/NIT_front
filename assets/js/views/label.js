/**
 * views/label.js — 3단계: 회전박스(OBB) 라벨 검수/수정
 *
 * "라벨링은 모든 부분을 해야 한다" 는 요구를 사람이 실제로 끝낼 수 있게 만드는 화면이다.
 * 프레임이 수천 장이므로 장당 작업량을 줄이는 데 전부를 건다.
 *
 * - YOLO 가 만든 초안을 그대로 띄운다. 사람은 **고치기만** 한다(처음부터 그리지 않는다).
 * - 오른쪽 "객체(track)" 패널에서 클래스를 한 번 고르면 그 객체가 등장하는 모든
 *   프레임에 전파된다. 공수가 프레임 수가 아니라 **객체 수**에 비례한다.
 * - 편집은 회전 사각형 단위다(`obb.js`). 어떤 조작을 해도 결과가 직사각형이라
 *   YOLO OBB 라벨이 망가지지 않는다.
 * - 프레임을 넘기면 수정 중이던 라벨은 자동 저장된다. 라벨링 도구가 작업을 잃는 것은
 *   어떤 이유로도 용납되지 않는다.
 */

import { api } from '../api.js';
import { $, bar, classColor, clamp, confirmAction, esc, fail, fmtSec, ok, on, pct, toast } from '../util.js';
import {
  angleFromHandle,
  cornersOf,
  deg,
  dist,
  nudgeInside,
  pointInPoly,
  polyFromRect,
  rad,
  rectFromDrag,
  rectFromPoly,
  resizeByCorner,
  rotateHandleOf,
} from '../obb.js';

const HANDLE_R = 6;      // 화면 픽셀 기준 핸들 반경
const MIN_SIDE = 3;      // 이보다 작은 박스는 만들지 않는다(오클릭 방지)

export async function render(view, params, app) {
  const videoId = params[0] || app.videoId;
  if (!videoId) {
    view.innerHTML = `<div class="empty">먼저 <a href="#/videos">영상</a>을 선택하세요.</div>`;
    return {};
  }

  let meta;
  try {
    meta = await api.videos.get(videoId);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return {};
  }
  app.setVideo(videoId, meta);

  let frames = [];
  let idx = -1;
  let doc = null;
  let objs = [];           // {id, class_name, track_id, score, model_class_name, rect}
  let sel = -1;
  let dirty = false;
  let disposed = false;
  let filter = '';

  // 뷰포트: 이미지 → 캔버스 변환. zoom 1 이면 폭에 딱 맞는다.
  const vp = { zoom: 1, ox: 0, oy: 0, base: 1 };
  let img = null;
  let drag = null;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>3 · 라벨링</h1>
        <div class="sub">${esc(meta.original_name)} — 회전박스 초안을 검수한다</div>
      </div>
      <div class="grow"></div>
      <a class="btn ghost" href="#/segments/${esc(videoId)}">← 구간</a>
      <a class="btn" href="#/datasets">데이터셋으로 →</a>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="row">
        <div class="grow">
          <div id="prog-bar"></div>
          <div class="mute2 mono" id="prog-text" style="margin-top:4px;font-size:11.5px"></div>
        </div>
        <label style="width:150px;margin:0">필터
          <select id="filter">
            <option value="">전체</option>
            <option value="pending">검수 대기</option>
            <option value="approved">승인</option>
            <option value="rejected">제외</option>
          </select>
        </label>
        <button class="btn" id="approve-all" title="승인 조건을 못 채운 프레임은 건너뛰고 이유를 알려준다">전체 승인</button>
      </div>
    </div>

    <div class="labeler">
      <div class="filmstrip" id="film"></div>

      <div class="col">
        <div class="canvas-wrap" id="cwrap">
          <canvas id="label-canvas"></canvas>
          <div class="canvas-hint" id="hint"></div>
        </div>
        <div class="card">
          <div class="row">
            <button class="btn sm ghost" id="prev">← 이전 ([)</button>
            <button class="btn sm ghost" id="next">다음 (]) →</button>
            <span class="mono mute2" id="frame-info"></span>
            <div class="grow"></div>
            <button class="btn sm" id="fit">화면맞춤</button>
            <button class="btn sm" id="save">저장 (S)</button>
            <button class="btn sm ok" id="approve">승인하고 다음 (Enter)</button>
            <button class="btn sm danger" id="reject">제외 (R)</button>
          </div>
        </div>
      </div>

      <div class="col">
        <div class="card">
          <div class="card-head">
            <h3>이 프레임의 객체</h3>
            <span class="muted" id="obj-count"></span>
          </div>
          <div class="obj-list" id="obj-list"></div>
          <div class="row tight" style="margin-top:8px">
            <select id="sel-class" class="grow"></select>
            <button class="btn sm danger" id="del-obj" title="Delete">삭제</button>
          </div>
          <div class="mute2" style="margin-top:6px;font-size:11.5px">
            빈 곳을 <b>드래그</b>하면 새 박스가 생긴다. 선택한 박스는 꼭짓점으로 크기,
            위쪽 원형 핸들로 각도를 바꾼다.
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>객체(track) 일괄 지정</h3>
            <button class="btn sm ghost" id="reload-tracks">새로고침</button>
          </div>
          <p class="muted" style="font-size:12px;margin:0 0 8px">
            같은 <code>track_id</code> 를 가진 객체의 클래스를 <b>모든 프레임</b>에 한 번에 적용한다.
            300 프레임에 나오는 전차 1대는 클릭 한 번으로 끝난다.
          </p>
          <div class="track-list" id="track-list"></div>
        </div>

        <div class="card">
          <div class="card-head"><h3>클래스</h3></div>
          <div class="row tight" id="class-chips" style="margin-bottom:8px"></div>
          <div class="row tight">
            <input type="text" id="new-class" class="grow" placeholder="클래스 추가 (뒤에만 추가됨)" />
            <button class="btn sm" id="add-class">추가</button>
          </div>
          <div class="mute2" style="margin-top:6px;font-size:11.5px">
            목록의 순서가 곧 학습 클래스 id 다. 순서 변경·삭제는 서버가 거부한다.
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>단축키</h3></div>
          <div class="keys">
            <kbd>1</kbd>…<kbd>9</kbd><kbd>0</kbd> 선택 박스에 클래스 지정<br />
            <kbd>Q</kbd>/<kbd>E</kbd> 회전 1° (<kbd>Shift</kbd> 5°) ·
            <kbd>←↑↓→</kbd> 이동 (<kbd>Shift</kbd> 10px)<br />
            <kbd>Del</kbd> 삭제 · <kbd>Esc</kbd> 선택 해제 · <kbd>Tab</kbd> 다음 박스<br />
            <kbd>S</kbd> 저장 · <kbd>Enter</kbd> 승인하고 다음 · <kbd>R</kbd> 제외<br />
            <kbd>[</kbd> <kbd>]</kbd> 이전/다음 프레임 · <b>휠</b> 확대 · <kbd>Space</kbd>+드래그 이동
          </div>
        </div>
      </div>
    </div>
  `;

  const canvas = $('#label-canvas', view);
  const ctx = canvas.getContext('2d');
  const cwrap = $('#cwrap', view);

  // ── 진행률 / 목록 ─────────────────────────────────────────────────
  async function refreshProgress() {
    try {
      const p = await api.videos.progress(videoId);
      $('#prog-bar', view).innerHTML = bar(p.approved_ratio, p.approved_ratio >= 1 ? 'ok' : '');
      $('#prog-text', view).textContent =
        `프레임 ${p.frames} · 승인 ${p.approved} (${pct(p.approved_ratio)}) · 대기 ${p.pending} · ` +
        `제외 ${p.rejected} · 객체 ${p.objects}` +
        (p.unresolved_objects ? ` · 미확정 ${p.unresolved_objects}개` : ' · 미확정 없음');
    } catch (e) {
      /* 진행률 실패로 라벨링을 막지 않는다 */
    }
  }

  async function loadFrames(keepFrameId = null) {
    const res = await api.videos.frames(videoId, { status: filter || undefined, limit: 1000 });
    frames = res.items || [];
    renderFilm();
    if (!frames.length) {
      doc = null;
      objs = [];
      idx = -1;
      draw();
      $('#frame-info', view).textContent = '표시할 프레임이 없습니다';
      return;
    }
    const want = keepFrameId ? frames.findIndex((f) => f.frame_id === keepFrameId) : -1;
    await openFrame(want >= 0 ? want : 0, { skipSave: true });
  }

  function renderFilm() {
    const box = $('#film', view);
    box.innerHTML = frames
      .map(
        (f, i) => `<div class="film ${f.status} ${i === idx ? 'active' : ''}" data-i="${i}">
          <img loading="lazy" src="${esc(api.videos.frameImageUrl(videoId, f.frame_id, true))}"
               alt="${esc(f.frame_id)}" />
          <div class="tag"><span>${esc(f.frame_id)}</span><span>${
          f.n_unresolved ? `?${f.n_unresolved}` : f.n_objects
        }</span></div>
        </div>`,
      )
      .join('');
  }

  function markFilm() {
    const items = view.querySelectorAll('#film .film');
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
    const active = items[idx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function updateFilmTag(i) {
    const el = view.querySelectorAll('#film .film')[i];
    const f = frames[i];
    if (!el || !f) return;
    el.className = `film ${f.status} ${i === idx ? 'active' : ''}`;
    el.querySelector('.tag').innerHTML = `<span>${esc(f.frame_id)}</span><span>${
      f.n_unresolved ? `?${f.n_unresolved}` : f.n_objects
    }</span>`;
    // 오버레이 썸네일을 갱신한다(캐시 무효화용 쿼리 추가).
    el.querySelector('img').src = `${api.videos.frameImageUrl(videoId, f.frame_id, true)}&_=${Date.now()}`;
  }

  // ── 프레임 열기 / 저장 ────────────────────────────────────────────
  async function openFrame(i, { skipSave = false } = {}) {
    if (i < 0 || i >= frames.length) return;
    if (!skipSave && dirty) await save({ silent: true });
    idx = i;
    sel = -1;
    markFilm();
    try {
      doc = await api.videos.frame(videoId, frames[i].frame_id);
    } catch (e) {
      fail('라벨 조회', e);
      return;
    }
    objs = (doc.objects || []).map((o) => ({
      id: o.id,
      class_name: o.class_name || null,
      track_id: o.track_id ?? null,
      score: o.score ?? null,
      model_class_name: o.model_class_name || null,
      rect: rectFromPoly(o.poly),
    }));
    dirty = false;
    await loadImage();
    renderObjects();
    $('#frame-info', view).textContent =
      `${i + 1}/${frames.length} · ${doc.frame_id} · ${fmtSec(doc.time_sec)} · ${doc.width}×${doc.height} · ` +
      `${doc.source === 'manual' ? '사람 수정' : '자동 초안'}`;
    $('#hint', view).innerHTML = `${doc.status} · 객체 ${objs.length}개`;
  }

  function loadImage() {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        img = im;
        fit();
        resolve();
      };
      im.onerror = () => {
        img = null;
        draw();
        resolve();
      };
      im.src = api.videos.frameImageUrl(videoId, doc.frame_id, false);
    });
  }

  function payloadObjects() {
    return objs
      .filter((o) => o.rect.w >= MIN_SIDE && o.rect.h >= MIN_SIDE)
      .map((o) => ({
        id: o.id,
        class_name: o.class_name || null,
        poly: polyFromRect(o.rect).map((p) => [
          clamp(p[0], 0, doc.width),
          clamp(p[1], 0, doc.height),
        ]),
        track_id: o.track_id,
        score: o.score,
        model_class_name: o.model_class_name,
      }));
  }

  async function save({ status = null, silent = false, force = false } = {}) {
    if (!doc) return null;
    try {
      const saved = await api.videos.saveFrame(videoId, doc.frame_id, {
        objects: payloadObjects(),
        status: status || undefined,
        force,
      });
      doc = saved;
      dirty = false;
      const unresolved = (saved.objects || []).filter((o) => (o.class_id ?? -1) < 0).length;
      frames[idx] = {
        ...frames[idx],
        status: saved.status,
        n_objects: (saved.objects || []).length,
        n_unresolved: unresolved,
      };
      updateFilmTag(idx);
      if (!silent) ok(status === 'approved' ? '승인했습니다' : '저장했습니다');
      refreshProgress();
      return saved;
    } catch (e) {
      fail('저장', e);
      return null;
    }
  }

  // ── 캔버스 ───────────────────────────────────────────────────────
  function fit() {
    vp.zoom = 1;
    vp.ox = 0;
    vp.oy = 0;
    resize();
  }

  function resize() {
    const cssW = cwrap.clientWidth || 800;
    const iw = img ? img.naturalWidth : doc ? doc.width : 640;
    const ih = img ? img.naturalHeight : doc ? doc.height : 480;
    const cssH = Math.round((cssW * ih) / iw);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vp.base = cssW / iw;
    clampPan();
    draw();
  }

  const scale = () => vp.base * vp.zoom;

  function clampPan() {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const iw = (img ? img.naturalWidth : doc ? doc.width : 640) * scale();
    const ih = (img ? img.naturalHeight : doc ? doc.height : 480) * scale();
    vp.ox = iw <= cssW ? (cssW - iw) / 2 : clamp(vp.ox, cssW - iw, 0);
    vp.oy = ih <= cssH ? (cssH - ih) / 2 : clamp(vp.oy, cssH - ih, 0);
  }

  const toScreen = (p) => [p[0] * scale() + vp.ox, p[1] * scale() + vp.oy];

  function toImage(ev) {
    const r = canvas.getBoundingClientRect();
    return [(ev.clientX - r.left - vp.ox) / scale(), (ev.clientY - r.top - vp.oy) / scale()];
  }

  function draw() {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, cssW, cssH);
    if (img) {
      ctx.imageSmoothingEnabled = vp.zoom < 3;
      ctx.drawImage(img, vp.ox, vp.oy, img.naturalWidth * scale(), img.naturalHeight * scale());
    } else {
      ctx.fillStyle = '#6b7889';
      ctx.font = '13px sans-serif';
      ctx.fillText('프레임 이미지를 불러올 수 없습니다', 14, 24);
    }

    objs.forEach((o, i) => drawObject(o, i === sel));
    if (drag && drag.type === 'new' && drag.rect) {
      const poly = polyFromRect(drag.rect).map(toScreen);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#4c8dff';
      ctx.lineWidth = 1.5;
      strokePoly(poly);
      ctx.setLineDash([]);
    }
  }

  function strokePoly(pts) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
  }

  function drawObject(o, active) {
    const cid = o.class_name ? app.classIndex(o.class_name) : -1;
    const color = classColor(cid);
    const poly = polyFromRect(o.rect).map(toScreen);

    ctx.lineWidth = active ? 2.5 : 1.6;
    ctx.strokeStyle = color;
    if (cid < 0) ctx.setLineDash([6, 4]);   // 미확정은 점선 — 남은 일이 눈에 보이게
    strokePoly(poly);
    ctx.setLineDash([]);

    // 폭 방향(첫 변)을 짧게 그려 회전 방향을 알려준다.
    ctx.beginPath();
    ctx.moveTo((poly[0][0] + poly[1][0]) / 2, (poly[0][1] + poly[1][1]) / 2);
    const [hx, hy] = toScreen(rotateHandleOf(o.rect, active ? 22 / scale() : 8 / scale()));
    ctx.lineTo(hx, hy);
    ctx.stroke();

    const label =
      (o.track_id !== null && o.track_id !== undefined ? `#${o.track_id} ` : '') +
      (o.class_name || '미확정') +
      (o.score !== null && o.score !== undefined ? ` ${Number(o.score).toFixed(2)}` : '');
    ctx.font = '600 11px sans-serif';
    const tw = ctx.measureText(label).width;
    const tx = poly[0][0];
    const ty = poly[0][1] - 4 > 12 ? poly[0][1] - 4 : poly[0][1] + 14;
    ctx.fillStyle = color;
    ctx.fillRect(tx, ty - 11, tw + 8, 14);
    ctx.fillStyle = '#0b0e13';
    ctx.fillText(label, tx + 4, ty);

    if (active) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      cornersOf(o.rect)
        .map(toScreen)
        .forEach(([x, y]) => {
          ctx.beginPath();
          ctx.rect(x - HANDLE_R / 2, y - HANDLE_R / 2, HANDLE_R, HANDLE_R);
          ctx.fill();
          ctx.stroke();
        });
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_R / 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ── 포인터 조작 ───────────────────────────────────────────────────
  let spaceDown = false;

  function hitTest(pt) {
    const tol = HANDLE_R / scale();
    if (sel >= 0) {
      const o = objs[sel];
      const rh = rotateHandleOf(o.rect, 22 / scale());
      if (dist(pt, rh) <= tol * 1.4) return { type: 'rotate', i: sel };
      const cs = cornersOf(o.rect);
      for (let c = 0; c < 4; c++) {
        if (dist(pt, cs[c]) <= tol * 1.2) return { type: 'corner', i: sel, corner: c };
      }
    }
    // 위에 그려진(=나중 인덱스) 박스를 먼저 집는다.
    for (let i = objs.length - 1; i >= 0; i--) {
      if (pointInPoly(pt, polyFromRect(objs[i].rect))) return { type: 'move', i };
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    canvas.setPointerCapture(e.pointerId);
    const pt = toImage(e);
    const r = canvas.getBoundingClientRect();

    if (e.button === 1 || spaceDown || e.shiftKey) {
      drag = { type: 'pan', sx: e.clientX - r.left, sy: e.clientY - r.top, ox: vp.ox, oy: vp.oy };
      return;
    }

    const hit = hitTest(pt);
    if (!hit) {
      sel = -1;
      renderObjects();
      drag = { type: 'new', from: pt, rect: null };
      draw();
      return;
    }
    if (hit.i !== sel) {
      sel = hit.i;
      renderObjects();
    }
    const o = objs[sel];
    if (hit.type === 'move') {
      drag = { type: 'move', dx: pt[0] - o.rect.cx, dy: pt[1] - o.rect.cy };
    } else if (hit.type === 'corner') {
      drag = { type: 'corner', corner: hit.corner, fixed: cornersOf(o.rect)[(hit.corner + 2) % 4] };
    } else {
      drag = { type: 'rotate' };
    }
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !doc) return;
    if (drag.type === 'pan') {
      const r = canvas.getBoundingClientRect();
      vp.ox = drag.ox + (e.clientX - r.left - drag.sx);
      vp.oy = drag.oy + (e.clientY - r.top - drag.sy);
      clampPan();
      draw();
      return;
    }
    const pt = toImage(e);
    if (drag.type === 'new') {
      drag.rect = rectFromDrag(drag.from, pt);
      draw();
      return;
    }
    const o = objs[sel];
    if (!o) return;
    if (drag.type === 'move') {
      o.rect = nudgeInside({ ...o.rect, cx: pt[0] - drag.dx, cy: pt[1] - drag.dy }, doc.width, doc.height);
    } else if (drag.type === 'corner') {
      o.rect = resizeByCorner(o.rect, drag.corner, drag.fixed, pt);
    } else if (drag.type === 'rotate') {
      o.rect = { ...o.rect, a: angleFromHandle(o.rect, pt) };
    }
    dirty = true;
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    if (drag && drag.type === 'new' && drag.rect) {
      const r = drag.rect;
      if (r.w >= MIN_SIDE && r.h >= MIN_SIDE) {
        objs.push({
          id: `o${Date.now() % 100000}`,
          class_name: null,
          track_id: null,
          score: null,
          model_class_name: null,
          rect: nudgeInside(r, doc.width, doc.height),
        });
        sel = objs.length - 1;
        dirty = true;
        renderObjects();
      }
    }
    drag = null;
    draw();
  });

  canvas.addEventListener('wheel', (e) => {
    if (!doc) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const before = [(mx - vp.ox) / scale(), (my - vp.oy) / scale()];
    vp.zoom = clamp(vp.zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 14);
    vp.ox = mx - before[0] * scale();
    vp.oy = my - before[1] * scale();
    clampPan();
    draw();
  }, { passive: false });

  // ── 오른쪽 패널 ───────────────────────────────────────────────────
  function renderObjects() {
    $('#obj-count', view).textContent = `${objs.length}개${
      objs.filter((o) => !o.class_name).length
        ? ` · 미확정 ${objs.filter((o) => !o.class_name).length}`
        : ''
    }`;
    $('#obj-list', view).innerHTML = objs.length
      ? objs
          .map((o, i) => {
            const cid = o.class_name ? app.classIndex(o.class_name) : -1;
            return `<div class="obj ${i === sel ? 'active' : ''} ${cid < 0 ? 'unresolved' : ''}" data-i="${i}">
              <span class="swatch" style="background:${classColor(cid)}"></span>
              <span class="cname">${esc(o.class_name || '미확정')}${
              o.track_id !== null && o.track_id !== undefined ? ` <span class="mute2">#${o.track_id}</span>` : ''
            }</span>
              <span class="mute2 mono">${Math.round(o.rect.w)}×${Math.round(o.rect.h)} ${deg(o.rect.a).toFixed(
              0,
            )}°</span>
            </div>`;
          })
          .join('')
      : '<div class="mute2" style="padding:6px">객체 없음 (배경 샘플로 승인 가능)</div>';
    $('#sel-class', view).innerHTML = app.classOptions(sel >= 0 ? objs[sel].class_name : null);
    $('#sel-class', view).disabled = sel < 0;
    $('#del-obj', view).disabled = sel < 0;
    draw();
  }

  function renderClassChips() {
    $('#class-chips', view).innerHTML = app.classes
      .map(
        (n, i) =>
          `<button class="btn sm ghost" data-cls="${esc(n)}" title="선택한 박스에 지정 (${
            i < 9 ? i + 1 : i === 9 ? 0 : '-'
          })">
             <span class="swatch" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${classColor(
               i,
             )};margin-right:5px"></span>${esc(n)}
           </button>`,
      )
      .join('');
  }

  async function renderTracks() {
    try {
      const { items } = await api.videos.tracks(videoId);
      const box = $('#track-list', view);
      box.innerHTML = items.length
        ? items
            .map(
              (t) => `<div class="track ${t.resolved ? '' : 'unresolved'}">
                <div>
                  <b class="mono">#${t.track_id}</b>
                  <span class="mute2">${t.frames}프레임 · ${
                t.model_class_name ? esc(t.model_class_name) : '?'
              } ${t.avg_score ? t.avg_score.toFixed(2) : ''}</span>
                </div>
                <select data-track="${t.track_id}">${app.classOptions(t.class_name)}</select>
              </div>`,
            )
            .join('')
        : '<div class="mute2" style="padding:6px">track_id 가 없습니다. 추출 시 track 을 켜면 생깁니다.</div>';
    } catch (e) {
      fail('track 목록', e);
    }
  }

  on($('#obj-list', view), 'click', '.obj', (e, el) => {
    sel = Number(el.dataset.i);
    renderObjects();
  });

  $('#sel-class', view).addEventListener('change', (e) => {
    if (sel < 0) return;
    objs[sel].class_name = e.target.value || null;
    dirty = true;
    renderObjects();
  });

  $('#del-obj', view).addEventListener('click', () => {
    if (sel < 0) return;
    objs.splice(sel, 1);
    sel = -1;
    dirty = true;
    renderObjects();
  });

  on($('#class-chips', view), 'click', '[data-cls]', (e, el) => {
    if (sel < 0) {
      toast('먼저 박스를 선택하세요');
      return;
    }
    objs[sel].class_name = el.dataset.cls;
    dirty = true;
    renderObjects();
  });

  on($('#track-list', view), 'change', 'select[data-track]', async (e, el) => {
    const trackId = Number(el.dataset.track);
    const className = el.value;
    if (!className) return;
    try {
      const res = await api.videos.propagate(videoId, trackId, className);
      ok(`#${trackId} → ${className}: ${res.frames}프레임 / ${res.objects}객체에 적용`);
      await renderTracks();
      await refreshProgress();
      // 현재 프레임에도 적용됐으므로 다시 읽는다(사용자가 손으로 고친 것은 없다).
      await openFrame(idx, { skipSave: true });
    } catch (e2) {
      fail('일괄 지정', e2);
    }
  });

  $('#reload-tracks', view).addEventListener('click', renderTracks);

  $('#add-class', view).addEventListener('click', async () => {
    const name = $('#new-class', view).value.trim();
    if (!name) return;
    try {
      const res = await api.classes.put([...app.classes, name]);
      app.classes = res.class_names;
      $('#new-class', view).value = '';
      renderClassChips();
      renderObjects();
      await renderTracks();
      ok(`클래스 추가: ${name} (id ${app.classes.indexOf(name)})`);
    } catch (e) {
      fail('클래스 추가', e);
    }
  });

  // ── 프레임 이동 / 상태 ────────────────────────────────────────────
  on($('#film', view), 'click', '.film', (e, el) => openFrame(Number(el.dataset.i)));
  $('#prev', view).addEventListener('click', () => openFrame(idx - 1));
  $('#next', view).addEventListener('click', () => openFrame(idx + 1));
  $('#fit', view).addEventListener('click', fit);
  $('#save', view).addEventListener('click', () => save({}));
  $('#reject', view).addEventListener('click', async () => {
    await save({ status: 'rejected' });
    openFrame(idx + 1, { skipSave: true });
  });
  $('#approve', view).addEventListener('click', approveNext);

  async function approveNext() {
    const saved = await save({ status: 'approved' });
    if (saved) openFrame(idx + 1, { skipSave: true });
  }

  $('#filter', view).addEventListener('change', async (e) => {
    if (dirty) await save({ silent: true });
    filter = e.target.value;
    await loadFrames();
  });

  $('#approve-all', view).addEventListener('click', async () => {
    if (!confirmAction('현재 영상의 모든 프레임을 승인합니다. 클래스가 미확정인 프레임은 건너뜁니다.')) return;
    if (dirty) await save({ silent: true });
    try {
      const res = await api.videos.bulkStatus(videoId, 'approved');
      if (res.failed.length) {
        toast(`${res.updated}장 승인, ${res.failed.length}장 실패 — 미확정 클래스를 먼저 지정하세요`, 'bad');
        console.warn('승인 실패 목록', res.failed);
      } else {
        ok(`${res.updated}장 전체 승인`);
      }
      await refreshProgress();
      await loadFrames(doc ? doc.frame_id : null);
    } catch (e) {
      fail('전체 승인', e);
    }
  });

  // ── 키보드 ───────────────────────────────────────────────────────
  function onKeyDown(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === ' ') {
      spaceDown = true;
      e.preventDefault();
      return;
    }
    const shift = e.shiftKey;
    const k = e.key;

    if (/^[0-9]$/.test(k)) {
      const ci = k === '0' ? 9 : Number(k) - 1;
      if (sel >= 0 && ci < app.classes.length) {
        objs[sel].class_name = app.classes[ci];
        dirty = true;
        renderObjects();
      }
      return;
    }

    switch (k) {
      case '[':
        e.preventDefault();
        openFrame(idx - 1);
        return;
      case ']':
        e.preventDefault();
        openFrame(idx + 1);
        return;
      case 'Enter':
        e.preventDefault();
        approveNext();
        return;
      case 'Escape':
        sel = -1;
        renderObjects();
        return;
      case 'Tab':
        e.preventDefault();
        if (objs.length) {
          sel = (sel + 1) % objs.length;
          renderObjects();
        }
        return;
      case 'Delete':
      case 'Backspace':
        if (sel >= 0) {
          e.preventDefault();
          objs.splice(sel, 1);
          sel = -1;
          dirty = true;
          renderObjects();
        }
        return;
      default:
        break;
    }

    const lower = k.toLowerCase();
    if (lower === 's') {
      e.preventDefault();
      save({});
      return;
    }
    if (lower === 'r') {
      $('#reject', view).click();
      return;
    }
    if (sel < 0) return;
    const o = objs[sel];
    const step = shift ? 10 : 1;
    if (lower === 'q' || lower === 'e') {
      o.rect = { ...o.rect, a: o.rect.a + rad((lower === 'q' ? -1 : 1) * (shift ? 5 : 1)) };
      dirty = true;
      draw();
      renderObjects();
      return;
    }
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[k]) {
      e.preventDefault();
      o.rect = nudgeInside(
        { ...o.rect, cx: o.rect.cx + moves[k][0], cy: o.rect.cy + moves[k][1] },
        doc.width,
        doc.height,
      );
      dirty = true;
      draw();
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') spaceDown = false;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  // 페이지를 떠날 때 저장 안 된 수정이 있으면 브라우저 확인을 띄운다.
  const onBeforeUnload = (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  renderClassChips();
  await refreshProgress();
  await loadFrames();
  await renderTracks();
  resize();

  return {
    dispose() {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (dirty) save({ silent: true });
    },
  };
}
