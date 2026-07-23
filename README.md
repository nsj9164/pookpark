# 🎮 Coop Park

URL로 친구를 초대해 함께 하는 **피코파크식 협동 플랫포머**.
친구 머리를 밟고 올라가고, 다 같이 열쇠를 먹고 문으로 모이면 클리어!

## 조작
- 이동: `← →` 또는 `A D`
- 점프: `↑` / `W` / `Space`
- 친구 머리를 밟고 높은 곳으로, 전원이 문에 모이면 다음 스테이지

## 로컬 실행
```bash
npm install
npm start
```
→ 브라우저에서 http://localhost:3000

## 인터넷 배포 (Render)
1. 이 코드를 GitHub 저장소에 올린다.
2. https://render.com 가입 → **New +** → **Blueprint** → GitHub 저장소 선택.
3. `render.yaml`을 자동으로 읽어 배포. 발급된 `https://coop-park.onrender.com` 주소를 친구에게 공유.

> 무료 플랜은 15분간 접속이 없으면 잠들고, 다음 접속 시 30초 정도 후 깨어납니다.

## 기술 구조
- **서버 권위형** 물리 시뮬레이션(60fps) — 클라이언트 간 화면 어긋남 방지
- **WebSocket** 실시간 동기화, 방(room) 코드 기반 매칭
- 서버·클라이언트가 레벨 데이터 공유 (`public/shared/levels.js`)

## 파일 구조
```
server.js              서버: 물리엔진 + 방 관리 + WebSocket
public/
  index.html           로비 / 게임 화면
  client.js            입력 전송 + 보간 렌더링
  style.css            UI 스타일
  shared/levels.js     레벨 데이터 (서버·클라 공용)
render.yaml            Render 배포 설정
```
