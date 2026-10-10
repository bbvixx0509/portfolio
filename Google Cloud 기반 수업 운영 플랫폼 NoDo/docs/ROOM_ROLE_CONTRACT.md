# 02-6A 강의방 역할·공유 계약

조직 역할 `ADMIN`과 `INSTRUCTOR`는 강의방 역할과 별개다. 두 역할 모두 `ACTIVE` 수업 흐름에서 강의방을 만들 수 있다. Anonymous 학생은 강의방 생성·목록·상세·공유 API에 접근할 수 없다.

- `roomCreatorUid`는 강의방을 처음 만든 인증 사용자의 서버 전용 UID이며 변경하지 않는다.
- `leadInstructorUid`는 최초에는 생성자와 같고, 생성자는 `instructorMemberUids`에도 포함된다.
- `instructorMemberUids`는 방별 참여 강사 UID 목록이다. 02-6A에서는 생성자만 들어간다.
- ADMIN은 같은 조직의 READY 강의방을 운영 목적으로 목록·상세 조회할 수 있다. INSTRUCTOR는 자신의 `instructorMemberUids`에 포함된 방만 조회한다.
- 주 강사 이전, 참여 강사 초대, 세부 권한 위임은 02-6A에 포함하지 않는다.

강의방은 재사용 수업 흐름과 다른 실제 수업 회차다. 생성 시 `sourceCourseRevision`, `sourceCourseTitle`과 각 항목을 `flowItems` 하위 컬렉션에 스냅샷으로 저장한다. 원본 수업 흐름이 나중에 바뀌어도 기존 강의방 흐름은 바뀌지 않는다.

`roomCode`는 서버가 `secrets` 기반으로 혼동 문자 `I`, `O`, `0`, `1`을 제외한 8자리 대문자·숫자로 만들고, 같은 조직의 `roomCodes/{roomCode}` 인덱스와 함께 Transaction에 기록한다. 공유 링크는 브라우저의 현재 origin과 서버가 반환한 `/join/{orgId}/{roomCode}` 경로를 조합한다. QR, 학생 실제 입장, Anonymous 연결은 다음 기능 범위다.

02-6A는 Emulator·자동 테스트만 수행한다. 실제 Firestore 강의방·코드·감사 로그 검증은 02-6B에서 별도 승인 후 진행한다.

## 02-7A 익명 수강생 계약

`/join/{orgId}/{roomCode}`는 수강생에게 방 제목, `READY|LIVE` 상태와 입장 가능 여부만 보여 준다. 공개 API는 room ID, 조직 내부 정보, 강사·원본 수업·flowItems·감사 기록을 반환하지 않는다.

수강생은 Firebase Anonymous Auth만 사용한다. FastAPI가 토큰 UID를 내부 문서 경로에만 사용하며 UI·강사 목록·응답에 UID·이메일·실명·Google 정보·토큰을 노출하지 않는다. 참가자 문서는 별명, 정규화 키, 입장·마지막 확인 시각, `JOINED`, `isAnonymous: true`만 갖는다. Google 강사 계정은 학생 참여 API로 전환되지 않으며, 같은 브라우저의 강사 로그아웃도 수행하지 않는다.

## 02-8A 진행 체크리스트 권한 계약

- `leadInstructorUid`와 일치하는 STAFF만 `READY → LIVE`, 현재 항목 완료, 완료 항목 되돌리기를 수행할 수 있다.
- 같은 조직 `ADMIN`은 강의방·체크리스트를 운영 목적으로 읽을 수 있지만 lead instructor가 아닌 경우 진행을 바꾸지 못한다. 일반 `INSTRUCTOR`는 자기 주 강사 방만 변경한다.
- Anonymous 학생과 다른 조직 사용자는 checklist 읽기·변경 API에 접근할 수 없다.
- 체크리스트는 `isCompleted`만 저장한다. 현재 항목은 flowItems 정렬 순서의 첫 미완료 항목이고, 모든 완료 시 현재 항목은 없다. 별도 진행 상태·current item 저장은 금지한다.
- 모든 변경은 `expectedRevision` 및 Firestore Transaction으로 충돌을 막고 `ROOM_STARTED`, `CHECKLIST_ITEM_COMPLETED`, `CHECKLIST_REWOUND` 감사 계약을 사용한다. 향후 보조 강사 권한을 추가할 때도 lead 변경 권한과 별도로 명시한다.

## 02-12A 방별 보조 강사·주 강사 이전 계약

조직 역할 `ADMIN | INSTRUCTOR`는 방 운영 권한이 아니다. `roomInstructors` 배열이 강의방 역할과 위임 권한의 단일 진실 원천이며, 각 항목은 `uid`, `role: LEAD | ASSISTANT`, 현재 정의된 `permissions`, 표시명 스냅샷만 가진다. `leadInstructorUid`와 `instructorMemberUids`는 기존 읽기 경로 호환을 위한 같은 Transaction 내 투영값이다.

- 최초 생성자는 `LEAD`이며 `roomCreatorUid`는 어떤 역할 변경에서도 바뀌지 않는다. 방에는 언제나 정확히 한 명의 `LEAD`만 남는다.
- 새 `ASSISTANT`의 기본 권한은 질문 운영(`questionOperations`)만 허용한다. 체크리스트 진행(`checklistProgress`)과 정원 운영(`capacityOperations`)은 주 강사가 별도 부여한다.
- 전체 권한은 **현재 세 가지 위임 가능 권한만** 켠다. 보조 강사 초대·제거·권한 변경, 주 강사 넘기기 및 미래 기능 권한은 포함하지 않는다.
- 주 강사만 보조 강사 추가·제거·권한 변경·전체 권한 부여/회수·주 강사 넘기기를 수행한다. 넘기기 대상은 현재 `ASSISTANT`여야 하며, 이전 LEAD는 전체 권한을 가진 `ASSISTANT`로 남는다.
- 모든 역할 변경은 최신 `expectedRevision`을 Transaction에서 다시 확인하고 room 권한·호환 투영값·감사 문서를 원자적으로 갱신한다. 동일 revision 재시도나 Transaction 재시도로 감사 이벤트가 중복되면 안 된다.
- 감사 이벤트 `ROOM_ASSISTANT_ADDED`, `ROOM_ASSISTANT_REMOVED`, `ROOM_ASSISTANT_PERMISSIONS_UPDATED`, `ROOM_ASSISTANT_FULL_ACCESS_GRANTED`, `ROOM_ASSISTANT_FULL_ACCESS_REVOKED`, `ROOM_LEAD_TRANSFERRED`에는 room/수행 STAFF/대상 STAFF/역할·권한 변화만 기록하며 이메일·토큰·질문 본문은 기록하지 않는다.

React는 강사 관리와 실제 운영 화면 모두 FastAPI가 반환한 방별 권한만 사용한다. 질문·체크리스트·정원 명령은 화면의 버튼 표시와 무관하게 FastAPI에서 STAFF·조직·방 배정·현재 위임 권한을 다시 검사한다.
