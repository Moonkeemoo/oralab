-- Multi-KPI lift matrix on calibrator_recommendations (v1 audit, port from
-- calibrator/multi_kpi.py). lift_matrix carries per-KPI deltas in native
-- units; aims carries the top-N KPI names whose lift drives the rec.
ALTER TABLE "calibrator_recommendations"
  ADD COLUMN IF NOT EXISTS "lift_matrix" jsonb,
  ADD COLUMN IF NOT EXISTS "aims" jsonb;
