/**
 * views/models.js — 6단계: 가중치 목록과 승격/배포
 *
 * `runs/<run_id>/train/weights/best.pt` 는 실험 산출물이라 run 을 지우면 사라진다.
 * 승격(promote)은 그 파일을 `workspace/models/<alias>.pt` 로 복사해 고정하고
 * "어떤 데이터셋·어떤 지표에서 나왔는지" 를 함께 남긴다. 모델 파일만 남고 출처를
 * 아무도 모르는 상황을 막는 것이 이 화면의 목적이다.
 */

import { api } from '../api.js';
import { $, badge, confirmAction, esc, fail, fmtWhen, num, ok, on } from '../util.js';

export async function render(view, params, app) {
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>6 · 모델</h1>
        <div class="sub">쓸 수 있는 가중치 전체와 배포 후보(승격) 이력.</div>
      </div>
      <div class="grow"></div>
      <a class="btn ghost" href="#/train">← 학습</a>
      <button class="btn ghost" id="reload">새로고침</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>배포 후보 (승격됨)</h2>
        <span class="muted" id="pr-count"></span>
      </div>
      <div class="table-wrap" id="promoted"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>사용 가능한 가중치</h2>
        <span class="muted" id="w-count"></span>
      </div>
      <p class="muted" style="font-size:12.5px">
        <code>test_model/</code> 사전학습 · <code>workspace/models/</code> 승격 ·
        <code>workspace/runs/*/train/weights/</code> 학습 산출물. 자동 라벨과 학습의 선택 목록이 이것이다.
      </p>
      <div class="table-wrap" id="weights"></div>
    </div>
  `;

  async function reload() {
    let doc;
    try {
      doc = await api.models.list();
    } catch (e) {
      fail('모델 목록', e);
      return;
    }

    const promoted = doc.promoted || [];
    $('#pr-count', view).textContent = `${promoted.length}개`;
    $('#promoted', view).innerHTML = promoted.length
      ? `<table><thead><tr>
           <th>이름</th><th>태스크</th><th class="num">mAP50</th><th>출처</th>
           <th class="num">크기</th><th>배포</th><th>승격 시각</th><th></th>
         </tr></thead><tbody>${promoted
           .map((m) => {
             const map50 = (m.metrics || {})['metrics/mAP50(B)'];
             return `<tr>
               <td><b>${esc(m.alias)}</b>${m.note ? `<div class="mute2" style="font-size:11.5px">${esc(
               m.note,
             )}</div>` : ''}</td>
               <td>${badge(m.task || '-', m.task === 'obb' ? 'info' : '')}</td>
               <td class="num">${map50 === undefined ? '-' : num(map50, 3)}</td>
               <td class="mute2" style="font-size:11.5px">
                 ${esc(m.dataset_name || m.dataset_id || '')}<br />
                 <span class="mono">${esc(m.run_id)} · ${esc(m.which)} · ${esc(m.base_model || '')}</span>
               </td>
               <td class="num">${m.size_mb} MB</td>
               <td class="mute2 mono" style="font-size:11px">${
                 m.deployed_to ? esc(m.deployed_to) : '<span class="mute2">-</span>'
               }</td>
               <td class="mute2 mono">${fmtWhen(m.promoted_at)}</td>
               <td class="right"><button class="btn sm ghost" data-unpromote="${esc(
                 m.alias,
               )}">승격 취소</button></td>
             </tr>`;
           })
           .join('')}</tbody></table>`
      : `<div class="empty">승격된 모델이 없습니다. <a href="#/train">학습</a> 상세에서 승격하세요.</div>`;

    const weights = doc.weights || [];
    $('#w-count', view).textContent = `${weights.length}개`;
    $('#weights', view).innerHTML = weights.length
      ? `<table><thead><tr>
           <th>파일</th><th>출처</th><th>태스크</th><th class="num">크기</th>
         </tr></thead><tbody>${weights
           .map(
             (w) => `<tr>
               <td>
                 <b>${esc(w.name)}</b>
                 ${w.is_default ? badge('기본', 'info') : ''}
                 <div class="mute2 mono" style="font-size:10.5px">${esc(w.path || w.abs_path || '')}</div>
               </td>
               <td>${badge(w.origin, '')}</td>
               <td>${w.task ? badge(w.task, w.task === 'obb' ? 'info' : '') : '<span class="mute2">-</span>'}</td>
               <td class="num">${w.size_mb ?? '-'} MB</td>
             </tr>`,
           )
           .join('')}</tbody></table>`
      : '<div class="empty">가중치가 없습니다.</div>';
  }

  on(view, 'click', '[data-unpromote]', async (e, el) => {
    const alias = el.dataset.unpromote;
    if (!confirmAction(`${alias} 의 가중치 파일과 승격 이력을 지웁니다. 계속할까요?`)) return;
    try {
      await api.models.unpromote(alias);
      ok('승격을 취소했습니다');
      await reload();
    } catch (e2) {
      fail('승격 취소', e2);
    }
  });

  $('#reload', view).addEventListener('click', reload);
  await reload();
  return {};
}
