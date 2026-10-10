import type { User } from "firebase/auth";
import { ChevronLeft, ChevronRight, Download, FileText, Presentation, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCloudRoomMaterial,
  getCloudRoomPdf,
  getCloudRoomPptxUnit,
  getStudentRoomMaterial,
  getStudentRoomPdf,
  getStudentRoomPptxUnit,
  type PptxUnitContent,
  type RoomMaterial,
  updateCloudRoomMaterialPosition,
  downloadCloudRoomMaterial,
  downloadStudentRoomMaterial,
} from "./roomMaterialApi";
import styles from "./LiveRoomMaterialPane.module.css";

type StaffScope = { mode: "staff"; roomId: string };
type StudentScope = { mode: "student"; orgId: string; roomCode: string };

export function LiveRoomMaterialPane({ user, scope }: { user: User | null; scope: StaffScope | StudentScope }) {
  const [material, setMaterial] = useState<RoomMaterial | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pptx, setPptx] = useState<PptxUnitContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);
  const mounted = useRef(true);
  const scopeMode = scope.mode;
  const staffRoomId = scope.mode === "staff" ? scope.roomId : "";
  const studentOrgId = scope.mode === "student" ? scope.orgId : "";
  const studentRoomCode = scope.mode === "student" ? scope.roomCode : "";

  const loadMetadata = useCallback(async () => {
    // Isolated page tests commonly use a minimal auth stub.  Real Firebase
    // users always expose getIdToken; avoid leaking a background request into
    // those test-only shells.
    if (!user || typeof user.getIdToken !== "function") {
      if (mounted.current) setLoading(false);
      return;
    }
    try {
      const next = scopeMode === "staff"
        ? await getCloudRoomMaterial(user, staffRoomId)
        : await getStudentRoomMaterial(user, studentOrgId, studentRoomCode);
      if (mounted.current) {
        setMaterial(next);
        setError(null);
      }
    } catch {
      if (mounted.current) setError("강의 자료 상태를 불러오지 못했습니다. 마지막 정상 화면을 유지합니다.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [scopeMode, staffRoomId, studentOrgId, studentRoomCode, user]);

  useEffect(() => {
    mounted.current = true;
    void loadMetadata();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMetadata();
    }, 2500);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [loadMetadata]);

  useEffect(() => {
    const currentMaterial = material;
    if (!currentMaterial || !user || typeof user.getIdToken !== "function") {
      setPptx(null);
      setPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
      return;
    }
    const materialForContent: RoomMaterial = currentMaterial;
    let disposed = false;
    let url: string | null = null;
    async function loadContent() {
      try {
        if (materialForContent.fileType === "pdf") {
          const blob = scopeMode === "staff"
            ? await getCloudRoomPdf(user, staffRoomId)
            : await getStudentRoomPdf(user, studentOrgId, studentRoomCode);
          if (disposed) return;
          url = URL.createObjectURL(blob);
          setPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return url; });
          setPptx(null);
        } else {
          const next = scopeMode === "staff"
            ? await getCloudRoomPptxUnit(user, staffRoomId)
            : await getStudentRoomPptxUnit(user, studentOrgId, studentRoomCode);
          if (!disposed) { setPptx(next); setPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return null; }); }
        }
      } catch {
        if (!disposed) setError("강의 자료 내용을 불러오지 못했습니다. 마지막 정상 화면을 유지합니다.");
      }
    }
    void loadContent();
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [material?.fileType, material?.currentUnitNumber, material?.materialRevision, scopeMode, staffRoomId, studentOrgId, studentRoomCode, user]);

  async function move(unitNumber: number) {
    if (!material || scopeMode !== "staff" || !material.canControl || moving) return;
    setMoving(true);
    try {
      const next = await updateCloudRoomMaterialPosition(user, staffRoomId, unitNumber, material.materialRevision);
      if (next) { setMaterial(next); setError(null); }
    } catch { setError("페이지·슬라이드 위치를 바꾸지 못했습니다. 최신 상태를 다시 확인해 주세요."); }
    finally { setMoving(false); }
  }

  async function download() {
    if (!material || !user) return;
    try {
      const blob = scopeMode === "staff" ? await downloadCloudRoomMaterial(user, staffRoomId) : await downloadStudentRoomMaterial(user, studentOrgId, studentRoomCode);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${material.displayTitle}.${material.fileType}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { setError("현재 자료를 다운로드할 수 없습니다."); }
  }

  if (loading) return <section className={styles.loading} aria-live="polite">수업 자료를 준비하고 있어요.</section>;
  if (!material) return <section className={styles.empty} aria-label="연결된 수업 자료 없음"><FileText aria-hidden="true" /><div><strong>연결된 자료가 없습니다</strong><p>가짜 문서 영역 없이 수업 흐름과 질문 문맥을 계속 확인할 수 있습니다.</p></div>{error ? <small role="alert">{error}</small> : null}</section>;

  const unitLabel = material.fileType === "pdf" ? "페이지" : "슬라이드";
  return <section className={styles.pane} aria-label="동기화된 강의 자료">
    <header><div><span>{material.fileType === "pdf" ? <FileText aria-hidden="true" /> : <Presentation aria-hidden="true" />}</span><div><p>동기화된 수업 자료</p><h2>{material.displayTitle}</h2></div></div><p>{unitLabel} {material.currentUnitNumber} / {material.totalUnits}</p></header>
    <div className={styles.viewer}>
      {material.fileType === "pdf" ? (pdfUrl ? <iframe title={`${material.displayTitle} ${material.currentUnitNumber}${unitLabel}`} src={`${pdfUrl}#page=${material.currentUnitNumber}`} /> : <p>PDF 페이지를 불러오는 중입니다.</p>) : <article className={styles.slide}><p>{unitLabel} {material.currentUnitNumber}</p><h3>{pptx?.title ?? "제목 없음"}</h3><pre>{pptx?.text ?? "슬라이드 내용을 불러오는 중입니다."}</pre></article>}
    </div>
    <footer><div className={styles.controls} aria-label={`${unitLabel} 이동`}><button type="button" onClick={() => void move(material.currentUnitNumber - 1)} disabled={!material.canControl || moving || material.currentUnitNumber <= 1}><ChevronLeft aria-hidden="true" /> 이전</button><strong>{material.currentUnitNumber} / {material.totalUnits}</strong><button type="button" onClick={() => void move(material.currentUnitNumber + 1)} disabled={!material.canControl || moving || material.currentUnitNumber >= material.totalUnits}>다음 <ChevronRight aria-hidden="true" /></button></div><button className={styles.retry} type="button" onClick={() => void download()}><Download aria-hidden="true" /> 자료 다운로드</button>{material.canControl ? <small>주 강사가 이동하면 학생 화면도 같은 {unitLabel}로 동기화됩니다.</small> : <small>주 강사가 선택한 {unitLabel}를 보고 있습니다.</small>}{error ? <button className={styles.retry} type="button" onClick={() => void loadMetadata()}><RefreshCw aria-hidden="true" /> 다시 확인</button> : null}</footer>
  </section>;
}
