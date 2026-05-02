"use strict";
import { openSheet } from "../sheets.js";

export function openPositionSheet(id) {
  openSheet(`<div class="muted">Position #${id} drilldown — coming next</div>`);
}
