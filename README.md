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
| 데이터베이스 | PostgreSQL |
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

저장소의 `.env.example`을 복사해 로컬용 `.env`를 만듭니다. 이미 `.env`가 있으면 필요한 항목만 입력합니다.

**Windows PowerShell**

```powershell
Copy-Item .env.example .env
```

**macOS / Linux**

```bash
cp .env.example .env
```

예시:

```dotenv
PORT=3001
CORS_ORIGIN=http://localhost:8080
APP_URL=http://localhost:8080/
KAKAO_REST_API_KEY=
KAKAO_CLIENT_SECRET=
KAKAO_REDIRECT_URI=http://localhost:8080/api/auth/kakao/callback
DATABASE_URL=
```

| 변수 | 사용처 | 설명 |
| --- | --- | --- |
| `VITE_SOCKET_URL` | 브라우저 클라이언트 | Socket.IO 주소를 별도로 지정할 때 사용합니다. 기본은 게임 페이지와 같은 origin입니다. |
| `PORT` | Node.js 서버 | Socket.IO 서버가 수신할 포트 |
| `CORS_ORIGIN` | Node.js 서버 | 허용할 프론트엔드 Origin |
| `APP_URL` | Node.js 서버 | 카카오 로그인에 필요한 공개 게임 주소. 로그인 완료 후 이동과 계정 변경 요청의 출처 검증에 사용합니다. |
| `KAKAO_REST_API_KEY` | Node.js 서버 | 카카오 앱 REST API 키 |
| `KAKAO_CLIENT_SECRET` | Node.js 서버 | 카카오 앱에서 발급한 클라이언트 시크릿 |
| `KAKAO_REDIRECT_URI` | Node.js 서버 | 카카오 앱에 등록한 전체 콜백 주소 |
| `DATABASE_URL` | Node.js 서버 | PostgreSQL 연결 주소. 형식은 `postgresql://사용자:비밀번호@호스트:5432/데이터베이스`입니다. |

`.env`, `.env.development`, `.env.production`은 Git 추적에서 제외됩니다. 비밀키는 `VITE_` 변수에 넣지 마세요.

카카오 개발자 콘솔에서 카카오 로그인을 활성화하고 `KAKAO_REDIRECT_URI`와 일치하는 주소를 등록합니다. 로컬에서는 게임과 콜백 모두 `localhost` 주소를 사용하세요. 카카오 로그인에서 이메일 동의 화면을 없애려면 카카오 개발자 콘솔에서도 **카카오계정(이메일)** 동의항목을 사용 안 함으로 설정합니다. 최초 가입 시 한글 단어 4글자와 숫자 4자리로 닉네임을 생성합니다. 마이페이지에서 닉네임을 변경할 수 있으며 순위표에는 게임 닉네임이 표시됩니다. [카카오 로그인 설정](https://developers.kakao.com/docs/ko/kakaologin/prerequisite)

PostgreSQL에 애플리케이션용 데이터베이스와 사용자를 만든 뒤 `DATABASE_URL`을 입력합니다. 서버는 시작할 때 필요한 테이블을 생성합니다. 연습과 멀티플레이에는 카카오 로그인이 필요하며 계정 닉네임을 사용합니다. 순위표에는 연습 최고 점수와 멀티플레이 승리 횟수 기준으로 각각 상위 10명이 표시됩니다.

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
| `npm run server` | `.env`와 선택적인 `.env.development`를 읽어 서버 실행 |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm run build` | 프로덕션 정적 빌드 (`docs/` 출력) |
| `npm run server:prod` | `.env`와 선택적인 `.env.production`을 읽어 서버 실행 |

`server` / `server:prod` 명령은 Node.js의 `--env-file` 옵션을 사용하므로 해당 옵션을 지원하는 Node.js 버전이 필요합니다.

## 배포 아키텍처

```text
브라우저
  └─ https://game.cloudxt.app
       ├─ 정적 게임 리소스 (Vite 빌드: docs/)
       └─ /socket.io/, /api/ → 게임 서버
                           └─ Node.js + Socket.IO (PM2 관리)
```

운영 Nginx에서 같은 도메인의 `/api/`를 기존 Socket.IO 백엔드 포트로 프록시하고 경로를 유지합니다. 운영 환경의 `APP_URL`, `CORS_ORIGIN`, `KAKAO_REDIRECT_URI`에는 공개 HTTPS 주소를 사용합니다.

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
APP_URL=https://game.cloudxt.app/
KAKAO_REST_API_KEY=
KAKAO_CLIENT_SECRET=
KAKAO_REDIRECT_URI=https://game.cloudxt.app/api/auth/kakao/callback
DATABASE_URL=
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
