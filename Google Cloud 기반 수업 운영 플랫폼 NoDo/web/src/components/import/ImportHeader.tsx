import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import styles from "./ImportHeader.module.css";

export function ImportHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.brandGroup}>
        <Link className={styles.logo} to="/" aria-label="NoDo">
          <span className={styles.logoMark} aria-hidden="true">
            <span>NO</span>
            <span>DO</span>
          </span>
        </Link>
        <span className={styles.contextLabel}>기존 목록 불러오기</span>
      </div>

      <Link className={styles.homeLink} to="/">
        <ChevronLeft aria-hidden="true" size={18} strokeWidth={2.8} />
        시작 화면으로
      </Link>
    </header>
  );
}
