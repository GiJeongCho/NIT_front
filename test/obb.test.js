/**
 * test/obb.test.js — 회전박스 기하 자체 검증
 *
 * 라벨 좌표가 틀리면 학습이 조용히 망가진다(에러 없이 mAP 만 낮아진다).
 * 그래서 편집 중에 쓰는 변환이 다음을 만족하는지 브라우저 없이 확인한다.
 *
 * 1. 폴리곤 → 사각형 → 폴리곤 왕복이 원본과 같다.
 * 2. 어떤 조작(이동·리사이즈·회전) 후에도 결과가 항상 **직사각형**이다.
 * 3. 꼭짓점 드래그는 반대쪽 꼭짓점을 세계 좌표에 고정한다.
 * 4. 회전 핸들 방향과 각도가 일치한다.
 *
 * 실행: node NIT_train_front/test/obb.test.js
 */

import assert from 'node:assert/strict';

import {
  angleFromHandle,
  cornersOf,
  deg,
  nudgeInside,
  pointInPoly,
  polyFromRect,
  rad,
  rectFromDrag,
  rectFromPoly,
  resizeByCorner,
  rotateHandleOf,
} from '../assets/js/obb.js';

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [OK]   ${name}`);
  } catch (e) {
    console.log(`  [FAIL] ${name}\n         ${e.message}`);
    process.exitCode = 1;
  }
}

const near = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} 아님 (차 ${Math.abs(a - b)})`);

const polyNear = (a, b, tol = 1e-6) => {
  assert.equal(a.length, b.length);
  a.forEach((p, i) => {
    near(p[0], b[i][0], tol);
    near(p[1], b[i][1], tol);
  });
};

/** 네 각이 모두 90°인지 = 직사각형인지 검사. */
function assertRectangular(poly, tol = 1e-6) {
  for (let i = 0; i < 4; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % 4];
    const p2 = poly[(i + 2) % 4];
    const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
    const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    const scaleFactor = Math.hypot(...v1) * Math.hypot(...v2) || 1;
    assert.ok(Math.abs(dot / scaleFactor) <= tol, `꼭짓점 ${i} 의 각이 90° 가 아님`);
  }
}

console.log('\nobb.js — 회전박스 기하');

test('축정렬 폴리곤 왕복', () => {
  const poly = [
    [10, 20],
    [110, 20],
    [110, 80],
    [10, 80],
  ];
  const r = rectFromPoly(poly);
  near(r.cx, 60);
  near(r.cy, 50);
  near(r.w, 100);
  near(r.h, 60);
  near(r.a, 0);
  polyNear(polyFromRect(r), poly);
});

test('회전 폴리곤 왕복 (30°)', () => {
  const src = { cx: 320, cy: 240, w: 120, h: 40, a: rad(30) };
  const poly = polyFromRect(src);
  const r = rectFromPoly(poly);
  near(r.cx, src.cx, 1e-9);
  near(r.cy, src.cy, 1e-9);
  near(r.w, src.w, 1e-9);
  near(r.h, src.h, 1e-9);
  near(r.a, src.a, 1e-9);
  assertRectangular(poly);
});

test('음수 각도(-100°)도 왕복', () => {
  const src = { cx: 100, cy: 100, w: 55, h: 90, a: rad(-100) };
  polyNear(polyFromRect(rectFromPoly(polyFromRect(src))), polyFromRect(src), 1e-9);
});

test('점 순서가 시계방향(좌상→우상→우하→좌하)', () => {
  const poly = polyFromRect({ cx: 50, cy: 50, w: 40, h: 20, a: 0 });
  polyNear(poly, [
    [30, 40],
    [70, 40],
    [70, 60],
    [30, 60],
  ]);
});

