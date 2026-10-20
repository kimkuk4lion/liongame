# Liongame 🦁

**브라우저에서 즐기는 사자구슬 게임 — 싱글 연습과 실시간 멀티플레이**

[![Live](https://img.shields.io/badge/Play-game.cloudxt.app-2563eb?style=flat-square)](https://game.cloudxt.app)
[![Deploy](https://github.com/kimkuk4lion/liongame/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/kimkuk4lion/liongame/actions/workflows/deploy.yml)
[![Phaser](https://img.shields.io/badge/Phaser-3.90.0-blue?style=flat-square)](https://phaser.io/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8.4-black?style=flat-square)](https://socket.io/)

**플레이:** https://game.cloudxt.app  
**소스 코드:** https://github.com/kimkuk4lion/liongame

## 프로젝트 소개

Liongame은 Phaser 기반의 웹 구슬 게임입니다. 혼자 연습하거나, Socket.IO를 사용해 방을 생성하고 다른 플레이어와 실시간으로 게임을 진행할 수 있습니다. 현재 운영 서비스는 `game.cloudxt.app`에서 제공됩니다.

## 주요 기능

- **연습 모드:** 구슬 4개로 게임 플레이
- **멀티플레이:** 2~4인 방 생성·참가 및 턴제 대전
- **턴 제한:** 각 플레이어에게 10초의 행동 시간
- **점수·결과:** 구멍 진입과 충돌 등에 따른 점수 계산, 종료 후 점수판 제공
- **타격 조절:** 클릭 위치에 따라 힘이 달라지고 충돌 시 구슬이 밀려나는 상호작용
- **네트워크 복구 처리:** 플레이어 연결 해제·재접속 및 이탈 상황을 처리하는 서버 로직

> 게임 규칙 및 네트워크 처리의 상세 동작은 변경될 수 있으므로 실제 소스 코드를 기준으로 확인해 주세요.

## 기술 스택

| 구분 | 기술 |
| --- | --- |
| 게임 클라이언트 | Phaser 3, TypeScript |
| 빌드·개발 서버 | Vite 6 |
| 실시간 통신 | Socket.IO 4 (클라이언트·서버) |
| 서버 런타임 | Node.js (운영 CI: 24) |
| 프론트엔드 배포 | Vite 정적 빌드 (`docs/`) |
| CI/CD | GitHub Actions, SSH, rsync |
| 운영 프로세스 | PM2 |

## 빠른 시작

### 요구 환경

- Git
- Node.js 및 npm (Node.js 24 권장: 배포 워크플로와 동일)

### 설치

```bash
git clone https://github.com/kimkuk4lion/liongame.git
cd liongame
npm ci
```

개발 브랜치에서 작업하려면 다음을 실행합니다.

```bash
git switch development
```

### 환경변수

저장소의 `.env.example`을 참고하여 로컬용 `.env.development`를 생성합니다.

**Windows PowerShell**

```powershell
Copy-Item .env.example .env.development
```

**macOS / Linux**

```bash
cp .env.example .env.development
```

예시:

```dotenv
VITE_SOCKET_URL=http://localhost:3001
PORT=3001
CORS_ORIGIN=http://localhost:8080
```

| 변수 | 사용처 | 설명 |
| --- | --- | --- |
| `VITE_SOCKET_URL` | 브라우저 클라이언트 | Socket.IO 연결 주소. `VITE_` 변수는 브라우저 번들에 포함됩니다. |
| `PORT` | Node.js 서버 | Socket.IO 서버가 수신할 포트 |
| `CORS_ORIGIN` | Node.js 서버 | 허용할 프론트엔드 Origin |

`.env.development` 및 `.env.production`은 Git 추적에서 제외됩니다. 비밀키는 `VITE_` 변수에 넣지 마세요.

### 로컬 실행

터미널을 **두 개** 열어 실행합니다.

```bash
# 터미널 A: Socket.IO 서버
npm run server
```

```bash
# 터미널 B: 게임 클라이언트
npm run dev
```

- 게임 화면: http://localhost:8080
- 실시간 서버: http://localhost:3001 (예시 설정 기준)

## 명령어

| 명령어 | 설명 |
| --- | --- |
| `npm ci` | 잠금 파일 기준 의존성 설치 |
| `npm run dev` | Vite 개발 서버 실행 |
| `npm run server` | `.env.development`로 Socket.IO 서버 실행 |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm run build` | 프로덕션 정적 빌드 (`docs/` 출력) |
| `npm run server:prod` | `.env.production`으로 Socket.IO 서버 실행 |

`server` / `server:prod` 명령은 Node.js의 `--env-file` 옵션을 사용하므로 해당 옵션을 지원하는 Node.js 버전이 필요합니다.

## 배포 아키텍처

```text
브라우저
  └─ https://game.cloudxt.app
       ├─ 정적 게임 리소스 (Vite 빌드: docs/)
       └─ /socket.io/ → 실시간 통신 서버
                           └─ Node.js + Socket.IO (PM2 관리)
```

게임 페이지와 Socket.IO 요청은 같은 공개 도메인 `game.cloudxt.app`을 사용합니다. 실제 리버스 프록시 및 내부 포트 연결은 운영 서버의 Nginx 설정에 따라 달라질 수 있습니다.

### CI/CD

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)은 `main` 브랜치에 Push되거나 수동 실행될 때 배포를 수행합니다.

1. GitHub Actions(ubuntu-24.04)에서 Node.js 24 구성
2. `npm ci` 및 `npm run typecheck` 실행
3. `VITE_SOCKET_URL=https://game.cloudxt.app`으로 `npm run build` 실행
4. 빌드 결과(`docs/`), 서버 코드(`server/`), 패키지 파일을 SSH/rsync로 `/var/www/liongame`에 전송
5. 배포 서버에서 운영 의존성 설치 후 `liongame-server` PM2 프로세스 재시작·저장

GitHub Actions에 필요한 Secrets:

| Secret | 용도 |
| --- | --- |
| `SSH_HOST` | 대상 서버 호스트 |
| `SSH_USER` | SSH 계정 |
| `SSH_KEY` | 배포용 SSH 개인키 |
| `SSH_KNOWN_HOSTS` | 서버 호스트키 검증 정보 |

> **운영 환경 유의사항:** 현재 워크플로는 `.env.production`을 서버로 복사하지 않습니다. 서버 측 설정 파일과 PM2의 환경변수 로딩 방식은 별도로 구성해야 합니다. `pm2 restart --update-env`만으로 `.env.production`을 자동으로 읽는 것은 아닙니다.

### 운영 환경변수 예시

운영 서버의 `/var/www/liongame/.env.production` 예시:

```dotenv
VITE_SOCKET_URL=https://game.cloudxt.app
PORT=3001
CORS_ORIGIN=https://game.cloudxt.app
```

여기서 포트 3001은 프로젝트의 기본값이며, 실제 운영 포트는 서버 설정을 확인해야 합니다. 정적 클라이언트의 `VITE_SOCKET_URL`은 GitHub Actions 빌드 환경에서 설정합니다.

## 브랜치 및 협업 방식

| 브랜치 | 역할 |
| --- | --- |
| `main` | 운영 배포 기준 브랜치 |
| `development` | 기능 개발 및 검증용 브랜치 |

권장 작업 흐름:

1. `development`에서 최신 변경사항을 Pull합니다.
2. 코드 변경 후 로컬 실행 및 `npm run typecheck`, `npm run build`로 확인합니다.
3. `development`로 Push하고 Pull Request를 생성합니다.
4. 리뷰·확인 후 `main`에 병합하면 배포 워크플로가 실행됩니다.

```bash
git switch development
git pull origin development
# 변경 및 검증
git add .
git commit -m "fix: 멀티플레이 연결 처리 개선"
git push origin development
```

## 문제 해결

**멀티플레이 연결 실패** — 두 프로세스가 실행 중인지, `VITE_SOCKET_URL`이 올바른지, 브라우저 개발자 도구의 Network 탭에서 `/socket.io/` 요청이 성공하는지 확인합니다.

**CORS 오류** — `CORS_ORIGIN`이 실제 브라우저 접속 주소와 일치하는지 확인하고 서버를 다시 시작합니다.

**환경변수 변경이 반영되지 않음** — Vite의 `VITE_` 값은 빌드 시 주입되므로 변경 후 다시 빌드해야 합니다. 서버 환경변수는 프로세스를 재시작해야 적용됩니다.

**Git Push 403** — GitHub 로그인 계정에 해당 저장소의 쓰기 권한이 있는지 확인합니다. Git 커밋 작성자 설정(`user.name`, `user.email`)과 인증 계정은 서로 다릅니다.

## 기여 및 이슈

버그 제보와 기능 제안은 [GitHub Issues](https://github.com/kimkuk4lion/liongame/issues)를 이용해 주세요. 코드 변경은 `development`를 기준으로 검증한 뒤 Pull Request로 제안하는 것을 권장합니다.

## 라이선스

프로젝트 `package.json`에는 `MIT` 라이선스가 명시되어 있습니다. 실제 배포·재사용 시 저장소의 라이선스 파일과 서드파티 리소스 라이선스를 함께 확인해 주세요.

---

**Liongame** · [게임 플레이](https://game.cloudxt.app) · [소스 코드](https://github.com/kimkuk4lion/liongame) · [배포 현황](https://github.com/kimkuk4lion/liongame/actions/workflows/deploy.yml)
