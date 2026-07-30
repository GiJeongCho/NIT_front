"""
test/api_contract.py — 프런트가 기대하는 API 응답 계약 검증

프런트는 서버 응답의 **필드 이름**에 의존한다. 백엔드가 필드를 하나 바꾸면 화면은
에러 없이 조용히 "-" 나 `undefined` 를 그린다. 그런 실패는 눈으로만 잡히므로
브라우저 없이 계약을 확인하는 테스트를 둔다.

파이프라인을 실제로 한 바퀴 돌리고(업로드 → 구간 → 추출/자동라벨 → 검수 →
데이터셋 등록·병합), 각 응답에서 **화면 코드가 실제로 읽는 키**가 있는지 본다.
회전박스 좌표는 프런트가 쓰는 `{cx,cy,w,h,angle}` ↔ 4점 폴리곤 왕복까지 확인한다.

백엔드 환경(NIT)이 필요하다. 서버를 따로 띄우지 않고 앱을 in-process 로 올린다::

    conda activate NIT
    python NIT_train_front/test/api_contract.py
"""

from __future__ import annotations

import math
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

FRONT_DIR = Path(__file__).resolve().parents[1]
BACKEND_APP = FRONT_DIR.parent / "NIT_train" / "src" / "v1"
sys.path.insert(0, str(BACKEND_APP))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

_WS = Path(tempfile.mkdtemp(prefix="nitfront-contract-"))
os.environ["NIT_TRAIN_WORKSPACE"] = str(_WS)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

OBB_SOURCE = Path(r"C:\project\tracker_py\train_data\preprocessed_obb")
REAL_FRAMES = OBB_SOURCE / "train" / "images"

_ok = 0
_fail = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global _ok, _fail
    if cond:
        _ok += 1
        print(f"  [OK]   {label}" + (f" — {detail}" if detail else ""))
    else:
        _fail += 1
        print(f"  [FAIL] {label}" + (f" — {detail}" if detail else ""))


def has_keys(label: str, doc: dict, keys) -> None:
    """프런트가 읽는 키가 응답에 있는지. 값이 None 인 것은 허용한다."""
    missing = [k for k in keys if k not in (doc or {})]
    check(label, not missing, f"없는 키: {missing}" if missing else f"{len(keys)}개 확인")


def make_video(path: Path, seconds: int = 4, fps: int = 30) -> str:
    """자동 라벨/트래킹이 실제로 뭔가를 탐지하도록 실제 프레임으로 영상을 만든다."""
    w, h = 640, 480
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    total = seconds * fps
    reals = sorted(REAL_FRAMES.glob("*.jpg"))[:40] if REAL_FRAMES.exists() else []
    if reals:
        hold = max(1, total // len(reals))
        written = 0
        img = None
        for p in reals:
            img = cv2.imread(str(p))
            if img is None:
                continue
            img = cv2.resize(img, (w, h))
            for _ in range(hold):
                writer.write(img)
                written += 1
        while written < total and img is not None:
            writer.write(img)
            written += 1
        writer.release()
        return f"real({len(reals)} frames)"
    for i in range(total):
        frame = np.full((h, w, 3), 40, dtype=np.uint8)
        x = int(60 + (w - 200) * (i / max(1, total - 1)))
        cv2.rectangle(frame, (x, 200), (x + 90, 280), (200, 200, 200), -1)
        writer.write(frame)
    writer.release()
    return "synthetic"


# ── 프런트 obb.js 와 같은 변환 (계약 검증용 파이썬 구현) ───────────────
def poly_from_rect(cx, cy, w, h, a):
    ca, sa = math.cos(a), math.sin(a)
    ux, uy = (ca, sa), (-sa, ca)
    hw, hh = w / 2, h / 2
    at = lambda sx, sy: [cx + ux[0] * hw * sx + uy[0] * hh * sy,  # noqa: E731
                         cy + ux[1] * hw * sx + uy[1] * hh * sy]
    return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]


def rect_from_poly(poly):
    cx = sum(p[0] for p in poly) / 4
    cy = sum(p[1] for p in poly) / 4
    wx, wy = poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]
    hx, hy = poly[3][0] - poly[0][0], poly[3][1] - poly[0][1]
    return cx, cy, math.hypot(wx, wy), math.hypot(hx, hy), math.atan2(wy, wx)


def poll(client, job_id, timeout=900):
    deadline = time.time() + timeout
    doc = {}
    while time.time() < deadline:
        doc = client.get(f"/api/jobs/{job_id}").json()
        if doc["status"] not in ("queued", "running"):
            return doc
        time.sleep(1.5)
    return doc