test('꼭짓점 리사이즈: 반대 꼭짓점이 고정되고 직사각형 유지', () => {
  const rect = { cx: 200, cy: 150, w: 80, h: 60, a: rad(25) };
  const corners = cornersOf(rect);
  const fixed = corners[2];                       // 0번을 끌면 2번이 고정
  const next = resizeByCorner(rect, 0, fixed, [corners[0][0] - 30, corners[0][1] - 20]);
  const after = cornersOf(next);
  polyNear([after[2]], [fixed], 1e-9);            // 고정점 불변
  near(next.a, rect.a, 1e-12);                    // 각도 불변
  assertRectangular(polyFromRect(next), 1e-9);
  assert.ok(next.w > rect.w && next.h > rect.h, '끌어당긴 방향으로 커져야 한다');
});

test('꼭짓점을 반대로 끌어도(뒤집힘) 양수 크기 유지', () => {
  const rect = { cx: 100, cy: 100, w: 40, h: 30, a: 0 };
  const fixed = cornersOf(rect)[2];
  const next = resizeByCorner(rect, 0, fixed, [fixed[0] + 25, fixed[1] + 15]);
  assert.ok(next.w > 0 && next.h > 0);
  assertRectangular(polyFromRect(next), 1e-9);
});

test('회전 핸들 ↔ 각도 일치', () => {
  for (const d of [0, 17, 90, 180, -45, 260]) {
    const rect = { cx: 300, cy: 200, w: 90, h: 50, a: rad(d) };
    const handle = rotateHandleOf(rect, 22);
    const back = angleFromHandle(rect, handle);
    // 각도는 2π 주기이므로 방향 벡터로 비교한다.
    near(Math.cos(back), Math.cos(rect.a), 1e-9);
    near(Math.sin(back), Math.sin(rect.a), 1e-9);
  }
});

test('회전 핸들은 위쪽 변 바깥에 있다', () => {
  const rect = { cx: 100, cy: 100, w: 60, h: 40, a: 0 };
  const [hx, hy] = rotateHandleOf(rect, 20);
  near(hx, 100);
  near(hy, 100 - 20 - 20);
});

test('드래그로 만든 박스는 축정렬', () => {
  const r = rectFromDrag([200, 100], [140, 160]);
  near(r.cx, 170);
  near(r.cy, 130);
  near(r.w, 60);
  near(r.h, 60);
  near(r.a, 0);
});

test('점 포함 판정 (회전 박스)', () => {
  const rect = { cx: 100, cy: 100, w: 80, h: 20, a: rad(45) };
  const poly = polyFromRect(rect);
  assert.ok(pointInPoly([100, 100], poly), '중심은 안에 있어야 한다');
  assert.ok(!pointInPoly([100, 60], poly), '회전 후 바깥인 점은 밖이어야 한다');
  assert.ok(pointInPoly([120, 120], poly), '긴 축 방향 점은 안에 있어야 한다');
});

test('이미지 밖으로 나간 박스는 평행이동으로 되돌린다', () => {
  const rect = { cx: 5, cy: 5, w: 40, h: 30, a: 0 };
  const fixedRect = nudgeInside(rect, 640, 480);
  const poly = polyFromRect(fixedRect);
  assert.ok(Math.min(...poly.map((p) => p[0])) >= -1e-9);
  assert.ok(Math.min(...poly.map((p) => p[1])) >= -1e-9);
  near(fixedRect.w, rect.w);                      // 크기는 건드리지 않는다
  near(fixedRect.h, rect.h);
  assertRectangular(poly, 1e-9);
});

test('회전된 박스가 경계를 넘어도 직사각형이 유지된다', () => {
  const rect = { cx: 630, cy: 470, w: 100, h: 60, a: rad(37) };
  const poly = polyFromRect(nudgeInside(rect, 640, 480));
  assertRectangular(poly, 1e-9);
  assert.ok(Math.max(...poly.map((p) => p[0])) <= 640 + 1e-9);
  assert.ok(Math.max(...poly.map((p) => p[1])) <= 480 + 1e-9);
});

test('deg/rad 왕복', () => {
  near(deg(rad(123.5)), 123.5, 1e-9);
});

console.log(`\n결과: ${passed}개 통과${process.exitCode ? ' / 실패 있음' : ''}\n`);
