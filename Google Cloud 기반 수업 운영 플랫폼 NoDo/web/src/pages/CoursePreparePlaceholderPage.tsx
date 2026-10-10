import { Link, useParams } from "react-router-dom";
import { importCourseMocks } from "../data/importPageMocks";
import styles from "./CoursePreparePlaceholderPage.module.css";
import { NotFoundPage } from "./NotFoundPage";

export function CoursePreparePlaceholderPage() {
  const { courseId } = useParams();
  const course = importCourseMocks.find((item) => item.id === courseId);

  if (!course) {
    return <NotFoundPage />;
  }

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="prepare-title">
        <p className={styles.eyebrow}>선택한 강의</p>
        <h1 id="prepare-title">{course.title}</h1>
        <dl className={styles.courseInfo}>
          <div>
            <dt>강의 ID</dt>
            <dd>{course.id}</dd>
          </div>
        </dl>
        <p className={styles.status}>
          이 강의의 준비 화면은 아직 구현하지 않았습니다.
        </p>
        <nav className={styles.actions} aria-label="준비 화면 이동">
          <Link to="/courses/import">목록 화면으로 돌아가기</Link>
          <Link to="/">시작 화면으로 돌아가기</Link>
        </nav>
      </section>
    </main>
  );
}
