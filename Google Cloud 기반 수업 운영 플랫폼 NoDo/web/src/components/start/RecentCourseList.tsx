import type { MockRecentCourse } from "../../data/startPageMocks";
import styles from "./RecentCourseList.module.css";

type RecentCourseListProps = {
  courses: readonly MockRecentCourse[];
};

export function RecentCourseList({ courses }: RecentCourseListProps) {
  return (
    <ul className={styles.list} aria-label="최근 사용 목록">
      {courses.map((course) => (
        <li className={styles.item} key={course.id}>
          <span className={styles.title}>{course.title}</span>
          <time className={styles.date} dateTime={course.lastUsedDate}>
            {course.lastUsedLabel}
          </time>
        </li>
      ))}
    </ul>
  );
}
