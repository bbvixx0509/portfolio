import { themeOrderColumns } from './schema.js';
import { createSingleFlight } from './singleFlight.js';

export function normalizeKeyword(value) {
  return String(value || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

// Keep the existing eligibility and ranking rules, but hydrate ingredient/allergen
// subqueries only after the page's IDs have been selected.
export function buildProductQuery({ query = '', start = 1, display = 48, excludeCodes = [], theme = '' } = {}) {
  const offset = Math.max(start - 1, 0);
  const normalized = normalizeKeyword(query);
  // Hangul syllables and digits have no case. Preserve ILIKE for ASCII letters,
  // but avoid locale-aware case folding for every row on Korean-only searches.
  const matchOperator = /[a-z]/.test(normalized) ? 'ILIKE' : 'LIKE';
  const conditions = ['active', "ingredient_status = 'matched'", "health_functional_decision NOT IN ('EXCLUDE', 'REVIEW')"];
  const values = [];
  if (normalized) {
    values.push(`%${normalized}%`);
    conditions.push(`(normalized_name ${matchOperator} $${values.length} OR normalized_manufacturer ${matchOperator} $${values.length})`);
  }
  if (excludeCodes.length) {
    values.push(excludeCodes);
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM food_allergens fa
      WHERE fa.food_id = food_app_view.id AND fa.allergen_code = ANY($${values.length}::varchar[])
    )`);
  }
  const themeOrder = Object.hasOwn(themeOrderColumns, theme) ? themeOrderColumns[theme] : undefined;
  if (themeOrder) conditions.push(`${themeOrder[0]} IS NOT NULL`);
  const where = `WHERE ${conditions.join(' AND ')}`;
  const countSql = `SELECT COUNT(*)::int AS count FROM food_app_view ${where}`;
  const listValues = [...values];
  let order = '(id * 2654435761) % 4294967296 ASC, id ASC';
  if (normalized) {
    listValues.push(normalized, `${normalized}%`);
    order = `(normalized_name = $${listValues.length - 1}) DESC,
      (normalized_name ${matchOperator} $${listValues.length}) DESC, length(normalized_name) ASC, id ASC`;
  } else if (themeOrder) {
    order = `${themeOrder[0]} ${themeOrder[1]} NULLS LAST, id ASC`;
  }
  // Only the unfiltered catalogue needs its exact total for the home screen.
  const exactTotal = !normalized && excludeCodes.length === 0 && !themeOrder;
  const probe = exactTotal ? display : display + 1;
  listValues.push(probe, offset);
  const pageSql = `FROM food_app_view ${where} ORDER BY ${order}
    LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`;
  const listSql = normalized || themeOrder || offset > 0
    ? `WITH page_ids AS MATERIALIZED (SELECT id ${pageSql})
    SELECT food_app_view.* FROM page_ids
    JOIN food_app_view USING (id) ORDER BY ${order}`
    : `SELECT * ${pageSql}`;
  return { listSql, listValues, countSql, countValues: values, exactTotal, offset, display,
    // Baseline is exposed for read-only result/performance comparisons.
    baselineListSql: `SELECT * ${pageSql.replaceAll(' LIKE ', ' ILIKE ')}` };
}

export function createProductSearch({ query, countTtlMs = 30000, now = Date.now,
  admit = (task) => task(), observeCoalescing = () => {} }) {
  const coalesce = createSingleFlight({ observe: observeCoalescing });
  let countCache;
  let countFlight;
  async function catalogueCount(plan) {
    if (countCache && now() - countCache.at < countTtlMs) return countCache.value;
    if (!countFlight) {
      countFlight = query('product_search_count', plan.countSql, plan.countValues)
        .then(({ rows }) => {
          const value = rows[0]?.count || 0;
          countCache = { value, at: now() };
          return value;
        }).finally(() => { countFlight = null; });
    }
    return countFlight;
  }
  return async function search(input) {
    const plan = buildProductQuery(input);
    // SQL and all bound values include pagination, theme and allergy exclusions.
    // Coalesce BEFORE admission so duplicate searches don't occupy queue slots.
    const key = JSON.stringify([plan.listSql, plan.listValues]);
    return coalesce(key, () => admit(async () => {
      const [total, result] = await Promise.all([
        plan.exactTotal ? catalogueCount(plan) : null,
        query('product_search_list', plan.listSql, plan.listValues),
      ]);
      const rows = result.rows.slice(0, plan.display);
      return {
        rows,
        total: plan.exactTotal ? total : plan.offset + rows.length,
        exactTotal: plan.exactTotal,
        hasMore: plan.exactTotal ? plan.offset + rows.length < total : result.rows.length > plan.display,
      };
    }));
  };
}
