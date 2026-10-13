# z-khan-jung · 한 단어씩 읽는 자기소개

RSVP(Rapid Serial Visual Presentation, 신속 순차 시각 제시) 방식으로 자기소개를 보여주고,
예시 글이나 직접 붙여 넣은 글로 속독을 체험해 볼 수 있는 개인 페이지입니다.

- **RSVP**: 화면의 같은 자리에 단어를 하나씩 띄워 눈 이동 없이 읽기
- **ORP**: 단어마다 최적 인식 지점(빨간 글자)을 같은 위치에 정렬
- **청킹**: 1~3어절씩 묶어서 보여주기
- 문장 부호와 문단 사이에서 자동으로 잠깐 멈추고, 속도는 100~1000어절/분으로 조절

빌드 단계 없는 정적 사이트입니다 (`index.html`, `style.css`, `rsvp.js`, `samples.js`).

## 고치는 곳
- 자기소개 글: `index.html`의 `<script id="intro-text">` 블록
- 예시 글: `samples.js`

## 로컬에서 보기
```
python3 -m http.server 8000   # http://localhost:8000
```

## 배포 (GitHub Pages)
`https://z-khan-jung.github.io`에서 열리려면 저장소 이름이 `z-khan-jung.github.io`여야 합니다.
1. Settings → General에서 저장소 이름을 `z-khan-jung.github.io`로 변경
2. 이 브랜치를 `main`에 병합
3. Settings → Pages → Source: *Deploy from a branch*, Branch: `main` / `(root)`
