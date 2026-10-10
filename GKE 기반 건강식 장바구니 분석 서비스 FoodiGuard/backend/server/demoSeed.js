import crypto from 'node:crypto';

const demoProducts = [
  { code: 'DEMO-001', reportNo: 'D-001', name: '저염 닭가슴살 오리지널', maker: '푸디랩', categories: ['가공식품', '식육가공품', '닭가슴살', '저염'], serving: 100, weight: 100, nutrients: [112, 2, 24, 2, 1, 0, 210, 0.5, 0, 58], ingredients: ['닭가슴살', '정제수', '천일염'], allergens: ['CHICKEN'] },
  { code: 'DEMO-002', reportNo: 'D-002', name: '훈제 닭가슴살 갈릭', maker: '푸디랩', categories: ['가공식품', '식육가공품', '닭가슴살', '훈제'], serving: 100, weight: 100, nutrients: [145, 5, 22, 4, 3, 0, 760, 1.3, 0, 62], ingredients: ['닭가슴살', '마늘', '간장', '설탕', '정제소금'], allergens: ['CHICKEN', 'SOY', 'WHEAT'] },
  { code: 'DEMO-003', reportNo: 'D-003', name: '현미 곤약밥', maker: '그린테이블', categories: ['가공식품', '즉석식품', '즉석밥', '현미밥'], serving: 150, weight: 150, nutrients: [128, 28, 3.4, 1.2, 0.4, 4.2, 18, 0.1, 0, 0], ingredients: ['현미', '곤약', '정제수'], allergens: [] },
  { code: 'DEMO-004', reportNo: 'D-004', name: '흰쌀 즉석밥', maker: '매일한끼', categories: ['가공식품', '즉석식품', '즉석밥', '백미밥'], serving: 210, weight: 210, nutrients: [151, 34, 2.8, 0.3, 0, 0.5, 5, 0, 0, 0], ingredients: ['쌀', '정제수'], allergens: [] },
  { code: 'DEMO-005', reportNo: 'D-005', name: '통밀 저나트륨 컵면', maker: '바른면', categories: ['가공식품', '면류', '유탕면', '용기면'], serving: 80, weight: 80, nutrients: [315, 57, 11, 7, 3.5, 5, 380, 2.5, 0, 0], ingredients: ['통밀가루', '밀단백', '건조채소', '저염분말스프'], allergens: ['WHEAT', 'SOY'] },
  { code: 'DEMO-006', reportNo: 'D-006', name: '매운 치즈 컵라면', maker: '바른면', categories: ['가공식품', '면류', '유탕면', '용기면'], serving: 80, weight: 80, nutrients: [465, 67, 9, 18, 7, 2, 1790, 8, 0, 5], ingredients: ['밀가루', '팜유', '치즈분말', '설탕', '정제소금'], allergens: ['WHEAT', 'MILK', 'SOY'] },
  { code: 'DEMO-007', reportNo: 'D-007', name: '플레인 그릭요거트', maker: '데일리밀크', categories: ['가공식품', '유가공품', '발효유', '그릭요거트'], serving: 100, weight: 100, nutrients: [92, 5, 10, 4, 4, 0, 52, 2.2, 0, 15], ingredients: ['원유', '유산균'], allergens: ['MILK'] },
  { code: 'DEMO-008', reportNo: 'D-008', name: '딸기 시럽 그릭요거트', maker: '데일리밀크', categories: ['가공식품', '유가공품', '발효유', '그릭요거트'], serving: 100, weight: 100, nutrients: [168, 22, 7, 6, 18, 0, 75, 3.5, 0, 18], ingredients: ['원유', '딸기시럽', '설탕', '유산균'], allergens: ['MILK'] },
  { code: 'DEMO-009', reportNo: 'D-009', name: '병아리콩 단백질 샐러드', maker: '그린테이블', categories: ['가공식품', '즉석식품', '샐러드', '곡물샐러드'], serving: 220, weight: 220, nutrients: [118, 12, 8, 4, 3, 6.5, 165, 0.6, 0, 0], ingredients: ['병아리콩', '양상추', '토마토', '현미', '레몬즙'], allergens: ['TOMATO'] },
  { code: 'DEMO-010', reportNo: 'D-010', name: '시저 치킨 샐러드', maker: '그린테이블', categories: ['가공식품', '즉석식품', '샐러드', '치킨샐러드'], serving: 220, weight: 220, nutrients: [176, 9, 12, 10, 4, 3, 540, 3.2, 0, 18], ingredients: ['닭가슴살', '로메인', '치즈', '마요네즈', '정제소금'], allergens: ['CHICKEN', 'MILK', 'EGG'] },
  { code: 'DEMO-011', reportNo: 'D-011', name: '저당 견과 프로틴바', maker: '밸런스온', categories: ['가공식품', '과자류', '영양바', '단백질바'], serving: 45, weight: 45, nutrients: [320, 27, 28, 12, 4, 9, 190, 2.8, 0, 8], ingredients: ['분리대두단백', '아몬드', '땅콩', '에리스리톨', '코코아'], allergens: ['SOY', 'PEANUT'] },
  { code: 'DEMO-012', reportNo: 'D-012', name: '초코 크림 쿠키', maker: '스위트데이', categories: ['가공식품', '과자류', '쿠키', '초코쿠키'], serving: 30, weight: 90, nutrients: [510, 64, 5, 26, 34, 2, 420, 13, 0, 8], ingredients: ['밀가루', '설탕', '팜유', '코코아', '우유분말'], allergens: ['WHEAT', 'MILK'] },
  { code: 'DEMO-013', reportNo: 'D-013', name: '무가당 오트 크래커', maker: '스위트데이', categories: ['가공식품', '과자류', '쿠키', '곡물크래커'], serving: 30, weight: 90, nutrients: [365, 58, 11, 10, 2, 10, 210, 2, 0, 0], ingredients: ['귀리', '통밀가루', '올리브유', '천일염'], allergens: ['WHEAT'] },
  { code: 'DEMO-014', reportNo: 'D-014', name: '무가당 두유', maker: '콩하루', categories: ['가공식품', '음료류', '두유', '무가당'], serving: 190, weight: 190, nutrients: [54, 3, 4.6, 2.6, 0.8, 1.2, 85, 0.4, 0, 0], ingredients: ['대두', '정제수', '해조칼슘'], allergens: ['SOY'] },
  { code: 'DEMO-015', reportNo: 'D-015', name: '단백질 강화 오트밀', maker: '밸런스온', categories: ['가공식품', '곡류가공품', '시리얼', '오트밀'], serving: 50, weight: 250, nutrients: [355, 55, 20, 8, 3, 11, 120, 1.4, 0, 0], ingredients: ['귀리', '완두단백', '치아씨드'], allergens: [] },
  { code: 'DEMO-H001', reportNo: 'HF-001', name: '체지방 케어 가르시니아', maker: '헬스서플리', dataType: '건강기능식품', categories: ['건강기능식품', '체지방', '정제', '가르시니아'], serving: 2, unit: 'g', weight: 60, nutrients: [5, 1, 0, 0, 0, 0, 5, 0, 0, 0], ingredients: ['가르시니아캄보지아추출물', '결정셀룰로스'], allergens: [], healthFunctional: true },
];

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

