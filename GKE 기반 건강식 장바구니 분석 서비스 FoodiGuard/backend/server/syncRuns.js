const EMPTY_STATS = Object.freeze({
  read: 0,
  inserted: 0,
  updated: 0,
  matched: 0,
  unmatched: 0,
});

export const PRODUCT_CHANGED_IN_WINDOW = `(
  $3::TIMESTAMPTZ IS NULL
  OR (p.updated_at >= $3 AND p.updated_at < $4)
  OR EXISTS (
    SELECT 1 FROM food_ingredients fi
    JOIN ingredient_source_rows source ON source.id = fi.source_row_id
    WHERE fi.food_id = p.id AND source.updated_at >= $3 AND source.updated_at < $4
  )
)`;

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function normalizeStats(stats = {}) {
  return {
    read: nonNegativeInteger(stats.read),
    inserted: nonNegativeInteger(stats.inserted),
    updated: nonNegativeInteger(stats.updated),
    matched: nonNegativeInteger(stats.matched),
    unmatched: nonNegativeInteger(stats.unmatched),
  };
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
}

export async function startSyncRun(database, {
  sourceType,
  mode,
  metadata = {},
}) {
  if (!sourceType || !mode) throw new Error('sourceType과 mode가 필요합니다.');
  const stats = normalizeStats(EMPTY_STATS);
  const { rows } = await database.query(
    `
      INSERT INTO sync_runs (
        source_type, mode, status, read_count, inserted_count, updated_count,
        matched_count, unmatched_count, metadata
      ) VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8::JSONB)
      RETURNING id, started_at
    `,
    [
      sourceType,
      mode,
      stats.read,
      stats.inserted,
      stats.updated,
      stats.matched,
      stats.unmatched,
      JSON.stringify(safeMetadata(metadata)),
    ],
  );
  return rows[0];
}

export async function completeSyncRun(database, id, stats = {}, metadata = null) {
  const normalized = normalizeStats(stats);
  const { rows } = await database.query(
    `
      UPDATE sync_runs
      SET status = 'completed',
          finished_at = NOW(),
          read_count = $2,
          inserted_count = $3,
          updated_count = $4,
          matched_count = $5,
          unmatched_count = $6,
          error_message = NULL,
          metadata = CASE WHEN $7::JSONB IS NULL THEN metadata ELSE metadata || $7::JSONB END
      WHERE id = $1 AND status = 'running'
      RETURNING id, status, finished_at
    `,
    [
      id,
      normalized.read,
      normalized.inserted,
      normalized.updated,
      normalized.matched,
      normalized.unmatched,
      metadata ? JSON.stringify(safeMetadata(metadata)) : null,
    ],
  );
  if (!rows[0]) throw new Error(`실행 중인 sync_runs 행을 완료할 수 없습니다: ${id}`);
  return rows[0];
}

export async function failSyncRun(database, id, error, stats = {}) {
  const normalized = normalizeStats(stats);
  const message = String(error?.message || error || 'unknown sync error').slice(0, 4000);
  const { rows } = await database.query(
    `
      UPDATE sync_runs
      SET status = 'failed',
          finished_at = NOW(),
          read_count = $2,
          inserted_count = $3,
          updated_count = $4,
          matched_count = $5,
          unmatched_count = $6,
          error_message = $7
      WHERE id = $1 AND status = 'running'
      RETURNING id, status, finished_at
    `,
    [
      id,
      normalized.read,
      normalized.inserted,
      normalized.updated,
      normalized.matched,
      normalized.unmatched,
      message,
    ],
  );
  return rows[0] || null;
}

export async function latestSuccessfulSyncAt(database, sourceType) {
  const { rows } = await database.query(
    `
      SELECT MAX(finished_at) AS finished_at
      FROM sync_runs
      WHERE source_type = $1
        AND status = 'completed'
        AND finished_at IS NOT NULL
    `,
    [sourceType],
  );
  return rows[0]?.finished_at || null;
}

// Revisit changes made during the previous run. finished_at is not a safe
// ingestion cursor: a row read early can change before that run finishes.
export async function latestSuccessfulWatermark(database, sourceType) {
  const { rows } = await database.query(`SELECT MAX(started_at) AS watermark
    FROM sync_runs WHERE source_type = $1 AND status = 'completed'`, [sourceType]);
  return rows[0]?.watermark || null;
}

export async function acquireSyncLock(database, sourceType) {
  const { rows } = await database.query(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`foodiguard:sync:${sourceType}`],
  );
  if (!rows[0]?.locked) {
    const error = new Error(`Sync already running: ${sourceType}`);
    error.code = 'SYNC_ALREADY_RUNNING';
    throw error;
  }
}

export async function releaseSyncLock(database, sourceType) {
  await database.query('SELECT pg_advisory_unlock(hashtext($1))', [`foodiguard:sync:${sourceType}`]);
}

export { normalizeStats };
