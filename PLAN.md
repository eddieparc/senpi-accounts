# senpi-accounts 실행 계획 (승인 대기)

조사 근거는 `DESIGN.md` 참조. 이 문서는 "무엇을 어떤 순서로 만들 것인가"만 다룬다.

## 1. 레이어 분리 — 충돌 방지의 핵심

senpi에는 이미 **모델 단위** 폴백이 있다 (`core/retry-fallback/`):
- `SelectorCooldowns` — 실패한 `provider/model` 셀렉터를 런타임 동안 억제.
  429는 30초, quota/billing은 **30분**, 그 외 기본 5분.
- `chains.ts` — 셀렉터가 억제되면 다음 모델로 넘어가는 폴백 체인.

우리 애드온은 **계정 단위** 폴백이다. 두 계층은 이렇게 겹치지 않게 둔다:

```
요청
 └─ [우리 계층] 계정 선택 → 429면 다음 계정으로 재시도 (senpi는 이걸 못 봄)
     └─ 모든 계정 소진 시에만 에러를 위로 던짐
         └─ [순정 계층] SelectorCooldowns가 모델 억제 → 다음 모델로 폴백
```

계정 로테이션이 성공하는 한 senpi는 실패를 아예 관측하지 않으므로 충돌이 없다.

**결정적 통합 포인트**: `SelectorCooldowns.durationFor()`는 `retryAfterMs`가 있으면
그 값을 **최우선**으로 쓴다. 따라서 모든 계정이 막혔을 때 우리가 던지는 에러에
`retryAfterMs = (가장 빨리 풀리는 계정의 blockedUntil - now)`를 실어 보내면,
senpi의 억제 시간이 우리 failback 시점과 **정확히 일치**한다. 이걸 안 하면
quota 문자열이 섞였을 때 senpi가 30분을 통째로 억제해서, 5분 뒤 풀리는 계정을
놀리게 된다. → 회귀 테스트로 고정한다.

## 2. 계정 라우팅 3계층 (우선순위 순)

| 순위 | 계층 | 동작 |
|---|---|---|
| 1 | **캐시 어피니티** | 한 대화는 한 계정에 고정. 프리픽스 캐시를 지킨다 |
| 2 | **사용량 기반 배치** | 캐시가 어차피 콜드일 때(새 대화)만 잔여 쿼터 여유분에 배치 |
| 3 | **429 페일오버** | 최후 안전망 (구현·검증 완료) |

- 대화 지문은 **첫 사용자 메시지만** 해시 (Antigravity `session_manager.rs` 방식).
  모델명·타임스탬프를 섞지 않아야 턴이 진행돼도 앵커가 흔들리지 않는다.
- 배치는 **P2C**(상위 N개 중 2개 무작위 → 잔여량 큰 쪽). 항상 "제일 빈 계정"을
  고르면 몰림이 생긴다.
- Kiro 잔여량은 `getUsageLimits`(`usedCount`/`limitCount`)로 조회.

스케줄링 모드는 Antigravity를 벤치마크해 사용자가 고르게 한다:

| 모드 | 동작 |
|---|---|
| `cache-first` | 계정 고정 우선, 429면 짧게 대기(상한 있음). 캐시 히트 최대 |
| `balanced` (기본) | 계정 고정하되 429면 즉시 전환 |
| `spread` | 순수 라운드로빈. 부하 균등, 캐시 포기 |

## 3. /login · /logout 통합 (요구사항 10)

순정 `claude-agent-sdk/oauth-login.ts`가 이미 정답을 보여준다: `/login`의
`login()`이 기존 자격증명을 읽어 **`addAccount`로 계정을 추가**하고, 두 번째
계정부터는 이름을 물어본다(`promptAccountName`). 우리도 동일 패턴을 따른다.

- **`/login kiro`** → 계정 관리 메뉴를 띄운다:
  `추가 / 제거 / 고정(pin) / 고정해제 / 목록`.
  - 추가: Google·GitHub·AWS Builder ID 중 선택 → OAuth → 이름 입력
    (첫 계정은 자동으로 `default`, 이후 기본값 `account-N` 제시)
  - 제거: 등록된 계정 목록에서 선택
  - 이렇게 하면 **등록·삭제가 전부 `/login`에서 가능**하다. senpi 본체를
    수정하지 않고 요구사항을 만족하는 유일하게 깔끔한 방법.
- **`/logout kiro`** → 순정 동작 그대로: 해당 프로바이더 자격증명 전체 삭제
  (= 모든 계정 제거). 우리 풀이 그 자격증명 안에 살기 때문에 자동으로 일관됨.
- `/kiro-account ...` 서브커맨드는 스크립트·비대화형용으로 유지.

UX 원칙: 목록에 계정별 상태를 함께 보여준다 —
`jgplabs <메일> — available, google` / `jgp3620 — blocked 12m (rate_limit)`.

## 4. 구현 순서

**Phase A — Kiro 완성 (최우선, 아침까지)**
1. `retryAfterMs` 전파 + senpi 쿨다운 정합 테스트
2. 대화 지문 기반 어피니티 + 스케줄링 모드
3. `/login` 계정 관리 메뉴
4. 샌드박스에서 Google 로그인 3계정 등록 → **opus-5 실호출 검증**
5. 429 강제 유발 → 전환·failback 안정화 테스트

**Phase B — 나머지 프로바이더 (격리 패키지)**
6. Codex 다중계정 (fast 모드는 순정 `service-tier.ts` 그대로 사용)
7. Anthropic — 순정 `/claude-account`에 위임, 우리는 진단만 노출
8. Alibaba Coding Plan / OpenCode Go 패키지 스캐폴드

**Phase C — 마감**
9. 키체인 옵션 + 실제 라운드트립 테스트
10. 프로바이더 1개 고장 시 나머지 정상 등록 확인 (격리 회귀 테스트)

## 5. 확인이 필요한 결정 사항

- **D1**: `/logout kiro`를 "전체 삭제"로 두는 것이 맞는지. 개별 삭제는
  `/login kiro` 메뉴와 `/kiro-account remove`로 제공하는 안을 제안한다.
- **D2**: 기본 스케줄링 모드를 `balanced`로 할지 `cache-first`로 할지.
  카톡 근거상 개인 사용은 fill-first(=캐시 우선)에 가깝다.
