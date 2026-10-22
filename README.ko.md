# Sidebar Manager (한국어)

> 상태: active (P3 panel UI) · 최종 갱신: 2026-10-23 · Repository: [linuxsung/dsh-sidebar-manager](https://github.com/linuxsung/dsh-sidebar-manager)

## 인덱스

| 섹션 | 목적 |
|---|---|
| 개요 | 기능 요약 |
| 구현 상태 | P1 UI / P2 Host / P3 panel |
| 안전 규칙 | 트랜잭션 원칙 |

## 구현 상태

- **P1 Client UI 완료** — hover 휴지통, `⋯` 메뉴, Confirmation Gate 구현.
- **P2 Host 완료** — preview 3종 + purge/archive/restore/archived/move/rename-folder/fork, journal·boot finalizer 구현.
- **P3 Manager Panel 완료** — 상단 세 번째 메뉴, 행별 인라인 이름 편집, 폴더 포함 체크, 이름 변경/보관 2버튼, 폴더 변경 Gate. footer 버튼 제거.
- **실기동 E2E 통과** — 격리 DSH(port 3099) Playwright **55/55 checks**. Move/Rename/Fork는 실제 재시작 후 finalizer까지 검증.

## 개요

- 아카이브된 Cold 세션 **영구 삭제**
- **워크스페이스 아카이브/복원** (상단 Workspace manager 패널)
- **Move to Workspace** (zstd 헤더 CWD 재작성 + 레지스트리 2PC)
- **Fork to New Workspace** (원본 로그를 새 ID로 복제해 live 자식 없이 배치)

## 안전 규칙

- Cold 세션만 이동/삭제합니다.
- Fork는 라이브 자식 세션을 만들지 않고 원본 로그를 새 ID로 복제합니다.
- 원본은 `~/.dsh/backup/`에 스냅샷 후 작업합니다.
- 무결성 검증 전에는 구 경로를 지우지 않습니다.
- CWD 변경을 확인 다이얼로그에서 고지합니다.

## 위험 작업 확인 게이트

Move · Fork · 폴더 연동 Rename 실행 전 다이얼로그에서 아래를 **먼저** 표시합니다.

1. 영향 세션 수 + 기존 경로 → 새 경로 + 워크스페이스 제목
2. 에이전트 CWD가 새 경로로 바뀐다는 경고
3. 재시작 후에만 반영된다는 사전 안내
4. `[ ] 위 내용을 확인했습니다` 체크(필수)

체크 전·live 세션 존재·기본 워크스페이스 폴더 변경·경로 충돌 시 **실행 버튼 비활성화**.
`preflight.preview`는 파일을 쓰지 않고 `affectedSessionCount`, `liveSessionCount`,
`oldPath`, `newPath`, `isDefaultWorkspace`, `blockers`를 반환합니다.

## UI 문구(i18n)

모든 사용자 노출 문구는 **[lib/client.js](<lib/client.js>) 상단의 `I18N = { ko, en }` 객체 하나**에만 둡니다.
본문 코드에는 문구를 하드코딩하지 않으며, `navigator.language`가 `ko*`이면 한국어, 아니면 영어가 자동 선택됩니다.
`{count}`, `{oldPath}`, `{newPath}` 자리표시자는 `t(key, vars)`로 치환됩니다.
