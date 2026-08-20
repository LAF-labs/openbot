# M0 배포 — OCI Always Free 단일 VM

파일럿용 첫 박스다. 여러 사업자를 받는 최종 모양이 아니며, 과금 시작 전(M2)에
컨트롤 플레인과 러너를 분리한다. 이 문서는 사람이 하는 일과 스크립트가 하는
일을 가른다.

## 보안 형태 (중요)

AUTH(M1-2)가 붙기 전까지 이 배포는 `OPENBOT_DEV_NO_AUTH=true`로 돈다.
그래서 **어떤 서비스 포트도 인터넷에 열지 않는다** — 전부 localhost 바인딩,
접근은 SSH 터널로만:

```bash
ssh -N -L 3010:127.0.0.1:3010 -L 3001:127.0.0.1:3001 ubuntu@<VM-IP>
```

방화벽은 22번만 연다. AUTH가 붙는 날, 이 문단이 이 파일에서 지워지는 것이
공개 전환의 조건이다.

## 사람이 하는 일 (1회)

1. **OCI 계정 생성** — cloud.oracle.com. **홈 리전은 가입 시 한 번 정하면
   못 바꾼다.** 춘천(ap-chuncheon-1)은 Always Free A1을 만들 수 없는 유일한
   리전이니 절대 고르지 말 것. 서울(ap-seoul-1)이 1순위, 목록에 없으면
   오사카/도쿄(한국에서 RTT ~30ms, 파일럿에 무해).
   가입 후 **Pay As You Go 업그레이드는 사실상 필수**다 — 카드를 등록해도
   Always Free 한도 안은 그대로 무료이고, 인스턴스 기동 우선순위가 올라가
   "Out of capacity"를 훨씬 덜 만난다.
   *(2026-08-20 실제 파일럿: 홈 리전 오사카 ap-osaka-1, PAYG 전환 완료.)*
2. **인스턴스 생성** — Compute → Instances → Create:
   - Shape: **VM.Standard.A1.Flex, 2 OCPU / 12GB** — 2026-06-15부터 Always
     Free A1 한도가 4/24에서 반토막 났다. PAYG면 4/24를 계속 무료로 준다는
     서포트 답변이 돌지만 문서화된 적이 없으니, 2/12로 잡고 시작한다.
     (러너·Postgres·프론트 모두 I/O 바운드고 추론은 외부 API로 나가므로
     파일럿엔 2/12로 충분하다.)
   - Image: **Ubuntu 24.04 (aarch64)**
   - Boot volume: 100GB
   - SSH 키: 본인 키 등록 (배포 맡길 키의 공개키를 추가로 등록)
   - "Out of capacity"가 나면 시간을 두고 재시도한다. 서울·오사카는 단일 AD
     리전이라 바꿔 볼 가용 도메인이 없다
3. VM의 공인 IP와 SSH 접근을 전달한다.

## 스크립트가 하는 일

```bash
ssh ubuntu@<VM-IP> 'bash -s' < deploy/setup-vm.sh
```

- 시스템 준비: 스왑 4G, UFW(22만 허용), fail2ban, unattended-upgrades
- 런타임: bun, docker(+compose)
- 앱: 레포 클론(laf/m0) → postgres 기동 → 마이그레이션 → `.env` 생성
  (KEY_ENCRYPTION_KEY 자동 생성, **모델 API 키는 사람이 채운다**)
- systemd 유닛 3개: `laf-server`, `laf-agent-bot`, `laf-app`(vite preview)
  — 전부 127.0.0.1 바인딩
- 백업: 매일 04:00 `pg_dump` → `/var/backups/laf/` 14벌 보관 (kreview에서
  배운 그 크론과 같은 모양)

## 스크립트가 하지 않는 일

- 모델 API 키 입력(`/opt/laf/openbot/.env`의 `OPENAI_API_KEY` — agent-bot용
  DeepSeek 키). 비밀은 사람 손으로.
- 도메인/HTTPS — 공개 전환(M1-2 이후)의 일이다.
