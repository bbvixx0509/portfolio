import { PenLine, Sparkles } from "lucide-react";
import type { ImportCourse } from "../../data/importPageMocks";
import styles from "./CourseImportRow.module.css";

type CourseImportRowProps = {
  course: ImportCourse;
  selected: boolean;
  onSelect: (courseId: string) => void;
};

export function CourseImportRow({
  course,
  selected,
  onSelect,
}: CourseImportRowProps) {
  const isAiGenerated = course.creationMode === "AI";

  return (
    <label
      className={`${styles.row} ${selected ? styles.selected : ""}`}
      data-course-id={course.id}
    >
      <input
        className={styles.radio}
        type="radio"
        name="import-course"
        value={course.id}
        checked={selected}
        onChange={() => onSelect(course.id)}
        aria-label={`${course.title} 선택`}
      />

      <span className={styles.icon} aria-hidden="true">
        {isAiGenerated ? (
          <Sparkles size={23} strokeWidth={2.1} />
        ) : (
          <PenLine size={23} strokeWidth={2.1} />
        )}
      </span>

      <span className={styles.body}>
        <span className={styles.headingRow}>
          <span className={styles.title}>{course.title}</span>
          <span className={styles.modeBadge}>
            {isAiGenerated ? "AI 생성" : "직접 입력"}
          </span>
          {course.status === "COMPLETED" ? (
            <span className={styles.statusBadge}>완료</span>
          ) : null}
        </span>

        <span className={styles.details}>
          <span>{course.itemCount}개 항목</span>
          <progress
            className={styles.progress}
            max={100}
            value={course.progressPercent}
            aria-label={`${course.title} 진행률`}
          >
            {course.progressPercent}%
          </progress>
          <strong>{course.progressPercent}%</strong>
        </span>
      </span>

      <time className={styles.lastUsed} dateTime={course.lastUsedAt}>
        {course.lastUsedLabel}
      </time>
    </label>
  );
}
