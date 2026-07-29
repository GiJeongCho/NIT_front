/**
 * views/videos.js — 1단계: 학습 소재 영상 등록
 *
 * 업로드(드래그&드롭)와 "서버 경로 등록" 두 가지를 함께 둔다. 수십 GB 드론 영상을
 * 브라우저로 다시 올리는 것은 낭비이므로, NAS/서버에 이미 있는 파일은 경로만 등록해
 * 복사 없이 파이프라인에 넣는다.
 *
 * 카드마다 다음 단계로 가는 버튼을 둔다 — 사용자가 "이제 뭘 눌러야 하지" 를
 * 고민하지 않게 파이프라인 순서를 UI 로 강제한다.
 */

import { api, uploadVideo } from '../api.js';
import { $, bar, badge, confirmAction, esc, fail, fmtDur, fmtMB, fmtWhen, ok, on, pct } from '../util.js';

export async function render(view, params, app) {
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>1 · 영상</h1>
        <div class="sub">학습에 쓸 드론/CCTV 영상을 등록한다. 등록하면 구간 지정으로 넘어간다.</div>
      </div>
      <div class="grow"></div>
      <button class="btn ghost" id="reload">새로고침</button>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h2>업로드</h2></div>
        <div class="drop" id="drop">
          <b>영상 파일을 끌어다 놓거나 클릭</b>
          <div class="mute2" id="drop-ext">mp4 · avi · mov · mkv · webm</div>
        </div>
        <input type="file" id="file" class="hidden" multiple accept="video/*" />
        <div id="upload-progress" class="col" style="margin-top:10px"></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>서버 경로 등록 (복사 없음)</h2></div>
        <p class="muted">
          서버나 마운트된 NAS 에 이미 있는 영상은 복사하지 않고 등록한다.
          수십 GB 를 중복 저장하지 않기 위한 경로다.
        </p>
        <div class="row">
          <input type="text" id="path" class="grow" placeholder="D:\\drone\\2026-07-29\\flight_01.mp4" />
          <button class="btn primary" id="add-path">등록</button>
        </div>
        <div class="note info" style="margin-top:10px">
          원본이 지워지면 프레임 재추출이 불가능하다(<code>managed=false</code>).
          이미 만들어진 데이터셋은 이미지를 자체 보관하므로 영향받지 않는다.
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>등록된 영상</h2>
        <span class="muted" id="count"></span>
      </div>
      <div id="list"><div class="loading">불러오는 중…</div></div>
    </div>
  `;

  const list = $('#list', view);
  const progressBox = $('#upload-progress', view);

  async function reload() {
    try {
      const doc = await api.videos.list();
      const items = doc.items || [];
      $('#count', view).textContent = `${items.length}개`;
      list.innerHTML = items.length
        ? `<div class="vcards">${items.map(card).join('')}</div>`
        : `<div class="empty">등록된 영상이 없습니다. 위에서 업로드하거나 서버 경로를 등록하세요.</div>`;
    } catch (e) {
      fail('영상 목록', e);
      list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function card(v) {
    const seg = v.segments || {};
    const lab = v.labeling || {};
    const thumbAt = Math.min(1, (v.duration_sec || 2) / 2);
    const active = v.video_id === app.videoId ? ' active' : '';
    const segLine = seg.total
      ? `${badge(`정상 ${seg.normal}개 / ${fmtDur(seg.normal_sec)}`, 'ok')}
         ${seg.abnormal ? badge(`비정상 ${seg.abnormal}개 / ${fmtDur(seg.abnormal_sec)}`, 'bad') : ''}`
      : `<span class="mute2">구간 미지정 (전체를 정상으로 봄)</span>`;
    const labLine = lab.frames
      ? `${bar(lab.approved_ratio, lab.approved_ratio >= 1 ? 'ok' : '')}
         <div class="mute2 mono" style="margin-top:3px">
           프레임 ${lab.frames} · 승인 ${lab.approved} (${pct(lab.approved_ratio)})
           · 객체 ${lab.objects}${lab.unresolved_objects ? ` · 미확정 ${lab.unresolved_objects}` : ''}
         </div>`
      : `<span class="mute2">프레임 미추출</span>`;

    return `<article class="vcard${active}">
      <div class="thumb" data-pick-video="${esc(v.video_id)}"
           data-pick-goto="#/segments/${esc(v.video_id)}"
           style="background-image:url('${esc(api.videos.frameUrl(v.video_id, thumbAt))}')"
           title="클릭하면 이 영상으로 구간 지정"></div>
      <div class="body">
        <div class="name" title="${esc(v.original_name)}">${esc(v.original_name)}</div>
        <div class="meta">
          ${v.width}×${v.height} · ${v.fps}fps · ${fmtDur(v.duration_sec)} · ${fmtMB(v.size_mb)}
          ${v.managed ? '' : ' · 외부파일'}
        </div>
        <div class="row tight">${segLine}</div>
        <div>${labLine}</div>
        <div class="row tight">
          <button class="btn sm primary" data-pick-video="${esc(v.video_id)}"
                  data-pick-goto="#/segments/${esc(v.video_id)}">구간 지정</button>
          <button class="btn sm" data-pick-video="${esc(v.video_id)}"
                  data-pick-goto="#/label/${esc(v.video_id)}"
                  ${lab.frames ? '' : 'disabled title="먼저 프레임을 추출하세요"'}>라벨링</button>
          <div class="grow"></div>
          <button class="btn sm ghost" data-del="${esc(v.video_id)}" title="프레임·라벨까지 삭제">삭제</button>
        </div>
        <div class="mute2 mono" style="font-size:10.5px">${esc(v.video_id)} · ${fmtWhen(v.created_at)}</div>
      </div>
    </article>`;
  }

  // ── 업로드 ────────────────────────────────────────────────────────
  const drop = $('#drop', view);
  const fileInput = $('#file', view);
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  async function handleFiles(files) {
    // 한 번에 여러 개를 올릴 수 있지만 순차로 보낸다. 동시 업로드는 디스크
    // 쓰기를 서로 방해해 전체 시간이 오히려 늘어난다.
    for (const file of Array.from(files || [])) {
      const row = document.createElement('div');
      row.innerHTML = `<div class="mute2 mono">${esc(file.name)} · ${fmtMB(file.size / 1e6)}</div>
                       ${bar(0)}`;
      progressBox.appendChild(row);
      const fill = row.querySelector('.bar > i');
      try {
        const meta = await uploadVideo(file, (r) => {
          fill.style.width = `${r * 100}%`;
        });
        row.querySelector('.bar').classList.add('ok');
        fill.style.width = '100%';
        ok(`업로드 완료: ${meta.original_name} (${meta.width}×${meta.height}, ${fmtDur(meta.duration_sec)})`);
        if (!app.videoId) app.setVideo(meta.video_id, meta);
        await reload();
      } catch (e) {
        fail(`업로드 실패 (${file.name})`, e);
        row.querySelector('.bar').classList.add('bad');
      }
      setTimeout(() => row.remove(), 4000);
    }
    fileInput.value = '';
  }

  $('#add-path', view).addEventListener('click', async () => {
    const path = $('#path', view).value.trim();
    if (!path) return;
    try {
      const meta = await api.videos.registerPath(path);
      ok(`등록 완료: ${meta.original_name}`);
      $('#path', view).value = '';
      if (!app.videoId) app.setVideo(meta.video_id, meta);
      await reload();
    } catch (e) {
      fail('경로 등록', e);
    }
  });

  $('#reload', view).addEventListener('click', reload);

  on(list, 'click', '[data-del]', async (e, el) => {
    const id = el.dataset.del;
    if (!confirmAction(`영상 ${id} 과 추출된 프레임·라벨을 모두 지웁니다. 계속할까요?`)) return;
    try {
      await api.videos.del(id);
      if (app.videoId === id) app.setVideo('');
      ok('삭제했습니다');
      await reload();
    } catch (e2) {
      fail('삭제', e2);
    }
  });

  if (app.meta) {
    $('#drop-ext', view).textContent = 'mp4 · avi · mov · mkv · webm · m4v · mpg';
  }

  await reload();
  return {};
}
