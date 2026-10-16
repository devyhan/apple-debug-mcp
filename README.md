# sim-orchestration-mcp

Apple Simulator 오케스트레이션 MCP 데몬. 여러 AI 에이전트 세션이 한 Mac의 시뮬레이터 풀을 공유하면서
**누가 어떤 시뮬레이터를 쓰고 있는지(Lease)** 추적하고, 빈 시뮬레이터가 생기면 **대기열의 다음 작업에 자동 분배**한다.

기반 오픈소스:

- [simslim](https://github.com/MobAI-App/simslim) — 시뮬레이터 라이프사이클(boot/shutdown/slim) + 저RAM slim 부팅
- [AXe](https://github.com/cameroncooke/AXe) — UI 자동화(describe-ui, tap, type, swipe, screenshot…)

```
에이전트 세션들 (Orca / Claude Code / TMA / 스크립트)
        │  Streamable HTTP (POST /mcp), 세션별 MCP 연결
        ▼
sim-orchestration-mcp 데몬 ── 공유 상태: Lease + 대기열 + 자동 분배
        │  자식 프로세스
        ├── simslim ── 부팅/종료/slim, 풀 상태
        └── axe ────── Lease 소유자만 UI 조작 가능
```

## 요구사항

- macOS + Xcode (Simulator runtime)
- Node.js 18+
- `simslim`, `axe` 바이너리 (`brew install mobai-app/tap/simslim`, `brew install cameroncooke/axe/axe`)
- `serve-sim` (선택): `npm install -g serve-sim` — 회전/CA 디버그/메모리 경고 도구(`sim_rotate`,
  `sim_ca_debug`, `sim_memory_warning`)와 합성 카메라(`camera_start`/`camera_switch`/
  `camera_mirror`/`camera_status`/`camera_stop`), 라이브 스트리밍(`stream_start`/`stream_stop`,
  `lease_acquire`의 `stream` 옵션)에만 필요. 없어도 데몬은 정상 기동하며 해당 도구 호출 시에만
  설치 안내와 함께 실패한다.
- `llmdb` (선택): `brew install alexmx/tools/llmdb` — 디버깅 도구(`debug_attach`/
  `debug_break`/`debug_continue`/`debug_bt`/`debug_locals`/`debug_eval`/`debug_step`/
  `debug_detach`)에만 필요. 없어도 데몬은 정상 기동하며 해당 도구 호출 시에만
  설치 안내와 함께 실패한다.

## 실행

```sh
npm install
npm run build
npm start
# → http://127.0.0.1:3100/mcp, 상태 파일 ~/.sim-orchestration-mcp/state.json
```

반드시 **하나의 공유 데몬**으로 띄워야 한다. 세션마다 stdio 프로세스를 띄우면 풀/큐가 공유되지 않는다.

### 상시 데몬으로 설치 (macOS launchd)

```sh
# ~/Library/LaunchAgents/com.sim-orchestration-mcp.plist 등록 후
launchctl load ~/Library/LaunchAgents/com.sim-orchestration-mcp.plist
curl http://127.0.0.1:3100/health   # {"ok":true,...}
tail -f ~/.sim-orchestration-mcp/daemon.log
```

plist는 node 절대경로 + `PATH`(homebrew/npm-global 포함) + `SIM_MCP_PORT=3100`을 지정하고
`KeepAlive`로 유지한다. 재시작: `launchctl unload/load` 동일 파일.

### 클라이언트 등록 (모든 세션 공유)

```sh
# Claude Code (user scope = 전 세션)
claude mcp add -s user --transport http sim-orchestration-mcp http://127.0.0.1:3100/mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.sim-orchestration]
url = "http://127.0.0.1:3100/mcp"
```

```json
// Muse: ~/.config/muse/settings.json → mcpServers
"sim-orchestration": { "type": "streamable-http", "url": "http://127.0.0.1:3100/mcp", "mode": "optional" }
```

### 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SIM_MCP_HOST` / `SIM_MCP_PORT` | `127.0.0.1` / `3100` | 리슨 주소 |
| `SIM_MCP_STATE_FILE` | `~/.sim-orchestration-mcp/state.json` | Lease/큐 영속 파일 |
| `SIMSLIM_BIN` / `AXE_BIN` | `simslim` / `axe` | 바이너리 경로 |
| `SERVE_SIM_BIN` | `serve-sim` | serve-sim 바이너리 경로 (선택 의존성) |
| `LLMDB_BIN` | `llmdb` | llmdb 바이너리 경로 (선택 의존성) |
| `SERVE_SIM_PORT_BASE` | `3220` | Lease 스트림 헬퍼의 시작 포트 (빈 포트 탐색) |
| `MITMDUMP_BIN` | `mitmdump` | mitmdump 바이너리 경로 (선택 의존성) |
| `NETPROXY_PORT_BASE` | `3240` | Lease 네트워크 프록시(mitmdump)의 시작 포트 (빈 포트 탐색) |
| `SIM_MCP_MAX_SIMS` | `0` (무제한) | 동시 부팅 상한. 도달 시 대기열로 |
| `SIM_MCP_LEASE_TTL_MS` | `1800000` (30분) | heartbeat 없이 유지되는 시간 |
| `SIM_MCP_SCREENSHOT_DIR` | `$TMPDIR/sim-mcp-shots` | 스크린샷 저장 위치 |

## 클라이언트 연결

Streamable HTTP를 지원하는 MCP 클라이언트에서 아래 URL을 등록한다:

```
http://127.0.0.1:3100/mcp
```

- **Claude Code**: `claude mcp add --transport http sim-orchestration-mcp http://127.0.0.1:3100/mcp`
- **Orca / TMA / 기타**: 각 도구의 MCP 설정에서 위 HTTP 엔드포인트를 등록 (Streamable HTTP 방식)

## 사용 흐름 (에이전트용)

1. `lease_acquire` — `{session_id, client, task, device?…}` 전달.
   여유가 있으면 즉시 Lease, 없으면 대기 티켓(`ticket_id`, `position`) 반환.
2. 티켓을 받았으면 `queue_status`로 폴링. 누군가 반납하면 자동 할당되어
   `status: "assigned"` + `lease_id`가 보인다.
3. `ui_*` 도구로 작업. Lease당 시뮬레이터 1대, 소유자만 조작 가능.
4. 긴 작업은 `lease_heartbeat`로 갱신 (TTL 초과 시 자동 회수 후 큐에 재배정).
5. 끝나면 `lease_release` — 해제 즉시 조건 맞는 첫 대기 티켓에 자동 분배.

`session_id`는 호출자 도구의 세션 ID를 그대로 쓰면 된다. 서버는 형식을 강제하지 않으므로
Orca, Claude Code, TMA, 스크립트 어디서든 `client` 라벨과 함께 쓰면 `sessions_list`에서
"어떤 세션이 어떤 시뮬레이터에서 실행 중인지" 한눈에 보인다.

## 도구 (50개)

| 그룹 | 도구 |
|---|---|
| 풀/상태 | `pool_status`, `sessions_list`, `sim_boot`, `sim_shutdown`, `sim_slim` |
| Lease/큐 | `lease_acquire`, `lease_release`, `lease_heartbeat`, `lease_list`, `queue_status`, `queue_cancel`, `lease_actions` |
| UI 자동화 (Lease 필수) | `ui_describe`, `ui_tap`, `ui_type`, `ui_swipe`, `ui_gesture`, `ui_button`, `ui_screenshot`, `ui_batch` |
| 기기 부가 기능 | `sim_rotate`, `sim_ca_debug`, `sim_memory_warning`, `sim_log_stream`, `sim_log_show` |
| 합성 카메라 | `camera_start`, `camera_switch`, `camera_mirror`, `camera_status`, `camera_stop` |
| 앱 생명주기 (Lease 필수) | `app_open_url`, `app_install`, `app_uninstall`, `app_launch`, `app_terminate` |
| 프로파일링 (Lease 필수) | `profile_trace` |
| 라이브 스트리밍 (Lease 필수) | `stream_start`, `stream_stop` |
| 디버깅 (Lease 필수) | `debug_attach`, `debug_break`, `debug_continue`, `debug_bt`, `debug_locals`, `debug_eval`, `debug_step`, `debug_detach` |
| 네트워크 프록시 (Lease 필수) | `net_proxy_start`, `net_proxy_set_rules`, `net_proxy_stop`, `net_proxy_status` |

주요 동작:

- `lease_acquire`: 조건(`udid`/`device` 부분일치/`osVersion` 접두/`platform`) 매칭 → 부팅 필요 시 자동 부팅 →
  stock이면 자동 slim(`--no-reboot`, 기존 커스텀 프로필은 건드리지 않음) → 그래도 없으면 대기열 등록.
- `lease_release` / TTL 만료 / 외부 종료 감지 시 대기열 자동 분배 (FIFO + 조건 매칭, `auto_boot` 허용 티켓은 부팅까지).
  참고: release는 시뮬레이터를 종료하지 않는다 (다음 대기자에게 부팅된 채로 인계). 종료가 필요하면 `sim_shutdown`을 별도 호출.
- `sim_shutdown`은 Lease 중이면 거부 (`force=true`로 선점 가능). `sim_slim`의 리부팅 slim,
  `sim_rotate`/`sim_ca_debug`/`sim_memory_warning`도 동일 (보유 세션을 에러에 명시).
- `ui_screenshot`은 PNG 경로 + 이미지 블록을 함께 반환.
- `sim_rotate`는 `portrait|portrait_upside_down|landscape_left|landscape_right`,
  `sim_ca_debug`는 `option=blended|copies|misaligned|offscreen|slow-animations` + `enabled` 불리언.
- `sim_log_stream`은 지정 시간(기본 5초, 최대 60초) 동안 live 로그 수집
  (`level=default|info|debug`, 기본 `default`),
  `sim_log_show`는 `--last` 구간(기본 `5m`)의 과거 로그 조회
  (`info`/`debug`/`signpost` 불리언으로 상세 레벨 추가). 둘 다 `xcrun simctl spawn` 기반이라
  serve-sim 없이도 동작한다. 결과는 `{log, truncated, timedOut}`이며,
  `stream`은 항상 윈도우 만료로 끝나므로 `timedOut: true`가 정상이다.
- 로그 필터: 전체 predicate(`predicate`, 예: `process == "MyApp"`) 또는 간편 지정
  (`process`, 예: `"Preferences"`). 둘을 함께 주면 `process` 조건과 AND로 결합된다.
  predicate는 비어 있거나 따옴표/괄호가 짝이 맞지 않으면 호출 전에 거부된다.
  따옴표·괄호 팁: 문자열 리터럴은 큰따옴표로 감싸고(`eventMessage CONTAINS "x"`),
  리터럴 안의 괄호는 무시되므로 `process == "My(App)"`도 유효하다.
- 출력이 `max_chars`(기본 20000)를 넘으면 끝(tail)만 남기고, 앞에
  `…[truncated N chars]` 접두사로 잘린 분량을 표시한다. 최신 로그가 필요한 경우가
  대부분이므로, 좁은 윈도우(`timeout_sec`/`last`) + `process` 필터 조합을 권장한다.
- 앱 생명주기: `app_launch {lease_id, bundle_id, args?}`(실행 후 `{pid}` 반환),
  `app_terminate`, `app_open_url {url}`(스톡 핸들러, 예: https → Safari),
  `app_install {app_path}`, `app_uninstall {bundle_id}`. 전부 `xcrun simctl`
  기반이라 추가 의존성이 없고, Lease 소유자만 호출 가능하며 `lease_actions`에
  기록된다. `terminate`는 실행 중이 아닌 앱에 "found nothing to terminate"으로
  실패하고, `uninstall`은 존재하지 않는 번들도 조용히 성공(idempotent)한다.
- 프로파일링: `profile_trace {lease_id, duration_sec?(기본 5, 최대 60),
  template?(기본 "Time Profiler"), attach?, output_dir?}` —
  `xcrun xctrace record --device`로 `.trace` 파일을 저장한다. `--attach`는
  시뮬레이터 앱 프로세스를 찾지 못하는 경우가 많아("Cannot find process")
  기본은 전체 프로세스 기록이다. 참고: 이 호스트 계열에서는 시뮬레이터 대상
  녹화가 "Starting recording..."에서 멈추는 것이 확인되어(호스트 녹화는 정상),
  스모크 테스트는 검증 경로만 단언하고 실제 녹화는 호출하지 않는다.
- 합성 카메라: `camera_start {udid, bundle_id, source?}`로 앱을 합성 피드와 함께 실행
  (`source=placeholder|webcam|file`, `file`은 이미지/동영상 경로, `webcam`은
  `serve-sim camera --list-webcams`의 이름). 실행 중 피드는 `camera_switch`로 교체,
  미리보기 반전은 `camera_mirror {mode=auto|on|off}`, 상태는 `camera_status`
  (`{alive:false}`면 미실행), 종료는 `camera_stop`(idempotent). 시작/전환은 앱 내용에
  영향을 주므로 Lease 중이면 `force=true` 없이 거부되고, `mirror`/`status`/`stop`은
  Lease와 무관하게 동작한다. 전체 E2E는 디버깅 가능한(get-task-allow) 앱이 있어야
  가능하며, 스톡 Apple 앱은 dylib 주입을 거부한다.
- 모든 `ui_*` 호출과 serve-sim 3종은 Lease별 인메모리 액션 링(최근 100개)에 한 줄 요약으로 기록되며,
  `lease_actions`로 조회한다. Lease 해제 시 링도 함께 버려진다.
- 스트리밍은 opt-in: `lease_acquire`의 `stream: true` (실패해도 경고만 남기고 Lease는 유효) 또는
  `stream_start`/`stream_stop` (둘 다 idempotent). 스트림 URL은 Lease의 `streamUrl`에 저장되어
  `pool_status`/`sessions_list`/`lease_list`에 그대로 보인다. `stream_start`는 실행 중인 스트림이
  있으면 기존 URL을 그대로 반환한다.
- 디버깅: `debug_attach {lease_id, bundle_id|pid}`로 Lease당 1개 llmdb 세션을 열고,
  `debug_break {file, line}` → `debug_continue {wait_sec?}` → `debug_bt`/`debug_locals`/
  `debug_eval {expr}`/`debug_step {mode?}`로 중단점·중단·검사를 수행한다. 종료는
  `debug_detach`(idempotent). 세션 ID는 Lease 레코드에 저장되며, `lease_release`/TTL
  만료/스윕/외부 종료 감지 시 자동 detach된다(실패해도 해제는 성공). 전제 조건:
  디버깅 가능한(get-task-allow) 빌드 + 호스트의 1회성 개발자 도구 인증 —
  스톡 Apple 앱은 attach를 거부한다. llmdb 0.2.0의 `break set`은 `file:line`만
  받으므로 심볼 브레이크포인트는 미지원이다.
- 네트워크 프록시: `net_proxy_start {lease_id, rules?}`로 Lease 시뮬레이터의 HTTPS를
  가로채고(`mitmdump` + 생성된 rewrite addon + 시뮬레이터 키체인에 mitm CA 설치),
  `net_proxy_set_rules {rules}`로 규칙 교체(같은 포트에서 mitmdump만 재시작),
  `net_proxy_stop`(idempotent)으로 종료 + 호스트 프록시 스냅샷 복원,
  `net_proxy_status`로 상태/홀더 확인. 규칙은
  `match{url_regex?, method?}` → `action{status?, headers?, body?, delay_ms?}`
  (첫 매칭 우선, 나머지는 업스트림 그대로). **호스트 프록시는 전역**이라 홀더는
  Lease당 1개 — 다른 Lease가 잡고 있으면 보유 세션을 명시한 에러로 거부된다.
  `lease_release`/TTL 만료/스윕/외부 종료 감지 시 홀더의 프록시는 자동 종료된다
  (실패해도 해제는 성공). 규칙 검증은 어떤 호스트 변경보다 먼저 수행되므로,
  잘못된 규칙은 호스트 네트워크를 건드리지 않고 거부된다.

## 라이브 스트리밍

Lease별 MJPEG 화면 스트림. 사람이 보거나 VLM이 확인할 때만 켜는 것을 권장한다.

- 시작: `lease_acquire {…, stream: true}` 또는 `stream_start {lease_id}` →
  `http://127.0.0.1:<port>/helper/<udid>/stream.mjpeg` 형태의 URL 반환
- 포트: `SERVE_SIM_PORT_BASE`(기본 `3220`)부터 빈 포트를 위로 탐색해 Lease마다 별도 serve-sim
  헬퍼를 띄운다. serve-sim 기본값(`:3100`, 데몬 기본 포트와 충돌!)과 프리뷰(`:3200`)를 피한다.
  참고로 serve-sim은 지정 포트가 점유 중이면 스캔 대신 점유 프로세스를 kill하므로, 빈 포트
  탐색은 필수다.
- 종료: `stream_stop {lease_id}`. `lease_release`/TTL 만료/스윕/외부 종료 감지 시에도 자동 종료된다.
  대기 티켓에 `stream: true`가 있으면 디스패치 시 자동 시작 (실패 시 assignment의 `streamError`에 기록).
- 리소스: 스트림 1개당 serve-sim 헬퍼 프로세스 1개 + MJPEG 인코딩 CPU가 든다. 장시간 켜 두면
  배터리/CPU를 소모하므로, 볼 때만 켜고 끝나면 끄자. 스트리밍 없이 스크린샷만 필요하면
  `ui_screenshot`이 가볍다.

## 합성 카메라

serve-sim의 simcam 헬퍼로 시뮬레이터 앱에 가짜 카메라 피드를 주입한다. 호스트 헬퍼가
BGRA 프레임을 공유 메모리에 쓰고, dylib가 AVFoundation을 가로채 앱이 읽게 한다.

- 시작: `camera_start {udid, bundle_id, source?}` — 앱을 재실행하므로 **디버깅 가능한
  (get-task-allow) 빌드가 필수**다. 스톡 Apple 앱은 dylib 주입을 거부해서 실패한다.
  `source`는 `placeholder`(기본 애니메이션) | `webcam`(호스트 카메라) | `file`
  (이미지/동영상, 종류 자동 판별).
- 교체: `camera_switch {udid, source, file?}` — 앱 재실행 없이 피드만 핫스왑.
- 반전: `camera_mirror {udid, mode}` — 미리보기만 `auto|on|off`, 데이터 버퍼는 미반전.
- 상태/종료: `camera_status {udid}`(미실행 시 `{alive:false}`), `camera_stop {udid}`
  (idempotent, 주입된 앱도 함께 종료).
- Lease 게이트: `start`/`switch`는 Lease 중이면 `force=true` 없이 거부(보유 세션 명시),
  `mirror`/`status`/`stop`은 Lease와 무관.

수동 확인 (디버깅 가능한 앱이 있을 때):

```sh
serve-sim camera --list-webcams
serve-sim camera com.example.DebugApp -d <udid> --webcam   # 또는 --file ~/x.png
serve-sim camera status -d <udid>
serve-sim camera switch placeholder -d <udid>
serve-sim camera mirror on -d <udid>
serve-sim camera --stop-webcam -d <udid>
```

참고: serve-sim 0.1.48에서 `-q/--quiet`는 camera 하위 명령에 효과가 없다(전역 옵션으로
먼저 소비됨). 시작/전환/반전/종료 출력은 사람이 읽는 텍스트이며, JSON으로 파싱되는 것은
`status`와 `--list-webcams`(TSV)뿐이다.

## 디버깅 (llmdb)

llmdb CLI(lldb-dap 래퍼, 세션형 JSON 출력)를 Lease 단위로 감싼 도구들이다.
시뮬레이터 앱은 일반 macOS 프로세스라 debugserver 없이 직접 attach한다.

- 전제 조건 (3가지가 모두 필요):
  1. 디버깅 가능한 빌드 — `get-task-allow=true` (Xcode 디버그 빌드 기본값).
     릴리스/Hardened Runtime 빌드는 attach 불가.
  2. 호스트 1회성 인증 — 처음 attach할 때 macOS가 "개발자 도구" 접근 승인을
     요구한다. 이 호스트에서는 아직 승인되지 않아 attach가 거부된다.
  3. 서드파티 앱 — 스톡 Apple 앱(설정, Safari 등)은 attach를 거부한다.
     위 이유로 스모크 테스트는 검증 경로만 단언하고 실제 attach는 호출하지 않는다.
- 흐름: `app_launch`로 앱 실행 → `debug_attach {bundle_id}` →
  `debug_break {file, line}` → `debug_continue` → `debug_bt`/`debug_locals`/
  `debug_eval {expr}`/`debug_step {mode=over|in|out}` → `debug_detach`.
- `bundle_id`(부팅된 시뮬레이터에서 simctl로 해석) 또는 `pid`(호스트 프로세스)
  중 정확히 하나를 지정한다. 둘 다 주거나 둘 다 생략하면 거부된다.
- Lease당 세션 1개: 재-attach하면 이전 세션을 정리(best-effort)하고 교체한다.
  `debug_continue {wait_sec}`(기본 60, 최대 600)는 다음 중단까지 블로킹되며,
  실행 타임아웃은 대기 시간 + 30초 여유로 자동 설정된다.
- 수동 확인 (디버깅 가능한 앱 + 호스트 인증이 있을 때):

```sh
llmdb doctor
llmdb attach --app com.example.DebugApp   # → {"sessionId": ...}
llmdb break set ./Sources/App/main.swift:34 --session <id>
llmdb continue --session <id>
llmdb bt --session <id>
llmdb stop --session <id>
```

## 네트워크 프록시 (mitm)

Lease 시뮬레이터의 HTTPS 트래픽을 가로채 응답을 고쳐 쓰는 도구들이다.
시뮬레이터 트래픽 MITM이 종단간 실증된 메커니즘 그대로만 구현되어 있다.

- 동작 방식: `net_proxy_start`는 (1) 모든 네트워크 서비스의 프록시 설정을
  스냅샷하고, (2) Lease 시뮬레이터 키체인에 mitm CA를 설치하고
  (`xcrun simctl keychain <udid> add-root-cert`), (3) `NETPROXY_PORT_BASE`(기본
  `3240`)부터 빈 포트를 탐색해 규칙이 박힌 addon과 함께 `mitmdump -p <port> -s`
  를 띄우고, (4) 마지막으로 **모든 서비스의 호스트 웹 프록시를 mitmdump로
  켠다**(`sudo -n networksetup -setwebproxy/-setsecurewebproxy` +
  `-setwebproxystate/-setsecurewebproxystate on`). 종료는 역순: 호스트 스냅샷
  복원 → mitmdump 종료 → addon 삭제.
- 규칙: `match{url_regex?, method?}` → `action{status?, headers?, body?,
  delay_ms?}`. 모든 요청은 일단 업스트림으로 나가고, 첫 번째로 매칭된 규칙이
  응답을 변형한다(status 교체, headers 병합, body 교체 + content-encoding 제거,
  요청 전달 전 delay). `match` 생략 = 전체 매칭, `rules: []` = 가로채기만 하고
  고쳐 쓰지 않음(투명 모드). 최대 50개.
- 전제 조건 (2가지가 모두 필요):
  1. `mitmdump` 설치 (`brew install mitmproxy`, 선택 의존성 — 없으면 데몬은
     경고만 남기고 뜨고, `net_proxy_*` 호출 시 설치 힌트와 함께 실패).
     CA(`~/.mitmproxy/mitmproxy-ca-cert.pem`)는 mitmdump 첫 실행 시 자동 생성된다.
  2. 호스트 프록시 제어용 passwordless sudo — 딱 4개 하위 명령에만 필요:
     `networksetup -setwebproxy/-setsecurewebproxy/-setwebproxystate/-setsecurewebproxystate`.
     데몬 시작 시에는 점검하지 않고(모든 `-set*`이 호스트 상태를 바꾸므로),
     `net_proxy_start` 호출 시점에 실패하면 sudoers 안내와 함께 거부된다.
- ⚠️ HOST-WIDE 경고: 프록시가 켜져 있는 동안은 **호스트 전체의 웹 트래픽**
  (다른 앱 백그라운드 통신 포함)이 mitmdump를 통과한다. 사설 CA를 쓰는 호스트
  내부망 사이트는 mitm 검증 실패로 깨질 수 있다(종료·복원 시 정상화).
  꼭 필요한 동안만 켜고 끝나면 바로 끄자. 홀더는 전체 Lease 중 1개뿐이며,
  다른 Lease가 잡고 있으면 보유 세션·Lease를 명시한 에러로 거부된다.
- 잔류물(leakage) 노트: 종료해도 시뮬레이터 키체인의 mitm CA는 남는다
  (프록시 없이는 무해하며, 완전 제거는 `xcrun simctl keychain <udid> reset`).
  데몬이 SIGKILL 등으로 비정상 종료되면 호스트 프록시가 켜진 채로 남을 수 있다.
  수동 복구:
  ```sh
  pkill -f "mitmdump -p "   # mitmdump 종료
  networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r svc; do
    svc="${svc#\*}"   # 비활성 표시(*) 제거
    sudo networksetup -setwebproxystate "$svc" off
    sudo networksetup -setsecurewebproxystate "$svc" off
  done
  ```
  정상 종료(SIGINT/SIGTERM)·`lease_release`·TTL 만료·스윕·외부 종료 감지 시에는
  자동 복원된다(복원 실패가 해제를 막지는 않는다).
- 스모크 테스트는 호스트 네트워크를 절대 건드리지 않는다: 정지 상태 확인 +
  Lease 게이트 + 규칙 검증 경로만 단언한다.

## 개발

```sh
npm test        # 단위 테스트 (orchestrator/래퍼/store)
npm run typecheck
npm run smoke   # 실제 시뮬레이터 E2E (데몬 기동→부팅→큐→분배→종료)
npm run dev     # tsx 핫 실행
```

## CI

- `check` (Linux, 모든 PR/푸시): typecheck + 단위 테스트 + 빌드
- `smoke-macos` (main 푸시·매주 월요일·수동·`run-smoke` 라벨 PR): simslim·axe를 brew로 설치해
  실제 시뮬레이터 스모크 — 외부 CLI/Xcode 드리프트를 조기 발견
- Dependabot이 npm·GitHub Actions 업데이트 PR을 주 1회 생성

구조: `src/index.ts`(HTTP 데몬/세션 map) · `src/server.ts`(MCP 도구 정의) ·
`src/orchestrator.ts`(acquire/release/dispatch) · `src/store.ts`(JSON 영속화) ·
`src/simslim.ts` · `src/axe.ts` · `src/servesim.ts` · `src/simlog.ts` · `src/simapps.ts` · `src/xctrace.ts` · `src/netproxy.ts`(mitm 프록시) · `src/extras.ts`(기기 부가 도구) ·
`src/exec.ts` · `test/`
