# Sidebar Manager

> 상태: active (P3 panel UI) · 최종 갱신: 2026-10-23 · Repository: [linuxsung/dsh-sidebar-manager](https://github.com/linuxsung/dsh-sidebar-manager)

## 인덱스

| 섹션 | 목적 |
|---|---|
| 개요 | 플러그인 기능과 범위 |
| 구현 상태 | P1 UI / P2 Host / P3 manager panel |
| 구조 | 패키지 파일 역할 |
| 설치 | 로컬/마켓 설치 방법 |
| 안전 규칙 | Move/Fork/Delete 트랜잭션 원칙 |

## 구현 상태

- **P1 Client UI 완료** — 세션 hover 휴지통, `⋯` 메뉴 3종, Confirmation Gate 다이얼로그가 `lib/client.js`에 구현됨.
- **P2 Host 완료** — preview 3종(`session/move`, `workspace/rename-folder`, `session/fork-to-workspace`)과 purge/archive/restore/archived/move/rename-folder/fork route, journal + boot finalizer가 `lib/transaction.mjs`에 구현됨.
- **P3 Manager Panel 완료** — `sidebar.panellist` + `main` 패널로 상단 세 번째 메뉴에 배치. 행별 인라인 이름 편집, 폴더 포함 체크, 이름 변경/보관 2버튼, 폴더 변경에만 Gate 적용. 하단 footer 버튼 제거.
- **실기동 E2E 통과** — 격리 DSH 인스턴스(port 3099)에서 Playwright **55/55 checks** 통과. Move/Rename/Fork는 실제 서버 재시작 후 finalizer까지 검증.

## 개요

DSH 사이드바에서 세션과 워크스페이스를 관리하는 단일 로컬 플러그인입니다.

1. **영구 삭제** — 아카이브된 Cold 세션의 로그·projcache·registry 매핑을 정리합니다.
2. **워크스페이스 아카이브** — 소속 세션을 Archive한 뒤 워크스페이스 등록을 해제하고, 상단 Workspace manager 패널에서 복원합니다.
3. **Move to Workspace** — Cold 세션의 zstd 헤더 CWD를 재작성하고 물리 경로·레지스트리를 2PC로 갱신합니다.
4. **Fork to New Workspace** — 새 프로젝트 디렉터리+워크스페이스를 만든 뒤, 원본 세션 로그를 새 ID로 복제해 첫 세션으로 배치합니다. 라이브 자식 세션을 만들지 않아 재시작 finalizer가 안전하게 attach합니다.
5. **Workspace Manager 패널** — 상단 3번째 메뉴. 행에서 이름을 직접 편집하고 Enter로 저장합니다. 폴더 포함 시에만 실제 디렉토리명 입력과 Confirmation Gate가 나타납니다.

## 구조

| 경로 | 역할 |
|---|---|
| `lib/index.js` | Host 엔트리. 공개 Exact Fetch route 등록 |
| `lib/transaction.mjs` | 2PC·Move/Archive/Purge/Fork 구현 |
| `lib/session-log.mjs` | zstd 프레임 파싱·헤더 재작성/복제·무결성 검증 |
| `lib/client.js` | Browser 엔트리. 공식 Slot 등록 |
| `cordis.patch.yml` | 프로필 번들 patch |
| `locale/{en,ko}.json` | 플러그인 표시 메타데이터 |
| `market/index.json` | 마켓 인덱스(format 1) 템플릿 |

## 설치

```powershell
# npm 배포 후
dsh plugin --profile web add @nolit/dsh-sidebar-manager

# 로컬 체크아웃을 쓰는 경우
dsh plugin --profile web add link:<path-to-dsh-sidebar-manager>
```

마켓 배포 시 `npm publish` 후 `market/index.json`의 `versions`를 갱신하고,
Plugins → Discover에서 인덱스 URL을 추가합니다.

## 안전 규칙

- Move/Fork는 **Cold 세션만** 허용하며, 활성/열린 세션은 거부합니다.
- Fork는 `sessionController.fork` 대신 원본 로그를 새 ID로 복제합니다(live 자식 회피).
- 타이틀만 변경하면 즉시 저장하고 재시작이 필요 없습니다. 실제 디렉토리 변경은 Gate 확인 후 재시작으로 반영됩니다.
- 파일 조작 전 `~/.dsh/backup/<txid>/`에 원본 스냅샷을 남깁니다.
- 새 위치에 헤더 재작성 파일을 먼저 쓰고 무결성 검증을 통과한 뒤에만
  구 경로 정리와 레지스트리 갱신을 수행합니다.
- 이동 시 에이전트의 향후 CWD가 새 워크스페이스로 바뀜을 확인 다이얼로그에서 고지합니다.

## 위험 작업 확인 게이트 (Confirmation Gate)

Move · Fork to New Workspace · Folder-linked Rename은 **작업 시작 전** 다이얼로그에서 아래
4가지를 한 화면에 표시하고, 확인 체크 전에는 실행 버튼을 비활성화합니다.

1. **영향 범위 사전 표시** — 영향받는 Cold 세션 수 `N`, 기존 경로 → 새 경로, 대상 워크스페이스 제목/ID.
2. **CWD 변경 경고** — "이후 에이전트의 명령 실행·파일 생성 기준 경로가 `newPath`로 바뀝니다."
3. **재시작 필요 사전 안내** — "파일 재배치 후 DSH 서버 재시작이 필요하며, 재시작 전에는 사이드바에 반영되지 않습니다."
4. **명시적 확인** — `[ ] 위 내용을 확인했으며, 재시작 후 반영됨을 이해합니다.` 체크 전 실행 버튼 disabled.

실행 버튼 활성 조건:

```
preflight.preview.ok === true
  && confirmCheckbox === true
  && preflight.liveSessionCount === 0
  && (folderRename ? preflight.isDefaultWorkspace === false : true)
```

`preflight.preview` route는 **파일을 쓰지 않는 read-only** 응답으로
`{ affectedSessionCount, liveSessionCount, oldPath, newPath, targetExists,
   workspaceTitle, isDefaultWorkspace, blockers[] }`를 반환합니다.
`blockers`가 비어있지 않으면 실행 버튼과 체크박스를 모두 비활성화하고 사유를 표시합니다.

## UI 문구(i18n)

사용자에게 보이는 모든 문구는 **[lib/client.js](<lib/client.js>) 상단의 `I18N = { ko: {...}, en: {...} }` 객체 하나**에만 존재합니다.
코드 본문에는 UI 텍스트를 하드코딩하지 않습니다.

- 키 구조는 `ko`/`en`이 동일해야 하며, 문구 수정은 해당 객체만 고치면 됩니다.
- 언어는 `navigator.language`가 `ko*`이면 한국어, 그 외에는 영어로 자동 선택됩니다.
- `{count}`, `{oldPath}`, `{newPath}` 같은 자리표시자는 `t(key, vars)`에서 치환됩니다.
- 플러그인 목록에 표시되는 제목/설명은 별도로 `locale/{en,ko}.json`의 `meta`가 담당합니다.
