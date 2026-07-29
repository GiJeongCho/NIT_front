/**
 * app.js — 부트스트랩 + 해시 라우팅 + 공유 상태
 *
 * 파이프라인 단계가 곧 화면이다(영상 → 구간 → 라벨링 → 데이터셋 → 학습 → 모델).
 * 단계 사이에 이어지는 값은 "작업 중인 영상" 하나뿐이므로 그것만 전역으로 들고
 * 나머지는 각 화면이 자기 상태를 갖는다(상태 관리 라이브러리 없이 유지되는 선).
 */

import { api, getApiBase, setApiBase } from './api.js';
import { $, esc, fail, on } from './util.js';

const VIDEO_KEY = 'nit_train.video_id';

/** 화면들이 공유하는 것: 서버 기본값(meta), 클래스 목록, 작업 중인 영상. */
export const app = {
  meta: null,
  classes: [],
  videoId: localStorage.getItem(VIDEO_KEY) || '',
  videoMeta: null,

  setVideo(id, meta = null) {
    this.videoId = id || '';
    this.videoMeta = meta;
    if (id) localStorage.setItem(VIDEO_KEY, id);
    else localStorage.removeItem(VIDEO_KEY);
    renderVideoChip();
  },

  /** 클래스 이름 → 인덱스. 인덱스가 곧 학습 클래스 id 이므로 서버 목록 순서를 그대로 쓴다. */
  classIndex(name) {
    return this.classes.indexOf(name);
  },

  async reloadClasses() {
    const doc = await api.classes.get();
    this.classes = doc.class_names || [];
    return this.classes;
  },

  classOptions(selected, { placeholder = '(미확정)' } = {}) {
    const opts = [`<option value="">${esc(placeholder)}</option>`];
    this.classes.forEach((n, i) => {
      const sel = n === selected ? ' selected' : '';
      opts.push(`<option value="${esc(n)}"${sel}>${i}. ${esc(n)}</option>`);
    });
    return opts.join('');
  },
};

const ROUTES = {
  videos: () => import('./views/videos.js'),
  segments: () => import('./views/segments.js'),
  label: () => import('./views/label.js'),
  datasets: () => import('./views/datasets.js'),
  train: () => import('./views/train.js'),
  models: () => import('./views/models.js'),
};

let current = null;

function parseHash() {
  const raw = (location.hash || '#/videos').replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: ROUTES[name] ? name : 'videos', params: rest.filter(Boolean) };
}

async function route() {
  const { name, params } = parseHash();
  const view = $('#view');

  // 이전 화면의 타이머·폴링·키 리스너를 반드시 끊는다. 안 그러면 학습 로그
  // 자동 새로고침이 다른 화면에서도 계속 돌아 서버를 두드린다.
  if (current && current.dispose) {
    try {
      current.dispose();
    } catch (e) {
      console.warn('dispose 실패', e);
    }
  }
  current = null;

  document.querySelectorAll('#tabs a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === name);
  });

  view.innerHTML = '<div class="loading">불러오는 중…</div>';
  view.classList.toggle('wide', name === 'label');
  try {
    const mod = await ROUTES[name]();
    current = (await mod.render(view, params, app)) || {};
  } catch (e) {
    fail('화면을 그릴 수 없습니다', e);
    view.innerHTML = `<div class="empty">화면을 그릴 수 없습니다.<br /><span class="mute2">${esc(
      e.message,
    )}</span></div>`;
  }
}

function renderVideoChip() {
  const chip = $('#video-chip');
  if (!chip) return;
  if (!app.videoId) {
    chip.textContent = '영상 미선택';
    chip.classList.remove('ok');
    return;
  }
  const name = (app.videoMeta && app.videoMeta.original_name) || app.videoId;
  chip.textContent = `▶ ${name}`;
  chip.title = `작업 중인 영상: ${app.videoId}`;
  chip.classList.add('ok');
}

async function connect() {
  const chip = $('#server-chip');
  chip.textContent = '연결 중…';
  chip.className = 'chip';
  try {
    app.meta = await api.meta();
    app.classes = app.meta.class_names || [];
    chip.textContent = `API ${app.meta.version} · ${app.meta.default_task || 'obb'} · ${
      app.meta.device === 'cpu' ? 'CPU' : `GPU ${app.meta.device}`
    }`;
    chip.classList.add('ok');
    if (!app.meta.default_model_exists) {
      const { toast } = await import('./util.js');
      toast(`기본 가중치가 없습니다: ${app.meta.default_model} — 자동 라벨을 쓸 수 없습니다`, 'bad');
    }
    return true;
  } catch (e) {
    chip.textContent = '서버 연결 실패';
    chip.classList.add('bad');
    fail('API 연결', e);
    return false;
  }
}

function serverDialog() {
  const dlg = $('#server-dlg');
  $('#api-base-input').value = getApiBase();
  $('#server-meta').innerHTML = app.meta
    ? `workspace: ${esc(app.meta.workspace)}<br />기본 가중치: ${esc(
        app.meta.default_model,
      )}<br />클래스 ${app.meta.class_names.length}개 · 기본 태스크 ${esc(app.meta.default_task)}`
    : '서버 정보를 아직 받지 못했습니다.';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    setApiBase($('#api-base-input').value);
    if (await connect()) route();
  };
  dlg.showModal();
}

async function boot() {
  $('#server-chip').addEventListener('click', serverDialog);
  $('#video-chip').addEventListener('click', () => {
    location.hash = app.videoId ? `#/segments/${app.videoId}` : '#/videos';
  });
  window.addEventListener('hashchange', route);

  // 영상 카드/표에서 어디서든 "이 영상으로 작업" 을 누를 수 있게 위임 처리한다.
  on(document.body, 'click', '[data-pick-video]', (e, el) => {
    e.preventDefault();
    app.setVideo(el.dataset.pickVideo);
    location.hash = el.dataset.pickGoto || `#/segments/${el.dataset.pickVideo}`;
  });

  await connect();
  renderVideoChip();
  await route();
}

boot();
