import { Folder, PenLine, Sparkles } from "lucide-react";
import { RecentCourseList } from "../components/start/RecentCourseList";
import { StartHeader } from "../components/start/StartHeader";
import { StartMethodCard } from "../components/start/StartMethodCard";
import {
  mockRecentCourses,
  mockStartUser,
} from "../data/startPageMocks";
import styles from "./StartPage.module.css";

const materialFormats = [".PPTX", ".PDF", "CODE", "DATA"] as const;

export function StartPage() {
  return (
    <div className={styles.page}>
      <StartHeader user={mockStartUser} />

      <main className={styles.main}>
        <section className={styles.intro} aria-labelledby="start-title">
          <p className={styles.step}>STEP 00 · 시작하기</p>
          <h1 className={styles.title} id="start-title">
            오늘 강의할 <span>로드맵</span>,<br />
            어떻게 만들어볼까요?
          </h1>
          <p className={styles.subtitle}>
            강의 자료를 올려서 AI에게 맡기거나, 직접 항목을 채워 넣거나 —
            편한 방법을 골라주세요
          </p>
        </section>

        <section className={styles.cards} aria-label="로드맵 시작 방식">
          <StartMethodCard
            Icon={Sparkles}
            title="자료로 만들기"
            description="PPT · PDF 발표 자료와 코드 · 데이터 파일을 함께 올리면 AI가 하나의 수업 순서로 정리하고 항목마다 짧은 요약을 붙여드려요"
            badges={materialFormats}
            actionLabel="자료 올리기"
            to="/create/material"
            recommended
          />

          <StartMethodCard
            Icon={PenLine}
            title="직접 만들기"
            description="챕터와 세부 항목을 하나씩 직접 입력해서 나만의 로드맵을 처음부터 만들 수 있어요"
            supportingLabel="빈 목록으로 시작"
            actionLabel="항목 입력하기"
            to="/create/manual"
          />

          <StartMethodCard
            Icon={Folder}
            title="기존 목록 불러오기"
            actionLabel="전체 목록 보기"
            to="/courses/import"
          >
            <RecentCourseList courses={mockRecentCourses} />
          </StartMethodCard>
        </section>

        <p className={styles.note}>
          <span aria-hidden="true" />
          선택한 방식은 언제든 다른 방식으로 바꿀 수 있어요
        </p>
      </main>
    </div>
  );
}
