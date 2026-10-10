import styles from "./LocalRealCloudBadge.module.css";

export function LocalRealCloudBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <p className={styles.badge} role="status">
      LOCAL · REAL NODO CLOUD
    </p>
  );
}
