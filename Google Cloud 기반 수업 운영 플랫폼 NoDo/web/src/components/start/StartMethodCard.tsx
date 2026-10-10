import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import styles from "./StartMethodCard.module.css";

type StartMethodCardProps = {
  Icon: LucideIcon;
  title: string;
  description?: string;
  badges?: readonly string[];
  supportingLabel?: string;
  actionLabel: string;
  to: string;
  recommended?: boolean;
  children?: ReactNode;
};

export function StartMethodCard({
  Icon,
  title,
  description,
  badges,
  supportingLabel,
  actionLabel,
  to,
  recommended = false,
  children,
}: StartMethodCardProps) {
  return (
    <article
      className={`${styles.card} ${recommended ? styles.recommended : ""}`}
    >
      {recommended ? <span className={styles.recommendBadge}>추천</span> : null}

      <span className={styles.iconWrap} aria-hidden="true">
        <Icon size={28} strokeWidth={1.8} />
      </span>

      <h2 className={styles.title}>{title}</h2>
      {description ? <p className={styles.description}>{description}</p> : null}

      {badges ? (
        <ul className={styles.badges} aria-label={`${title} 지원 형식`}>
          {badges.map((badge) => (
            <li key={badge}>{badge}</li>
          ))}
        </ul>
      ) : null}

      {supportingLabel ? (
        <span className={styles.supportingLabel}>{supportingLabel}</span>
      ) : null}

      {children}

      <Link
        className={`${styles.action} ${recommended ? styles.primaryAction : ""}`}
        to={to}
      >
        {actionLabel}
      </Link>
    </article>
  );
}
