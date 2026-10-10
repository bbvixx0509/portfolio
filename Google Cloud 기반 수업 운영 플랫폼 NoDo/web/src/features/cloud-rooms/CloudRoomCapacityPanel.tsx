import type { User } from "firebase/auth";
import { UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getCloudRoomCapacity,
  increaseCloudRoomCapacity,
  keepCloudRoomCapacity,
  validActiveParticipantCapacity,
  type CloudRoomCapacity,
} from "./roomApi";
import styles from "./CloudRoomPages.module.css";

function message(error: unknown) {
  return error instanceof Error ? error.message : "접속 인원을 확인하지 못했습니다.";
}

export function CloudRoomCapacityPanel({
  user,
  roomId,
  compact = false,
}: {
  user: User | null;
  roomId: string;
  compact?: boolean;
}) {
  const [capacity, setCapacity] = useState<CloudRoomCapacity | null>(null);
  const [nextMaximum, setNextMaximum] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  useEffect(() => {
    let active = true;
    void getCloudRoomCapacity(user, roomId)
      .then((next) => {
        if (!active) return;
        setCapacity(next);
        setNextMaximum(String(next.maxActiveParticipants));
      })
      .catch((error: unknown) => {
        if (active) setNotice(message(error));
      });
    return () => { active = false; };
  }, [roomId, user]);

  async function keepCurrentCapacity() {
    if (!capacity || mutating) return;
    setMutating(true);
    setNotice(null);
    try {
      setCapacity(await keepCloudRoomCapacity(user, roomId));
    } catch (error) {
      setNotice(message(error));
    } finally {
      setMutating(false);
    }
  }

  async function increaseCapacity() {
    const requested = Number(nextMaximum);
    if (!capacity || !validActiveParticipantCapacity(requested) || requested <= capacity.maxActiveParticipants || mutating) return;
    setMutating(true);
    setNotice(null);
    try {
      setCapacity(await increaseCloudRoomCapacity(user, roomId, requested));
    } catch (error) {
      setNotice(message(error));
    } finally {
      setMutating(false);
    }
  }

  if (!capacity && !notice) return null;
  const requested = Number(nextMaximum);
  const canIncrease = capacity != null
    && capacity.canManageCapacity
    && capacity.maxActiveParticipants < 300
    && validActiveParticipantCapacity(requested)
    && requested > capacity.maxActiveParticipants;

  return (
    <section className={`${styles.capacityPanel}${compact ? ` ${styles.capacityPanelCompact}` : ""}`} aria-label="현재 접속 인원과 정원">
      {capacity ? <p className={styles.capacitySummary}><UsersRound aria-hidden="true" /> 현재 접속 <strong>{capacity.activeParticipantCount} / {capacity.maxActiveParticipants}명</strong></p> : null}
      {capacity?.canManageCapacity ? (
        <div className={capacity.capacityAlert ? styles.capacityAlert : styles.capacityActions}>
          {capacity.capacityAlert ? (
            <>
              <strong>정원 초과 알림</strong>
              <p>현재 정원을 유지하거나 더 큰 정원으로 늘릴 수 있습니다.</p>
            </>
          ) : <strong>정원 설정</strong>}
          <div className={styles.capacityActions}>
            {capacity.capacityAlert ? <button type="button" onClick={() => void keepCurrentCapacity()} disabled={mutating}>현재 정원 유지</button> : null}
            <label>
              새 정원
              <input aria-label="새 동시 참여 정원" inputMode="numeric" min={1} max={300} value={nextMaximum} onChange={(event) => setNextMaximum(event.target.value)} disabled={mutating || capacity.maxActiveParticipants >= 300} />
            </label>
            <button type="button" onClick={() => void increaseCapacity()} disabled={!canIncrease || mutating}>정원 늘리기</button>
          </div>
          {capacity.maxActiveParticipants >= 300 ? <p>최대 정원 300명에 도달했습니다.</p> : null}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
