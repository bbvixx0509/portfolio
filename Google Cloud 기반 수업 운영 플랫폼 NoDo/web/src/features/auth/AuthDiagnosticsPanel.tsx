import type { AuthDiagnostics } from "./authDiagnostics";
import styles from "./AuthDiagnosticsPanel.module.css";

type AuthDiagnosticsPanelProps = {
  diagnostics?: AuthDiagnostics;
};

export function AuthDiagnosticsPanel({
  diagnostics,
}: AuthDiagnosticsPanelProps) {
  if (!diagnostics?.enabled) return null;

  return (
    <section className={styles.panel} aria-labelledby="auth-diagnostics-title">
      <div className={styles.heading}>
        <div>
          <p>DEVELOPMENT ONLY</p>
          <h3 id="auth-diagnostics-title">Google 로그인 진단</h3>
        </div>
        <span>안전한 상태만 표시</span>
      </div>
      <ol className={styles.steps}>
        {diagnostics.steps.map((item) => (
          <li key={item.id} data-status={item.status}>
            <span aria-hidden="true" className={styles.indicator} />
            <div>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