def main() -> int:
    from app import app

    with TestClient(app) as client:
        # ── 1. 부팅 시 프런트가 읽는 값 ────────────────────────────
        print("\n[1] GET /api/meta — 부팅 시 화면 기본값")
        meta = client.get("/api/meta").json()
        has_keys("meta 최상위", meta, [
            "version", "workspace", "device", "default_model", "default_model_exists",
            "class_names", "segment_kinds", "label_statuses", "dataset_tasks",
            "default_task", "split_modes", "defaults",
        ])
        has_keys("meta.defaults", meta["defaults"], ["extract", "frame", "dataset", "train"])
        has_keys("meta.defaults.extract", meta["defaults"]["extract"],
                 ["fps", "conf", "iou", "imgsz", "track", "max_frames"])
        has_keys("meta.defaults.dataset", meta["defaults"]["dataset"],
                 ["splits", "split_mode", "chunk_size", "task", "only_approved"])
        has_keys("meta.defaults.train", meta["defaults"]["train"],
                 ["epochs", "imgsz", "batch", "workers", "patience"])
        check("기본 태스크가 obb", meta["default_task"] == "obb", meta["default_task"])
        check("기본 가중치가 OBB 모델",
              "obb" in Path(meta["default_model"]).name.lower(), meta["default_model"])
        check("기본 가중치 파일 존재", meta["default_model_exists"] is True)

        print("\n[2] GET /api/detector/weights — 가중치 선택 드롭다운")
        weights = client.get("/api/detector/weights").json()["items"]
        check("가중치 1개 이상", len(weights) > 0, f"{len(weights)}개")
        has_keys("weights[0]", weights[0],
                 ["path", "abs_path", "name", "origin", "task", "size_mb", "is_default"])

        # ── 3. 영상 ────────────────────────────────────────────────
        print("\n[3] 영상 업로드/목록/상세")
        vid_file = _WS / "contract.mp4"
        print(f"      입력 영상: {make_video(vid_file)}")
        with vid_file.open("rb") as f:
            r = client.post("/api/videos", files={"file": ("contract.mp4", f, "video/mp4")})
        check("POST /api/videos", r.status_code == 200, r.text[:180])
        if r.status_code != 200:
            return 1
        video = r.json()
        vid = video["video_id"]
        has_keys("업로드 응답", video, ["video_id", "original_name", "path", "managed",
                                   "size_mb", "created_at", "fps", "frame_count",
                                   "width", "height", "duration_sec"])

        items = client.get("/api/videos").json()["items"]
        has_keys("videos[0] (카드가 읽는 값)", items[0],
                 ["video_id", "original_name", "width", "height", "fps", "duration_sec",
                  "size_mb", "managed", "created_at", "segments", "labeling"])
        has_keys("videos[0].segments", items[0]["segments"],
                 ["total", "normal", "normal_sec", "abnormal", "abnormal_sec"])
        has_keys("videos[0].labeling", items[0]["labeling"],
                 ["frames", "approved", "pending", "rejected", "empty_frames",
                  "objects", "unresolved_objects", "ready", "approved_ratio"])

        detail = client.get(f"/api/videos/{vid}").json()
        has_keys("영상 상세", detail, ["segments", "segment_summary", "labeling", "class_stats"])

        r = client.get(f"/api/videos/{vid}/frame", params={"t": 0.5})
        check("미리보기 프레임 JPEG", r.status_code == 200
              and r.headers["content-type"] == "image/jpeg", r.headers.get("content-type"))

        r = client.get(f"/api/videos/{vid}/stream", headers={"Range": "bytes=0-1023"})
        check("영상 Range 부분응답(타임라인 탐색 전제)", r.status_code == 206,
              f"{r.status_code} {r.headers.get('content-range')}")

        # ── 4. 구간 ────────────────────────────────────────────────
        print("\n[4] 구간 저장/선택 미리보기")
        dur = float(video["duration_sec"])
        r = client.put(f"/api/videos/{vid}/segments", json={"segments": [
            {"kind": "normal", "start_sec": 0.0, "end_sec": dur * 0.7, "note": "계약 테스트"},
            {"kind": "abnormal", "start_sec": dur * 0.3, "end_sec": dur * 0.4},
        ]})
        seg_doc = r.json()
        check("PUT segments", r.status_code == 200, r.text[:180])
        has_keys("segments 응답", seg_doc, ["video_id", "segments", "updated_at",
                                        "summary", "selection_ranges"])
        has_keys("segments[0] (구간 목록 편집)", seg_doc["segments"][0],
                 ["id", "kind", "start_sec", "end_sec", "duration_sec", "note"])
        check("비정상 구간이 정상에서 빠짐(선택 2조각)",
              len(seg_doc["selection_ranges"]) == 2, str(seg_doc["selection_ranges"]))

        sel = client.get(f"/api/videos/{vid}/selection", params={"kinds": ["normal"]}).json()
        has_keys("selection", sel, ["video_id", "kinds", "ranges", "total_sec"])

        # ── 5. 추출 + 자동 라벨 ────────────────────────────────────
        print("\n[5] 프레임 추출 + 자동 라벨 (잡 폴링)")
        r = client.post(f"/api/videos/{vid}/extract",
                        json={"kinds": ["normal"], "fps": 4, "track": True, "overwrite": "all"})
        check("POST extract", r.status_code == 200, r.text[:180])
        job = r.json()
        has_keys("잡 응답(진행바가 읽는 값)", job,
                 ["job_id", "id", "kind", "target", "status", "total", "done", "progress",
                  "rate_per_sec", "elapsed_sec", "message", "error", "result"])
        final = poll(client, job["job_id"])
        check("추출 완료", final["status"] == "done", str(final.get("error")))
        print(f"      {final.get('message')}")

        active = client.get("/api/jobs", params={"kind": "extract", "target": vid, "limit": 1}).json()
        check("진행 중 잡 조회(새로고침 복원)", len(active["items"]) == 1)

        # ── 6. 프레임 목록 / 라벨 문서 ─────────────────────────────
        print("\n[6] 프레임 목록 · 라벨 문서 · 이미지")
        flist = client.get(f"/api/videos/{vid}/frames", params={"limit": 1000}).json()
        has_keys("frames 응답", flist, ["video_id", "total", "offset", "limit", "items"])
        check("프레임 1장 이상", flist["total"] > 0, f"{flist['total']}장")
        has_keys("frames.items[0] (필름스트립)", flist["items"][0],
                 ["frame_id", "frame_index", "time_sec", "status", "source", "segment_kind",
                  "n_objects", "n_unresolved", "class_names", "track_ids"])

        fid = flist["items"][0]["frame_id"]
        doc = client.get(f"/api/videos/{vid}/frames/{fid}").json()
        has_keys("라벨 문서(캔버스가 읽는 값)", doc,
                 ["video_id", "frame_id", "frame_index", "time_sec", "width", "height",
                  "segment_kind", "status", "source", "model", "objects", "updated_at"])

        # 사전학습 가중치(COCO/DOTA)는 이 도메인(탑다운 드론 · 10px 표적)에서 아무것도
        # 못 잡는 것이 정상이다. 그래서 "초안이 비어도 파이프라인이 성립하는지" 를 본다.
        # 실사용에서는 기존 데이터셋으로 한 번 학습해 승격한 모델을 초안 생성에 쓴다
        # (docs/labeling_workflow.md 의 부트스트랩).
        n_with_obj = sum(1 for f in flist["items"] if f["n_objects"])
        print(f"      자동 라벨 초안: 객체 있는 프레임 {n_with_obj}/{flist['total']}장"
              f" (사전학습 가중치가 도메인 밖이면 0장이 정상)")
        check("객체 0개여도 라벨 문서가 생성됨(배경 샘플로 유효)",
              all(isinstance(f["n_objects"], int) for f in flist["items"]))
        check("라벨에 초안을 만든 가중치가 기록됨", bool(doc.get("model")), str(doc.get("model")))
        with_obj = next((f for f in flist["items"] if f["n_objects"] > 0), None)
        if with_obj:
            odoc = client.get(f"/api/videos/{vid}/frames/{with_obj['frame_id']}").json()
            has_keys("객체(박스 하나)", odoc["objects"][0],
                     ["id", "class_name", "class_id", "model_class_name", "score",
                      "poly", "bbox", "track_id", "source", "verified"])
            poly = odoc["objects"][0]["poly"]
            check("poly 가 4점", len(poly) == 4 and all(len(p) == 2 for p in poly), str(poly))

        for overlay in (False, True):
            r = client.get(f"/api/videos/{vid}/frames/{fid}/image",
                           params={"overlay": 1} if overlay else None)
            check(f"프레임 이미지 JPEG (overlay={int(overlay)})",
                  r.status_code == 200 and r.headers["content-type"] == "image/jpeg",
                  r.headers.get("content-type"))

        # ── 7. 회전박스 왕복 (프런트 편집 모델 ↔ 서버 라벨) ─────────
        print("\n[7] 회전박스 좌표 왕복 — 프런트 {cx,cy,w,h,angle} ↔ 서버 4점 폴리곤")
        src = (320.0, 240.0, 180.0, 60.0, math.radians(37.0))
        sent = poly_from_rect(*src)
        r = client.put(f"/api/videos/{vid}/frames/{fid}", json={
            "objects": [{"id": "o1", "class_name": meta["class_names"][2],
                         "poly": sent, "track_id": 7, "score": None}],
        })
        check("PUT 프레임 라벨", r.status_code == 200, r.text[:180])
        saved = r.json()
        got = rect_from_poly(saved["objects"][0]["poly"])
        check("중심 보존", abs(got[0] - src[0]) < 0.05 and abs(got[1] - src[1]) < 0.05,
              f"({got[0]:.2f},{got[1]:.2f}) vs ({src[0]},{src[1]})")
        check("폭·높이 보존", abs(got[2] - src[2]) < 0.05 and abs(got[3] - src[3]) < 0.05,
              f"{got[2]:.2f}×{got[3]:.2f} vs {src[2]}×{src[3]}")
        check("각도 보존", abs(math.degrees(got[4]) - 37.0) < 0.05,
              f"{math.degrees(got[4]):.3f}° vs 37°")
        check("사람 수정으로 표시", saved["source"] == "manual", saved["source"])
        check("클래스가 확정됨", saved["objects"][0]["class_id"] == 2,
              str(saved["objects"][0]["class_id"]))

        # ── 8. 트랙 일괄 지정 / 검수 ───────────────────────────────
        print("\n[8] 객체(track) 일괄 지정 · 검수 상태")
        tracks = client.get(f"/api/videos/{vid}/tracks").json()["items"]
        check("track 목록", len(tracks) > 0, f"{len(tracks)}개")
        if tracks:
            has_keys("tracks[0] (일괄 지정 패널)", tracks[0],
                     ["track_id", "frames", "first_frame", "last_frame", "class_name",
                      "model_class_name", "resolved", "avg_score"])
            target = next((t for t in tracks if not t["resolved"]), tracks[0])
            pr = client.post(f"/api/videos/{vid}/propagate", json={
                "track_id": target["track_id"], "class_name": meta["class_names"][0]})
            check("POST propagate", pr.status_code == 200, pr.text[:180])
            has_keys("propagate 응답", pr.json(), ["track_id", "class_name", "frames", "objects"])
            print(f"      #{target['track_id']} → {pr.json()['frames']}프레임 / "
                  f"{pr.json()['objects']}객체")

        # 남은 미확정 객체를 모두 확정한 뒤 전체 승인 → 데이터셋 재료 확보
        for item in client.get(f"/api/videos/{vid}/frames", params={"limit": 1000}).json()["items"]:
            fdoc = client.get(f"/api/videos/{vid}/frames/{item['frame_id']}").json()
            objs = fdoc.get("objects") or []
            if not any(o["class_id"] < 0 for o in objs):
                continue
            client.put(f"/api/videos/{vid}/frames/{item['frame_id']}", json={"objects": [
                {"id": o["id"], "class_name": o["class_name"] or meta["class_names"][0],
                 "poly": o["poly"], "track_id": o["track_id"], "score": o["score"],
                 "model_class_name": o["model_class_name"]} for o in objs]})

        bulk = client.post(f"/api/videos/{vid}/frames/status", json={"status": "approved"}).json()
        has_keys("전체 승인 응답", bulk, ["updated", "failed", "status"])
        check("전체 승인 성공", not bulk["failed"], f"{bulk['updated']}장 승인 / 실패 {len(bulk['failed'])}")

        prog = client.get(f"/api/videos/{vid}/progress").json()
        has_keys("진행률(상단 바)", prog,
                 ["video_id", "frames", "approved", "pending", "rejected", "objects",
                  "unresolved_objects", "approved_ratio", "ready", "class_stats"])

        # ── 9. 데이터셋: 폴더 확인 → 등록 → 병합 빌드 ─────────────
        if OBB_SOURCE.is_dir():
            print("\n[9] 기존 OBB 폴더 확인/등록 (train_data/preprocessed_obb)")
            insp = client.get("/api/datasets/inspect", params={"path": str(OBB_SOURCE)})
            check("GET /api/datasets/inspect", insp.status_code == 200, insp.text[:180])
            info = insp.json()
            has_keys("inspect 응답(등록 전 미리보기)", info,
                     ["dir", "yaml", "names", "task", "splits", "total_images"])
            has_keys("inspect.splits.train", info["splits"]["train"], ["dir", "images", "labels"])
            check("task=obb 인식", info["task"] == "obb", str(info["task"]))

            imp = client.post("/api/datasets/import",
                              json={"path": str(OBB_SOURCE), "name": "계약-등록"})
            check("POST /api/datasets/import", imp.status_code == 200, imp.text[:180])
            m = imp.json()
            has_keys("등록된 데이터셋 manifest", m,
                     ["dataset_id", "name", "task", "created_at", "imported", "copied",
                      "source_dir", "counts", "objects", "total_frames", "total_objects",
                      "class_names", "class_histogram", "warnings", "data_yaml"])
            imported_id = m["dataset_id"]
            print(f"      등록: {m['total_frames']}장 / 객체 {m['total_objects']}개")

            print("\n[10] 병합 빌드 — 새로 라벨한 프레임 + 등록한 기존 데이터셋")
            r = client.post("/api/datasets", json={
                "name": "계약-병합", "task": "obb", "video_ids": [vid],
                "base_datasets": [imported_id],
            })
            check("POST /api/datasets (병합)", r.status_code == 200, r.text[:180])
            dj = r.json()
            check("dataset_id 즉시 반환(상세로 이동용)", bool(dj.get("dataset_id")))
            done = poll(client, dj["job_id"])
            check("병합 빌드 완료", done["status"] == "done", str(done.get("error")))
            if done["status"] == "done":
                man = done["result"]
                has_keys("빌드 manifest", man,
                         ["dataset_id", "name", "task", "counts", "objects", "total_frames",
                          "total_objects", "class_names", "class_histogram",
                          "per_video_frames", "sources", "excluded", "warnings", "data_yaml"])
                has_keys("manifest.sources[0] (병합 이력 표)", man["sources"][0],
                         ["ref", "name", "dir", "prefix", "added", "class_map"])
                check("기존 + 신규가 모두 들어감",
                      man["total_frames"] > m["total_frames"],
                      f"{man['total_frames']} > {m['total_frames']}")
                check("기존 분할 보존 (valid 유지)",
                      man["counts"]["valid"] >= m["counts"]["valid"],
                      f"{man['counts']} vs {m['counts']}")
                merged_id = man["dataset_id"]

                yml = client.get(f"/api/datasets/{merged_id}/data.yaml")
                check("data.yaml 조회", yml.status_code == 200)
                text = yml.text
                check("data.yaml 에 obb 태스크", "task: obb" in text)
                check("data.yaml 에 train/val 경로",
                      "train: train/images" in text and "val: valid/images" in text)

                dl = client.get("/api/datasets").json()["items"]
                has_keys("datasets[0] (목록 표)", dl[0],
                         ["dataset_id", "name", "task", "created_at", "counts", "total_frames",
                          "total_objects", "class_names", "imported", "source_dir",
                          "n_sources", "warnings"])

                d = client.delete(f"/api/datasets/{merged_id}").json()
                has_keys("데이터셋 삭제 응답", d, ["dataset_id", "deleted", "source_kept"])

            rm = client.delete(f"/api/datasets/{imported_id}").json()
            check("등록 삭제 시 원본 폴더 보존", OBB_SOURCE.is_dir()
                  and (OBB_SOURCE / "train" / "images").is_dir(), str(rm.get("source_kept")))
        else:
            print(f"\n[9] 건너뜀 — 원본 OBB 폴더 없음: {OBB_SOURCE}")

        # ── 11. 학습/모델 화면이 읽는 목록 ─────────────────────────
        print("\n[11] 학습·모델 화면 목록")
        runs = client.get("/api/train").json()
        check("GET /api/train", "items" in runs, str(list(runs)))
        models = client.get("/api/models").json()
        has_keys("models 응답", models, ["default_model", "weights", "promoted"])

        cls = client.get("/api/classes").json()
        has_keys("classes 응답", cls, ["class_names", "updated_at"])
        added = client.put("/api/classes",
                           json={"class_names": [*cls["class_names"], "계약테스트클래스"]})
        check("클래스 추가 허용", added.status_code == 200, added.text[:180])
        reorder = client.put("/api/classes",
                             json={"class_names": list(reversed(cls["class_names"]))})
        check("순서 변경은 거부(라벨 뒤바뀜 방지)", reorder.status_code == 400,
              str(reorder.status_code))

        client.delete(f"/api/videos/{vid}")

    print(f"\n{'=' * 62}\n결과: OK {_ok} / FAIL {_fail}\n{'=' * 62}")
    return 0 if _fail == 0 else 1


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(_WS, ignore_errors=True)
    sys.exit(code)
