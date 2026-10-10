// Explicit source list prevents a successful unrelated job from masking a stalled
// pipeline. Add an ingestion source only when its actual importer is connected.
export function requiredSyncSources(value = 'allergen_projection') {
  const sources = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!sources.length || sources.length > 10 || sources.some((item) => !/^[a-z][a-z0-9_]{0,63}$/.test(item))) {
    throw new Error('SYNC_REQUIRED_SOURCES must contain 1-10 bounded source names');
  }
  return sources;
}

export async function loadDataQuality(query, sources) {
  const { rows } = await query('data_quality', `SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE LOWER(COALESCE(ingredient_status, 'UNMATCHED')) = 'matched')::int AS matched,
    COUNT(*) FILTER (WHERE energy_kcal IS NULL OR carbohydrate_g IS NULL OR protein_g IS NULL
      OR fat_g IS NULL OR sugar_g IS NULL OR sodium_mg IS NULL)::int AS nutrition_missing
    FROM food_products WHERE active`);
  const sync = await query('data_last_success', `SELECT required.source_type,
    EXTRACT(EPOCH FROM MAX(r.finished_at) FILTER (WHERE r.status = 'completed'))::double precision AS last_success,
    COUNT(r.id) FILTER (WHERE r.status = 'failed' AND r.finished_at >= NOW() - INTERVAL '24 hours')::int AS failures
    FROM UNNEST($1::varchar[]) AS required(source_type)
    LEFT JOIN sync_runs r ON r.source_type = required.source_type
    GROUP BY required.source_type`, [sources]);
  const row = rows[0] || {};
  const total = row.total || 0;
  return {
    quality: {
      matchRatio: total ? (row.matched || 0) / total : undefined,
      missingRatio: total ? (row.nutrition_missing || 0) / total : undefined,
      // Backwards-compatible dashboard metric now specifically describes projection.
      lastSuccessAt: sync.rows.find((run) => run.source_type === 'allergen_projection')?.last_success ?? undefined,
    },
    sync: sync.rows,
  };
}
