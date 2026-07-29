/**
 * api.js — NIT_train API 클라이언트
 *
 * 화면 코드가 URL 문자열을 직접 만들지 않게 모든 엔드포인트를 여기 모은다.
 * 서버가 실패를 `{"detail": "..."}` 로 주므로 그 메시지를 그대로 Error 로 올려
 * 토스트에 사람이 읽을 수 있는 이유가 뜨게 한다.
 */

const API_KEY = 'nit_train.api_base';
const DEFAULT_BASE = `${location.protocol}//${location.hostname}:8888`;

let base = (localStorage.getItem(API_KEY) || DEFAULT_BASE).replace(/\/+$/, '');

export const getApiBase = () => base;

export function setApiBase(value) {
  base = String(value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  localStorage.setItem(API_KEY, base);
}

export const url = (path) => `${base}${path}`;

async function request(method, path, body, { raw = false } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url(path), init);
  } catch (e) {
    throw new Error(`API 서버에 연결할 수 없습니다 (${base})`);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const doc = await res.json();
      if (doc && doc.detail) {
        detail = typeof doc.detail === 'string' ? doc.detail : JSON.stringify(doc.detail);
      }
    } catch {
      /* 본문이 JSON 이 아니면 상태줄을 그대로 쓴다 */
    }
    throw new Error(detail);
  }
  if (raw) return res.text();
  if (res.status === 204) return null;
  return res.json();
}

const get = (p) => request('GET', p);
const post = (p, b) => request('POST', p, b ?? {});
const put = (p, b) => request('PUT', p, b ?? {});
const del = (p) => request('DELETE', p);
const text = (p) => request('GET', p, null, { raw: true });

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * 업로드는 진행률이 필요해 fetch 대신 XHR 을 쓴다.
 * 수 GB 영상을 올리는 동안 사용자가 멈춘 줄 알고 새로고침하는 것을 막는다.
 */
export function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url('/api/videos'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let doc = null;
      try {
        doc = JSON.parse(xhr.responseText);
      } catch {
        /* 무시 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(doc);
      else reject(new Error((doc && doc.detail) || `업로드 실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('업로드 중 연결이 끊겼습니다'));
    xhr.send(form);
  });
}

export const api = {
  health: () => get('/healthz'),
  meta: () => get('/api/meta'),

  classes: {
    get: () => get('/api/classes'),
    put: (names) => put('/api/classes', { class_names: names }),
  },

  videos: {
    list: () => get('/api/videos'),
    get: (id) => get(`/api/videos/${id}`),
    registerPath: (path) => post('/api/videos/path', { path }),
    del: (id) => del(`/api/videos/${id}`),
    streamUrl: (id) => url(`/api/videos/${id}/stream`),
    frameUrl: (id, t) => url(`/api/videos/${id}/frame?t=${Number(t) || 0}`),

    segments: (id) => get(`/api/videos/${id}/segments`),
    putSegments: (id, segments) => put(`/api/videos/${id}/segments`, { segments }),
    selection: (id, kinds = ['normal']) => get(`/api/videos/${id}/selection${qs({ kinds })}`),

    extract: (id, opts) => post(`/api/videos/${id}/extract`, opts),
    progress: (id) => get(`/api/videos/${id}/progress`),
    frames: (id, opts) => get(`/api/videos/${id}/frames${qs(opts)}`),
    tracks: (id) => get(`/api/videos/${id}/tracks`),

    frame: (id, fid) => get(`/api/videos/${id}/frames/${fid}`),
    frameImageUrl: (id, fid, overlay = false) =>
      url(`/api/videos/${id}/frames/${fid}/image${overlay ? '?overlay=1' : ''}`),
    saveFrame: (id, fid, payload) => put(`/api/videos/${id}/frames/${fid}`, payload),
    setStatus: (id, fid, status, force = false) =>
      post(`/api/videos/${id}/frames/${fid}/status`, { status, force }),
    bulkStatus: (id, status, frameIds, force = false) =>
      post(`/api/videos/${id}/frames/status`, { status, frame_ids: frameIds, force }),
    propagate: (id, trackId, className) =>
      post(`/api/videos/${id}/propagate`, { track_id: trackId, class_name: className }),
    delFrame: (id, fid) => del(`/api/videos/${id}/frames/${fid}`),
  },

  datasets: {
    list: () => get('/api/datasets'),
    get: (id) => get(`/api/datasets/${id}`),
    create: (spec) => post('/api/datasets', spec),
    import: (spec) => post('/api/datasets/import', spec),
    inspect: (path) => get(`/api/datasets/inspect${qs({ path })}`),
    yaml: (id) => text(`/api/datasets/${id}/data.yaml`),
    del: (id) => del(`/api/datasets/${id}`),
  },

  train: {
    list: () => get('/api/train'),
    start: (spec) => post('/api/train', spec),
    status: (runId, logLines = 200) => get(`/api/train/${runId}${qs({ log_lines: logLines })}`),
    stop: (runId) => post(`/api/train/${runId}/stop`),
    resume: (runId) => post(`/api/train/${runId}/resume`),
    log: (runId, lines = 500) => text(`/api/train/${runId}/log${qs({ lines })}`),
    weightsUrl: (runId, which) => url(`/api/train/${runId}/weights/${which}`),
    del: (runId) => del(`/api/train/${runId}`),
  },

  models: {
    list: () => get('/api/models'),
    weights: () => get('/api/detector/weights'),
    promote: (spec) => post('/api/models/promote', spec),
    unpromote: (alias) => del(`/api/models/${alias}`),
  },

  jobs: {
    list: (opts) => get(`/api/jobs${qs(opts)}`),
    get: (jobId) => get(`/api/jobs/${jobId}`),
    cancel: (jobId) => post(`/api/jobs/${jobId}/cancel`),
  },
};

/**
 * 작업이 끝날 때까지 폴링한다. `onTick` 으로 진행률을 화면에 반영한다.
 * 서버가 잡을 스레드에서 돌리므로 프런트는 이 함수 하나로 추출/데이터셋 빌드를 다룬다.
 */
export async function pollJob(jobId, onTick, intervalMs = 1200) {
  for (;;) {
    const doc = await api.jobs.get(jobId);
    if (onTick) onTick(doc);
    if (!['queued', 'running'].includes(doc.status)) return doc;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
