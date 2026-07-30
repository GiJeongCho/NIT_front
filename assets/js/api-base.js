/**
 * api-base.js — 배포 시 심는 기본 API 주소
 *
 * 빈 문자열이면 프런트가 `현재 호스트:8888` 을 기본값으로 쓴다.
 * `python server.py --api http://10.0.0.5:8888` 로 실행하면 이 파일이 덮어써진다.
 * 브라우저에 저장된(설정 창에서 바꾼) 값이 있으면 그것이 항상 우선한다.
 */
export const INJECTED_API_BASE = '';
