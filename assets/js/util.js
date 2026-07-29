/**
 * util.js — DOM/포맷 헬퍼
 *
 * 빌드 도구를 쓰지 않으므로 화면은 템플릿 문자열 + innerHTML 로 그린다.
 * 서버가 주는 값에 사용자가 입력한 파일명·클래스명·노트가 섞여 있어
 * 삽입 지점은 예외 없이 `esc()` 를 거친다.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** HTML 특수문자 이스케이프. 템플릿에 값을 넣을 때 항상 통과시킨다. */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 초 → `1:23.4`. 타임라인/구간 표시 전용. */
export function fmtSec(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

/** 초 → `1h 02m` / `3m 12s`. 소요시간 표시용. */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export function fmtMB(mb) {
  const v = Number(mb) || 0;
  return v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${v.toFixed(1)} MB`;
}

export const pct = (v) => `${Math.round((Number(v) || 0) * 1000) / 10}%`;

export const num = (v, digits = 3) =>
  v === null || v === undefined || v === '' ? '-' : Number(v).toFixed(digits);

/** ISO 타임스탬프 → `07-29 16:48`. 목록에서 초는 불필요한 소음이다. */
export function fmtWhen(iso) {
  if (!iso) return '-';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(iso);
}

export function toast(msg, kind = '') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = String(msg);
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3600);
}

export const ok = (m) => toast(m, 'ok');
export const err = (m) => toast(m, 'bad');

/** 에러를 토스트로 보여주고 콘솔에 원본을 남긴다. */
export function fail(prefix, e) {
  console.error(prefix, e);
  err(`${prefix}: ${e && e.message ? e.message : e}`);
}

export function debounce(fn, ms = 250) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 클래스 인덱스 → 색. 서버(`annotations.color_for`)와 같은 황금비 분할을 쓴다.
 * 검수 화면의 오버레이 JPEG 와 캔버스에서 그린 박스 색이 일치해야 혼란이 없다.
 */
export function classColor(index) {
  if (index === null || index === undefined || index < 0) return '#a0a0a0';
  const h = (((Number(index) + 1) * 0.61803398875) % 1) * 360;
  return `hsl(${h.toFixed(1)}, 85%, 58%)`;
}

export function badge(text, kind = '') {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

export function statusBadge(status) {
  const map = { approved: 'ok', pending: 'warn', rejected: 'bad' };
  return badge(status || '-', map[status] || '');
}

export function bar(ratio, kind = '') {
  const w = clamp((Number(ratio) || 0) * 100, 0, 100);
  return `<div class="bar ${kind}"><i style="width:${w}%"></i></div>`;
}

/** 막대 히스토그램. 클래스 불균형을 학습 전에 눈으로 보게 하는 용도. */
export function histogram(obj, limit = 20) {
  const rows = Object.entries(obj || {});
  if (!rows.length) return '<div class="mute2">데이터 없음</div>';
  const max = Math.max(...rows.map(([, v]) => v));
  return `<div class="hist">${rows
    .slice(0, limit)
    .map(
      ([k, v]) => `<div class="hist-row">
        <span class="nowrap" title="${esc(k)}">${esc(k)}</span>
        <div class="hb" style="width:${Math.max(2, (v / max) * 100)}%"></div>
        <span class="right mono">${v}</span>
      </div>`,
    )
    .join('')}</div>`;
}

export function confirmAction(message) {
  return window.confirm(message);
}

/** 이벤트 위임. 목록을 다시 그려도 리스너를 다시 붙일 필요가 없다. */
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}
