# 02-9A 질문·답변 계약

## 저장 경계

공개 문서는 `organizations/{orgId}/rooms/{roomId}/questions/{questionId}`에 저장한다.

- 필수 공개 필드: `content`, `nicknameSnapshot`, `isGeneral`, `itemId`, `itemNumberSnapshot`, `itemTitleSnapshot`, `chapterTitleSnapshot`, `visibility`, `moderationStatus`, `isAnswered`, `answer`, `isHidden`, `createdAt`, `updatedAt`, `schemaVersion`
- 항목 질문은 선택한 flowItem의 챕터·번호·제목을 생성 Transaction에서 스냅샷으로 저장한다. 일반 질문은 item 관련 필드가 `null`이다.
- 공식 `answer`는 `content`, `staffDisplayName`, `roomRole: "LEAD"`, `answeredAt`만 가진다. 답변은 질문 바로 아래에 표시한다. 학생 응답에서는 `staffDisplayName`을 제거하고 `공식 답변`만 표시한다.
- 공개 문서에 익명 UID, Google UID, 이메일, 실명, ID/OAuth Token, 강사 UID·이메일을 저장하지 않는다.

`questionAuthors/{questionId}`는 FastAPI 전용 비공개 문서다. 익명 작성자 UID, clientRequestId, 정규화 digest/fingerprint와 전송 시각만 보관하며 React와 공개 API에는 반환하지 않는다. 강사용 `questionReads/{staffUid}/contexts/...`도 비공개다.

## 읽음 문맥과 감사

- 문맥은 `ALL`, `GENERAL`, `ITEM:{flowItemId}`다. `ALL` 읽음 위치는 이전 일반·항목 질문까지 읽음으로 계산하고, 특정 문맥 읽음은 그 문맥에만 적용한다.
- React는 FastAPI에 `contextId`와 실제 화면에서 관찰한 `observedQuestionId`만 보낸다. 서버는 질문의 방·문맥·소속과 저장 시각을 검증하며 클라이언트 시각을 받거나 신뢰하지 않는다.
- watermark가 앞으로 이동할 때만 `QUESTION_READ` 감사 로그를 만든다. 로그는 `roomId`, `contextId`, `observedQuestionId`, STAFF 내부 식별자와 서버 시각만 가지며 질문 본문·학생 UID·이메일·토큰은 담지 않는다.
- 학생 API와 학생 화면에는 읽음 상태 및 새 질문 수를 반환하거나 표시하지 않는다.

## 가시성과 권한

- 학생은 LIVE 방의 실제 Anonymous 참가자일 때만 질문을 만들며, PUBLIC·미숨김 질문과 답변만 읽는다.
- `STAFF_ONLY`는 검토 필요 규칙에 해당하는 질문이다. 학생에게 분류·판정 이유를 표시하지 않는다.
- 주 강사만 답변·답변 취소·숨김·복구를 한다. ADMIN은 강사용 목록을 읽기만 한다.
- 강사 목록은 전체, 일반, 항목 문맥을 필터하고 전체/새 질문 수 및 항목별 전체/새 질문 수를 FastAPI에서 계산한다.

## 02-10A 학생 체크리스트 읽기 모델

- `GET /api/public/rooms/{orgId}/{roomCode}/checklist`는 실제 Anonymous 참가자만 호출할 수 있다. READY/LIVE 방의 제목·상태·정렬된 챕터/항목 표시 정보·완료 여부·현재 항목·PUBLIC 질문 전체/항목 수만 반환한다.
- 이 모델은 강사 이름·이메일·UID, `roomCreatorUid`, `leadInstructorUid`, 원본 수업 내부 정보, questionAuthors, STAFF_ONLY/숨김 질문, 새 질문 수, Firestore 경로와 감사 로그를 반환하지 않는다.
- 학생 체크리스트의 항목 배지는 `/join/{orgId}/{roomCode}/chat?context=ITEM:{itemId}`로 이어지고, 목록 조회 자체는 questionReads 또는 `QUESTION_READ` 감사 로그를 만들지 않는다.

## 규칙과 후속 작업

질문은 1~500자, 답변은 1~2000자다. 현재 금칙어, 검토 필요, 10초 반복 전송, 30초 동일·유사 질문 처리는 규칙 기반이다. Gemini, Perspective API, Google AI Studio, Google Sheets API를 호출하지 않는다.

Sheets 내보내기, 수업 종료 후 삭제·보존 기간과 실제 Firestore 질문/답변/읽음 검증은 후속 단계다. 02-9A에서는 local Emulator만 사용하며 실제 검증은 02-9B의 별도 승인 뒤 진행한다.

## 02-11A 참가자 수 기준

질문·배지·읽음 기능은 누적 `participants` 문서 수를 현재 접속 인원으로 사용하지 않는다. 별도 프로필 또는 기기에서의 익명 재입장은 새 UID와 누적 문서를 만들 수 있다. 현재 접속/정원 판단은 private presence lease와 capacity 카운터에만 맡기며, 질문 공개 응답에는 participant UID·이메일·presence·정원 정보를 추가하지 않는다.
