import { Link } from "react-router-dom";
import styles from "./FeaturePlaceholderPage.module.css";

type FeaturePlaceholderPageProps = {
  title: string;
};

export function FeaturePlaceholderPage({
  title,
}: FeaturePlaceholderPageProps) {
  return (
    <main className={styles.page}>
      <h1>{title}</h1>
      <p>이 화면은 다음 단계에서 구현할 예정입니다.</p>
      <Link to="/">시작 화면으로 돌아가기</Link>
    </main>
  );
}
