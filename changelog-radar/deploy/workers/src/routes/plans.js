/**
 * Plans routes — list from D1.
 */

/**
 * GET /api/v1/plans — list all plans.
 */
export async function listPlans(request, env, ctx) {
  const plans = await env.DB.prepare(
    'SELECT key, name, price_monthly, max_sources, max_team_members, retention_days, rate_limit_rpm, features_json FROM plans ORDER BY price_monthly ASC'
  ).all();

  const formatted = plans.results.map(p => ({
    ...p,
    price_monthly_dollars: (p.price_monthly / 100).toFixed(2),
    features: JSON.parse(p.features_json || '{}'),
  }));

  return ctx.json({ plans: formatted });
}

/**
 * GET /api/v1/plans/:key — single plan detail.
 */
export async function getPlan(request, env, ctx) {
  const plan = await env.DB.prepare('SELECT * FROM plans WHERE key = ?')
    .bind(ctx.params.key).first();

  if (!plan) return ctx.json({ error: 'Plan not found' }, 404);

  return ctx.json({
    plan: {
      ...plan,
      price_monthly_dollars: (plan.price_monthly / 100).toFixed(2),
      features: JSON.parse(plan.features_json || '{}'),
    },
  });
}
