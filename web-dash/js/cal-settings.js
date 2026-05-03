/* Ora et Labora — Calibrator Settings sub-tab */
/* All configurable calibrator parameters, organized in 5 groups */

(function (App) {
  'use strict';

  const esc = App.esc;

  // ── Unit conversion helpers ────────────────────────────────────────────────

  // Convert stored value → display value
  function _toDisplay(key, stored) {
    if (stored == null) return '';
    switch (key) {
      case 'CF_TRACKING_WINDOW':  return String(Math.round(stored / 3600));        // s → h
      case 'CF_CHECK_INTERVAL':   return String(Math.round(stored / 60));          // s → min
      case 'CAL_RUN_INTERVAL':    return String(Math.round(stored / 60));          // s → min
      case 'DECAY_HALF_LIFE':     return String((stored / 86400).toFixed(1));      // s → days
      case 'CAL_MAX_STEP':        return String((stored * 100).toFixed(1));        // dec → %
      default:                    return String(stored);
    }
  }

  // Convert display value → stored value
  function _fromDisplay(key, display) {
    const n = parseFloat(display);
    if (isNaN(n)) return null;
    switch (key) {
      case 'CF_TRACKING_WINDOW':  return Math.round(n * 3600);    // h → s
      case 'CF_CHECK_INTERVAL':   return Math.round(n * 60);      // min → s
      case 'CAL_RUN_INTERVAL':    return Math.round(n * 60);      // min → s
      case 'DECAY_HALF_LIFE':     return Math.round(n * 86400);   // days → s
      case 'CAL_MAX_STEP':        return parseFloat((n / 100).toFixed(6));  // % → dec
      case 'CF_MAX_PENDING':
      case 'CAL_MIN_TRADES':
      case 'CAL_MAX_RECS':
      case 'SAFETY_WR_DROP_ROLLBACK':
      case 'SAFETY_VERIFY_TIMEOUT': return Math.round(n);
      default:                    return n;
    }
  }

  // Unit label shown after the input
  function _unitLabel(key) {
    switch (key) {
      case 'CF_TRACKING_WINDOW':  return App.t('cal.unit_h');
      case 'CF_CHECK_INTERVAL':   return App.t('cal.unit_m');
      case 'CAL_RUN_INTERVAL':    return App.t('cal.unit_m');
      case 'DECAY_HALF_LIFE':     return App.t('cal.unit_d');
      case 'CAL_MAX_STEP':        return '%';
      case 'SAFETY_VERIFY_TIMEOUT': return App.t('cal.unit_s');
      case 'SAFETY_WR_DROP_ROLLBACK': return 'pp';
      default:                    return '';
    }
  }

  // Input step for number fields
  function _inputStep(key) {
    if (key.startsWith('IMPORTANCE_')) return '0.1';
    switch (key) {
      case 'CAL_MAX_STEP':
      case 'DECAY_HALF_LIFE':       return '0.1';
      case 'BAYES_STABLE_THRESHOLD':
      case 'BAYES_UNCERTAIN_THRESHOLD':
      case 'BAYES_AUTO_MIN_CONF':
      case 'DECAY_MIN_WEIGHT':
      case 'MIN_LIFT_THRESHOLD':    return '0.01';
      default:                      return '1';
    }
  }

  // ── Group definitions ──────────────────────────────────────────────────────

  const GROUPS = [
    {
      id: 'multikpi',
      titleKey: 'cal.grp_multikpi',
      color: '#a78bfa',
      isNew: true,
      fields: [
        { key: 'MIN_LIFT_THRESHOLD',          labelKey: 'cal.settings_min_lift_threshold',  type: 'number' },
        { key: 'IMPORTANCE_WIN_RATE',         labelKey: 'cal.imp_win_rate',                  type: 'number' },
        { key: 'IMPORTANCE_PROFIT_FACTOR',    labelKey: 'cal.imp_profit_factor',             type: 'number' },
        { key: 'IMPORTANCE_AVG_PNL',          labelKey: 'cal.imp_avg_pnl',                   type: 'number' },
        { key: 'IMPORTANCE_PASS_RATE',        labelKey: 'cal.imp_pass_rate',                 type: 'number' },
        { key: 'IMPORTANCE_SL_RATE',          labelKey: 'cal.imp_sl_rate',                   type: 'number' },
        { key: 'IMPORTANCE_TP_HIT_RATE',      labelKey: 'cal.imp_tp_hit_rate',               type: 'number' },
        { key: 'IMPORTANCE_EXIT_EFFICIENCY',  labelKey: 'cal.imp_exit_efficiency',           type: 'number' },
        { key: 'IMPORTANCE_LEFT_ON_TABLE',    labelKey: 'cal.imp_left_on_table',             type: 'number' },
      ],
    },
    {
      id: 'counterfactual',
      titleKey: 'cal.grp_counterfactual',
      color: '#22d3ee',
      fields: [
        { key: 'CF_TRACKING_WINDOW',  labelKey: 'cal.settings_cf_tracking_window',  type: 'number' },
        { key: 'CF_CHECK_INTERVAL',   labelKey: 'cal.settings_cf_check_interval',   type: 'number' },
        { key: 'CF_PERSIST',          labelKey: 'cal.settings_cf_persist',           type: 'checkbox' },
        { key: 'CF_MAX_PENDING',      labelKey: 'cal.settings_cf_max_pending',       type: 'number' },
      ],
    },
    {
      id: 'engine',
      titleKey: 'cal.grp_engine',
      color: '#6366f1',
      fields: [
        { key: 'CAL_RUN_INTERVAL',  labelKey: 'cal.settings_cal_run_interval',      type: 'number' },
        { key: 'CAL_MIN_TRADES',    labelKey: 'cal.settings_cal_min_trades',         type: 'number' },
        { key: 'CAL_MAX_STEP',      labelKey: 'cal.settings_cal_max_step',           type: 'number' },
        { key: 'CAL_MAX_RECS',      labelKey: 'cal.settings_cal_max_recs',           type: 'number' },
      ],
    },
    {
      id: 'decay',
      titleKey: 'cal.grp_decay',
      color: '#f59e0b',
      fields: [
        { key: 'DECAY_HALF_LIFE',   labelKey: 'cal.settings_decay_half_life',        type: 'number' },
        { key: 'DECAY_MIN_WEIGHT',  labelKey: 'cal.settings_decay_min_weight',       type: 'number' },
      ],
    },
    {
      id: 'bayesian',
      titleKey: 'cal.grp_bayesian',
      color: '#a78bfa',
      fields: [
        { key: 'BAYES_STABLE_THRESHOLD',    labelKey: 'cal.settings_bayes_stable_threshold',    type: 'number' },
        { key: 'BAYES_UNCERTAIN_THRESHOLD', labelKey: 'cal.settings_bayes_uncertain_threshold', type: 'number' },
        { key: 'BAYES_AUTO_MIN_CONF',       labelKey: 'cal.settings_bayes_auto_min_conf',       type: 'number' },
      ],
    },
    {
      id: 'safety',
      titleKey: 'cal.grp_safety',
      color: '#f43f5e',
      fields: [
        { key: 'SAFETY_WR_DROP_ROLLBACK', labelKey: 'cal.settings_safety_wr_drop_rollback', type: 'number' },
        { key: 'SAFETY_VERIFY_TIMEOUT',   labelKey: 'cal.settings_safety_verify_timeout',   type: 'number' },
      ],
    },
  ];

  // ── Row HTML ───────────────────────────────────────────────────────────────

  function _rowHTML(field, storedValue, storedDefault) {
    const { key, labelKey, type } = field;
    const label = App.t(labelKey);
    const unit = _unitLabel(key);
    const defDisplay = _toDisplay(key, storedDefault);

    if (type === 'checkbox') {
      const checked = storedValue ? 'checked' : '';
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
          <div style="flex:1;min-width:0;margin-right:12px">
            <div style="font-size:12px;color:#cbd5e1;font-weight:500">${esc(label)}</div>
            <div style="font-size:10px;color:#475569;font-family:monospace;margin-top:1px">${esc(key)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer">
              <input
                type="checkbox"
                data-key="${esc(key)}"
                data-type="checkbox"
                ${checked}
                style="width:15px;height:15px;accent-color:#6366f1;cursor:pointer"
              />
            </label>
            <span style="font-size:9px;color:#334155;white-space:nowrap">${App.t('cal.settings_default', {val: storedDefault == null ? '—' : String(storedDefault)})}</span>
          </div>
        </div>`;
    }

    const displayVal = _toDisplay(key, storedValue);
    const step = _inputStep(key);

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
        <div style="flex:1;min-width:0;margin-right:12px">
          <div style="font-size:12px;color:#cbd5e1;font-weight:500">${esc(label)}</div>
          <div style="font-size:10px;color:#475569;font-family:monospace;margin-top:1px">${esc(key)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input
            type="number"
            data-key="${esc(key)}"
            data-type="number"
            value="${esc(displayVal)}"
            step="${step}"
            style="
              width:80px;
              background:#161b2a;
              border:1px solid rgba(255,255,255,0.1);
              border-radius:6px;
              color:#f1f5f9;
              font-size:12px;
              font-family:monospace;
              padding:5px 8px;
              outline:none;
              text-align:right;
              transition:border-color .15s;
            "
            onfocus="this.style.borderColor='#6366f1'"
            onblur="this.style.borderColor='rgba(255,255,255,0.1)'"
          />
          ${unit ? `<span style="font-size:10px;color:#64748b;width:24px">${esc(unit)}</span>` : '<span style="width:24px"></span>'}
          <span style="font-size:9px;color:#334155;white-space:nowrap">${App.t('cal.settings_default', {val: defDisplay + (unit ? ' ' + unit : '')})}</span>
        </div>
      </div>`;
  }

  // ── Group HTML ─────────────────────────────────────────────────────────────

  function _groupHTML(group, settings, defaults) {
    const { id, titleKey, color, fields, isNew } = group;
    const title = App.t(titleKey);

    const rows = fields.map(f => _rowHTML(f, settings[f.key], defaults[f.key])).join('');
    const newTag = isNew
      ? `<span style="margin-left:10px;background:#a78bfa;color:#0a0a0a;font-size:8px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:.06em;vertical-align:middle">${App.t('cal.new_tag')}</span>`
      : '';

    return `
      <div style="background:#0c0f1a;border:1px solid ${isNew ? 'rgba(167,139,250,0.28)' : 'rgba(255,255,255,0.06)'};border-radius:10px;overflow:hidden;margin-bottom:14px" id="calSettingsGroup-${esc(id)}">
        <div style="height:3px;background:${color}"></div>
        <div style="padding:14px 16px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${color};margin-bottom:10px">${esc(title)}${newTag}</div>
          <div style="padding:0 2px">
            ${rows}
          </div>
        </div>
      </div>`;
  }

  // ── Action buttons HTML ────────────────────────────────────────────────────

  function _actionsHTML() {
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px;justify-content:flex-end">
        <button
          id="calSettingsResetBtn"
          onclick="CalSettings.resetDefaults(this)"
          style="
            padding:8px 18px;
            border-radius:7px;
            font-size:12px;
            font-weight:600;
            cursor:pointer;
            background:transparent;
            color:#475569;
            border:1px solid rgba(255,255,255,0.08);
            transition:color .15s,border-color .15s;
          "
          onmouseover="this.style.color='#94a3b8';this.style.borderColor='rgba(255,255,255,0.15)'"
          onmouseout="this.style.color='#475569';this.style.borderColor='rgba(255,255,255,0.08)'"
        >
          ${esc(App.t('cal.settings_reset'))}
        </button>
        <button
          id="calSettingsSaveBtn"
          onclick="CalSettings.save(this)"
          style="
            padding:8px 20px;
            border-radius:7px;
            font-size:12px;
            font-weight:600;
            cursor:pointer;
            background:rgba(34,197,94,0.1);
            color:#22c55e;
            border:1px solid rgba(34,197,94,0.3);
            transition:background .15s;
          "
          onmouseover="this.style.background='rgba(34,197,94,0.18)'"
          onmouseout="this.style.background='rgba(34,197,94,0.1)'"
        >
          ${esc(App.t('cal.settings_save'))}
        </button>
      </div>`;
  }

  // ── Collect current input values ───────────────────────────────────────────

  function _collectInputs() {
    const el = document.getElementById('calTabSettings');
    if (!el) return {};
    const result = {};
    el.querySelectorAll('[data-key]').forEach(input => {
      const key = input.dataset.key;
      const type = input.dataset.type;
      if (type === 'checkbox') {
        result[key] = input.checked;
      } else {
        const stored = _fromDisplay(key, input.value);
        if (stored !== null) result[key] = stored;
      }
    });
    return result;
  }

  // ── Apply defaults to inputs ───────────────────────────────────────────────

  function _applyDefaults(defaults) {
    const el = document.getElementById('calTabSettings');
    if (!el) return;
    el.querySelectorAll('[data-key]').forEach(input => {
      const key = input.dataset.key;
      const type = input.dataset.type;
      if (!(key in defaults)) return;
      if (type === 'checkbox') {
        input.checked = !!defaults[key];
      } else {
        input.value = _toDisplay(key, defaults[key]);
      }
    });
  }

  // ── Main module ────────────────────────────────────────────────────────────

  const CalSettings = {
    _defaults: null,

    async load() {
      const el = document.getElementById('calTabSettings');
      if (!el) return;

      el.innerHTML = `<div style="color:#475569;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.loading'))}</div>`;

      let data;
      try {
        data = await App.fetchJSON('/api/polymarket/calibration/settings');
      } catch (e) {
        el.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.load_error', {error: e.message}))}</div>`;
        return;
      }

      this._defaults = data.defaults || {};
      this.render(data);
    },

    render(data) {
      const el = document.getElementById('calTabSettings');
      if (!el) return;

      const settings = data.settings || {};
      const defaults = data.defaults || {};

      const groupsHTML = GROUPS.map(g => _groupHTML(g, settings, defaults)).join('');

      el.innerHTML = `
        <div style="padding:2px 0">
          ${groupsHTML}
          ${_actionsHTML()}
        </div>`;
    },

    async save(btn) {
      const payload = _collectInputs();
      await App.withLoading(btn || document.getElementById('calSettingsSaveBtn'), async () => {
        const resp = await App.fetchJSON('/api/polymarket/calibration/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (resp && resp.success) {
          App.toast(App.t('cal.settings_saved'), 'ok');
          // Re-render with returned settings to normalise display values
          this.render({ settings: resp.settings || payload, defaults: this._defaults || {} });
        } else {
          const msg = (resp && resp.error) || App.t('cal.settings_save_err');
          App.toast(msg, 'err');
          throw new Error(msg);
        }
      });
    },

    async resetDefaults(btn) {
      if (!this._defaults || !Object.keys(this._defaults).length) {
        App.toast(App.t('cal.settings_defaults_not_loaded'), 'warn');
        return;
      }
      if (!confirm(App.t('cal.settings_reset_confirm'))) return;

      await App.withLoading(btn || document.getElementById('calSettingsResetBtn'), async () => {
        _applyDefaults(this._defaults);
        const payload = _collectInputs();
        const resp = await App.fetchJSON('/api/polymarket/calibration/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (resp && resp.success) {
          App.toast(App.t('cal.settings_reset_ok'), 'ok');
          this.render({ settings: resp.settings || payload, defaults: this._defaults });
        } else {
          const msg = (resp && resp.error) || App.t('cal.settings_reset_err');
          App.toast(msg, 'err');
          throw new Error(msg);
        }
      });
    },
  };

  window.CalSettings = CalSettings;

})(window.App);