export async function seedDemoData(pool) {
  if (process.env.SEED_DEMO_DATA !== 'true') return false;
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM food_products');
  if ((count.rows[0]?.count || 0) > 0) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const product of demoProducts) {
      const [categoryLarge, categoryMedium, categorySmall, categoryDetail] = product.categories;
      const unit = product.unit || 'g';
      const [energy, carbs, protein, fat, sugar, fiber, sodium, saturatedFat, transFat, cholesterol] = product.nutrients;
      const foodResult = await client.query(
        `
          INSERT INTO food_products (
            food_code, report_no, name, normalized_name, manufacturer, normalized_manufacturer,
            data_type_name, category_large, category_medium, category_small, category_detail,
            nutrition_basis_amount, nutrition_basis_unit, serving_reference_amount, serving_reference_unit,
            food_weight_amount, food_weight_unit, energy_kcal, carbohydrate_g, protein_g, fat_g,
            sugar_g, fiber_g, sodium_mg, saturated_fat_g, trans_fat_g, cholesterol_mg, source_name
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            100, $12, $13, $12, $14, $12, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 'FoodiGuard simulator seed'
          ) RETURNING id
        `,
        [product.code, product.reportNo, product.name, normalize(product.name), product.maker, normalize(product.maker), product.dataType || '가공식품', categoryLarge, categoryMedium, categorySmall, categoryDetail, unit, product.serving, product.weight, energy, carbs, protein, fat, sugar, fiber, sodium, saturatedFat, transFat, cholesterol],
      );
      const foodId = foodResult.rows[0].id;
      const ingredientText = product.ingredients.join(', ');
      const sourceResult = await client.query(
        `
          INSERT INTO ingredient_source_rows (
            report_no, product_name, normalized_product_name, manufacturer, normalized_manufacturer,
            product_type, changed_on, ingredient_text, raw_hash
          ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7, $8)
          RETURNING id
        `,
        [product.reportNo, product.name, normalize(product.name), product.maker, normalize(product.maker), categorySmall, ingredientText, crypto.createHash('sha256').update(ingredientText).digest('hex')],
      );
      const sourceId = sourceResult.rows[0].id;
      await client.query(
        `INSERT INTO food_ingredient_matches (food_id, ingredient_source_id, match_method, match_status, selected_changed_on)
         VALUES ($1, $2, 'REPORT_NO_EXACT', 'MATCHED', CURRENT_DATE)`,
        [foodId, sourceId],
      );
      for (const [index, ingredient] of product.ingredients.entries()) {
        await client.query(
          `INSERT INTO food_ingredients (food_id, source_row_id, ordinal, ingredient_name, normalized_name)
           VALUES ($1, $2, $3, $4, $5)`,
          [foodId, sourceId, index + 1, ingredient, normalize(ingredient)],
        );
      }
      for (const allergen of product.allergens) {
        await client.query(
          `INSERT INTO food_allergens (food_id, allergen_code, presence_status)
           VALUES ($1, $2, 'PRESENT')`,
          [foodId, allergen],
        );
      }

      if (product.healthFunctional) {
        const healthResult = await client.query(
          `
            INSERT INTO health_functional_products (
              report_no, normalized_report_no, product_name, normalized_product_name,
              company_name, normalized_company_name, product_type
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
          `,
          [product.reportNo, normalize(product.reportNo), product.name, normalize(product.name), product.maker, normalize(product.maker), categorySmall],
        );
        await client.query(
          `INSERT INTO health_functional_matches (food_id, health_functional_product_id, match_method, decision)
           VALUES ($1, $2, 'REPORT_NO_EXACT', 'EXCLUDE')`,
          [foodId, healthResult.rows[0].id],
        );
      } else {
        await client.query(
          `INSERT INTO health_functional_matches (food_id, match_method, decision)
           VALUES ($1, 'NONE', 'CLEAR')`,
          [foodId],
        );
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

