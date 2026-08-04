# 모드: pipeline -- URL Inbox (Second Brain)

`data/pipeline.md`에 쌓인 채용 공고 URL을 처리합니다. 후보자는 원할 때 URL을 추가하고, 이후 `/career-ops pipeline`을 실행해 한 번에 처리합니다.

## Liveness 스윕

**어떤 URL이든 처리하기 전에 먼저 실행합니다.** 스캐너가 headless/batch 모드에서 기록한 항목에는 `**Verification:** unconfirmed (batch mode)`가 붙어 있습니다. 스캔 시점에 Playwright를 쓸 수 없어 liveness를 한 번도 확인하지 않았기 때문입니다. 스윕이 없으면 죽은 공고가 하나씩 평가 단계까지 도달해 유령 포지션에 시간과 토큰을 태웁니다.

1. `node check-liveness.mjs --file data/pipeline.md`를 실행합니다(큰 배치에서는 WAF 레이트 리밋 아래로 유지하기 위해 `--throttle`을 추가하십시오. 순수 Playwright이며 Claude 토큰은 0입니다). 체커는 인박스를 직접 읽습니다 — `- [ ]` 행을 가져오고, `- [x]`/`- [!]` 행과 `local:` 항목은 무시하며, 건너뛴 줄 수를 보고합니다. URL을 먼저 손으로 임시 파일에 복사하지 **마십시오**. 그 단계는 토큰을 쓰면서 실제로는 건너뛰게 되는 단계입니다.
2. 체커는 URL별 판정을 출력하고, expired/uncertain인 URL이 하나라도 있으면 0이 아닌 코드로 종료합니다.
3. 체커가 **expired/closed**로 보고한 URL은 처리하지 않고 종결합니다: 처리 완료 섹션으로 `- [x] ~~URL | 회사 | 직무~~ — 공고 만료 (liveness 스윕)` 형태로 옮기고, 트래커 행이 이미 있으면 `Discarded`로 설정합니다. 해당 항목에 대한 추출, 평가, report/PDF 생성은 **하지 않습니다**.
4. `uncertain` 결과는 그대로 두고 통상적인 추출 과정에서 확인합니다(일시적인 타임아웃 하나로 살아 있을 수도 있는 공고를 버려서는 안 됩니다).
5. 살아남은 live URL만 아래 처리 루프로 넘어갑니다.

## Workflow

1. **읽기** `data/pipeline.md` -> "대기" / "Pending" / "Pendientes" 섹션의 `- [ ]` item 찾기
2. **각 대기 URL에 대해**:
   a. `node reserve-report-num.mjs`를 실행해 다음 sequential `REPORT_NUM`을 atomic하게 예약합니다(report 작성 후 `node reserve-report-num.mjs --release <num>`으로 sentinel 해제).
   b. **공고 추출**: Playwright(`browser_navigate` + `browser_snapshot`) -> WebFetch -> WebSearch
   c. URL에 접근할 수 없으면 note와 함께 `- [!]`로 표시하고 계속합니다.
   d. **전체 auto-pipeline 실행**: Evaluation A-F -> Report .md -> PDF(score >= 3.0이면) -> Tracker
   e. **"대기"에서 "처리 완료"로 이동**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF yes/no`
3. **대기 URL이 3개 이상이어도 Playwright-backed 처리는 직렬로 실행합니다.** Playwright browser instance를 공유하므로 여러 browser-backed agent를 동시에 띄우지 않습니다. 병렬화가 필요하면 Playwright를 쓰지 않는 non-browser 작업에만 제한합니다.
4. **마지막에** 요약 표를 표시합니다.

```markdown
| # | Company | Role | Score | PDF | Recommended action |
```

## pipeline.md format

```markdown
## 대기
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Ltd | Senior PM
- [!] https://private.url/job -- Error: login required

## 처리 완료
- [x] #143 | https://jobs.example.com/posting/789 | Acme Korea | AI PM | 4.2/5 | PDF yes
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF no
```

> Note: 섹션 heading은 EN("Pending"/"Processed"), ES("Pendientes"/"Procesadas"), DE("Offen"/"Verarbeitet"), FR("En attente"/"Traitees"), KO("대기"/"처리 완료") 모두 유연하게 읽습니다. 쓸 때는 기존 파일의 style을 따릅니다.

## URL에서 공고를 지능적으로 감지

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. 모든 SPA에 대응합니다.
   - **선택 — CLI 추출기 (`config/profile.yml`의 `scan.extractor: cli`):** 대신 `node browser-extract.mjs <url>`(`--mode jd`) 실행 — 간결한 `{ "url", "title", "text" }`, 더 적은 토큰(포털에 따라 다름). 오류나 부재 시 **조용히** `browser_navigate` + `browser_snapshot`로 폴백.
2. **WebFetch (fallback):** 정적 페이지 또는 Playwright를 사용할 수 없을 때 사용합니다.
3. **WebSearch (last resort):** 공고를 index하는 secondary portal에서 검색합니다.

**특수 케이스:**
- **LinkedIn**: login이 필요할 수 있음 -> `[!]`로 표시하고 후보자에게 공고 text를 붙여넣어 달라고 요청
- **PDF**: URL이 PDF를 가리키면 Read tool로 직접 읽기
- **`local:` prefix**: 로컬 파일 읽기. 예: `local:jds/linkedin-pm-ai.md` -> `jds/linkedin-pm-ai.md` 읽기
- **원티드 / 리멤버 / 잡코리아 / 사람인 / LinkedIn KR**: 한국 시장에서 자주 쓰는 portal. cookie banner나 login wall이 있으면 Playwright로 먼저 확인

## 자동 번호 부여

1. `node reserve-report-num.mjs`를 실행해 다음 sequential number를 예약합니다(stdout이 `{###}` 반환).
2. 해당 번호로 report를 작성합니다.
3. report 작성 후 `node reserve-report-num.mjs --release {###}`를 실행해 sentinel을 해제합니다.

## Source sync

URL을 처리하기 전에 sync를 확인합니다.

```bash
node cv-sync-check.mjs
```

sync 문제가 있으면 계속하기 전에 후보자에게 알립니다.
