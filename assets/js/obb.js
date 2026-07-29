/**
 * obb.js — 회전 박스(OBB) 기하
 *
 * 서버 라벨은 항상 **픽셀 4점 폴리곤**이고 점 순서는 ultralytics 규약(시계방향,
 * 좌상 → 우상 → 우하 → 좌하)이다. 그런데 편집을 4점 자유 이동으로 만들면 사용자가
 * 조금만 잘못 끌어도 사각형이 아닌 사다리꼴이 되고, 그 라벨은 YOLO OBB 학습에서
 * 조용히 이상한 각도로 해석된다.
 *
 * 그래서 편집 중에는 `{cx, cy, w, h, a}`(중심 · 폭 · 높이 · 라디안 각) 로 다루고
 * 저장할 때만 4점으로 되돌린다. 이렇게 하면 어떤 조작을 해도 결과가 항상 직사각형이다.
 */

export const TAU = Math.PI * 2;

export const deg = (rad) => (rad * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

/** 4점 폴리곤 → 회전 사각형. p0→p1 을 폭 방향, p0→p3 을 높이 방향으로 읽는다. */
export function rectFromPoly(poly) {
  const p = (poly || []).map((q) => [Number(q[0]) || 0, Number(q[1]) || 0]);
  if (p.length !== 4) {
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    const x1 = Math.min(...xs);
    const y1 = Math.min(...ys);
    const x2 = Math.max(...xs);
    const y2 = Math.max(...ys);
    return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1, a: 0 };
  }
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  const wx = p[1][0] - p[0][0];
  const wy = p[1][1] - p[0][1];
  const hx = p[3][0] - p[0][0];
  const hy = p[3][1] - p[0][1];
  return {
    cx,
    cy,
    w: Math.hypot(wx, wy),
    h: Math.hypot(hx, hy),
    a: Math.atan2(wy, wx),
  };
}

/** 회전 사각형 → 시계방향 4점 폴리곤. */
export function polyFromRect(r) {
  const ca = Math.cos(r.a);
  const sa = Math.sin(r.a);
  const ux = [ca, sa];            // 폭 방향 단위벡터
  const uy = [-sa, ca];           // 높이 방향 단위벡터
  const hw = r.w / 2;
  const hh = r.h / 2;
  const at = (sx, sy) => [
    r.cx + ux[0] * hw * sx + uy[0] * hh * sy,
    r.cy + ux[1] * hw * sx + uy[1] * hh * sy,
  ];
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

/** 꼭짓점 4개(폴리곤과 같은 순서). 리사이즈 핸들 위치. */
export const cornersOf = (r) => polyFromRect(r);

/** 회전 핸들 위치. 위쪽 변 바깥으로 `pad` 픽셀 떨어뜨린다. */
export function rotateHandleOf(r, pad = 22) {
  const ca = Math.cos(r.a);
  const sa = Math.sin(r.a);
  return [r.cx + sa * (r.h / 2 + pad), r.cy - ca * (r.h / 2 + pad)];
}

/**
 * 꼭짓점 드래그. 반대쪽 꼭짓점을 세계 좌표에 고정한 채 폭/높이/중심만 다시 계산한다.
 * 각도는 유지되고, 뒤집어 끌어도(음수) 절댓값으로 정상 사각형이 된다.
 */
export function resizeByCorner(rect, cornerIndex, fixedCorner, mouse) {
  const ca = Math.cos(rect.a);
  const sa = Math.sin(rect.a);
  const dx = mouse[0] - fixedCorner[0];
  const dy = mouse[1] - fixedCorner[1];
  const along = dx * ca + dy * sa;        // 폭 방향 성분
  const across = dx * -sa + dy * ca;      // 높이 방향 성분
  return {
    ...rect,
    w: Math.abs(along),
    h: Math.abs(across),
    cx: fixedCorner[0] + (ca * along - sa * across) / 2,
    cy: fixedCorner[1] + (sa * along + ca * across) / 2,
  };
}

/** 회전 핸들 드래그 → 각도. 핸들이 항상 "위쪽" 을 가리키게 맞춘다. */
export function angleFromHandle(rect, mouse) {
  return Math.atan2(mouse[1] - rect.cy, mouse[0] - rect.cx) + Math.PI / 2;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 새로 그린 드래그 영역 → 축정렬 사각형(각도 0). */
export function rectFromDrag(p1, p2) {
  return {
    cx: (p1[0] + p2[0]) / 2,
    cy: (p1[1] + p2[1]) / 2,
    w: Math.abs(p2[0] - p1[0]),
    h: Math.abs(p2[1] - p1[1]),
    a: 0,
  };
}

/**
 * 이미지 밖으로 나간 박스를 되돌린다.
 * 회전된 사각형은 잘라내면(clamp) 사각형이 아니게 되므로, 폴리곤 전체가 들어오도록
 * 중심만 평행이동한다. 이미지보다 큰 박스는 그대로 둔다(서버가 좌표를 클램프한다).
 */
export function nudgeInside(rect, width, height) {
  const poly = polyFromRect(rect);
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  let dx = 0;
  let dy = 0;
  if (Math.min(...xs) < 0) dx = -Math.min(...xs);
  if (Math.max(...xs) + dx > width) dx -= Math.max(...xs) + dx - width;
  if (Math.min(...ys) < 0) dy = -Math.min(...ys);
  if (Math.max(...ys) + dy > height) dy -= Math.max(...ys) + dy - height;
  return { ...rect, cx: rect.cx + dx, cy: rect.cy + dy };
}
