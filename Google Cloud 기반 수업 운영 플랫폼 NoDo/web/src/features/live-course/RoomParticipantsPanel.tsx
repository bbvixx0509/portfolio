import { LockKeyhole, RotateCcw, UsersRound, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { requestApi } from "../../lib/api/apiClient";
import type { LiveParticipant } from "./liveCourseTypes";
import styles from "./RoomParticipantsPanel.module.css";

type ParticipantsResponse = {
  participants?: unknown[];
};

function stringValue(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof data[key] === "string") return data[key] as string;
  }
  return null;
}

export function normalizeParticipant(value: unknown): LiveParticipant | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const participantId = stringValue(data, "participantId", "id");
  if (!participantId) return null;
  return {
    participantId,
    nickname: stringValue(data, "nickname", "nicknameSnapshot") ?? "익명 수강생",
    status: stringValue(data, "status") ?? "ACTIVE",
    isQuestionRestricted:
      data.isQuestionRestricted === true || data.questionRestricted === true,
  };
}

type RoomParticipantsPanelProps = {
  roomId: string;
  user: User | null;
  open: boolean;
  isRoomActive: boolean;
  onClose: () => void;
};

export function RoomParticipantsPanel({
  roomId,
  user,
  open,
  isRoomActive,
  onClose,
}: RoomParticipantsPanelProps) {
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadParticipants = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    setNotice(null);
    try {
      const response = await requestApi<ParticipantsResponse>(
        `/api/rooms/${encodeURIComponent(roomId)}/participants`,
        { authUser: user },
      );
      setParticipants(
        (response.participants ?? [])
          .map(normalizeParticipant)
          .filter((entry): entry is LiveParticipant => Boolean(entry)),
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "참여자 정보를 불러오지 못했습니다.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [roomId, user]);

  useEffect(() => {
    if (open) void loadParticipants();
  }, [loadParticipants, open]);

  async function toggleRestriction(participant: LiveParticipant) {
    if (!user || pendingId || !isRoomActive) return;
    setPendingId(participant.participantId);
    setNotice(null);
    try {
      const response = await requestApi<unknown>(
        `/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(participant.participantId)}`,
        {
          method: "PATCH",
          body: { isQuestionRestricted: !participant.isQuestionRestricted },
          authUser: user,
        },
      );
      const updated = normalizeParticipant(response);
      setParticipants((current) =>
        current.map((entry) =>
          entry.participantId === participant.participantId
            ? updated ?? {
                ...entry,
                isQuestionRestricted: !entry.isQuestionRestricted,
              }
            : entry,
        ),
      );
      setNotice(
        participant.isQuestionRestricted
          ? "질문 작성 제한을 해제했습니다."
          : "질문 작성을 제한했습니다.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "참여자 상태를 저장하지 못했습니다.",
      );
    } finally {
      setPendingId(null);
    }
  }

  if (!open) return null;

  return (
    <div className={styles.backdrop} role="presentation">
      <section
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="participants-title"
      >
        <header>
          <div>
            <span><UsersRound aria-hidden="true" size={16} /> PARTICIPANTS</span>
            <h2 id="participants-title">참여자 관리</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="참여자 관리 닫기">
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <p className={styles.safeNotice}>
          익명 별명과 참여 상태만 표시합니다. 실제 이메일·실명·Firebase UID는 표시하지 않습니다.
        </p>
        <div className={styles.summary}>
          <strong>{participants.length}</strong>
          <span>명 참여</span>
          <small>질문 제한 {participants.filter((entry) => entry.isQuestionRestricted).length}명</small>
        </div>
        {isLoading ? <p role="status">참여자를 불러오는 중입니다.</p> : null}
        <ul>
          {participants.map((participant) => (
            <li key={participant.participantId}>
              <div>
                <strong>{participant.nickname}</strong>
                <span>{participant.status === "ACTIVE" ? "참여 중" : "퇴장"}</span>
              </div>
              <button
                type="button"
                disabled={Boolean(pendingId) || !isRoomActive}
                onClick={() => void toggleRestriction(participant)}
              >
                {participant.isQuestionRestricted ? (
                  <RotateCcw aria-hidden="true" size={14} />
                ) : (
                  <LockKeyhole aria-hidden="true" size={14} />
                )}
                {participant.isQuestionRestricted ? "질문 제한 해제" : "질문 제한"}
              </button>
            </li>
          ))}
        </ul>
        {!isLoading && participants.length === 0 ? (
          <p className={styles.empty}>아직 참여한 수강생이 없습니다.</p>
        ) : null}
        {!isRoomActive ? (
          <p className={styles.ended}>종료된 강의에서는 참여자 제한을 변경할 수 없습니다.</p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </section>
    </div>
  );
}
