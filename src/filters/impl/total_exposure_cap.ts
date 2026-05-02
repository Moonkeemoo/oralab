import { type Filter, PASS, SKIP } from "../types.js";

/**
 * total_exposure_cap — sum(open entry costs) / budget cap. 0% skip rate in v1
 * audit window (open positions stayed under cap).
 */
export const totalExposureCap: Filter = {
  name: "total_exposure_cap",
  description: "Cap total $ exposure as fraction of budget",
  evaluate(ctx, params) {
    const cap = (params["capPctOfBudget"] as number | undefined) ?? 0.5;
    const v = ctx.account.budgetUsd > 0 ? ctx.account.totalExposureUsd / ctx.account.budgetUsd : 0;
    if (v >= cap) return SKIP({ v, t: cap }, "total exposure at cap");
    return PASS({ v, t: cap });
  },
};
