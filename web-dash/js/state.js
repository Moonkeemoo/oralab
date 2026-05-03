/* Ora et Labora — shared state + constants */

window.App = {
  // ─── DOM helper ────────────────────────────────────────────────────────────
  $: (id) => document.getElementById(id),

  // ─── state (formerly closure variables) ────────────────────────────────────
  state: {
    period:            'ALL',
    activeTab:         'trades',
    portfolio:         null,
    positions:         [],
    history:           null,
    filters:           [],
    filterEdits:       {},
    filterSavedConfig: {},
    rejectStats:       null,
    convergenceStats:  null,
    recentRejections:  [],
    riskSettings:      {},
    settingsDirty:     false,
    selectedBotName:   null,
    profiles:          [],
    profilesMap:       {},
    wallets:           null,
    intents:           null,
    lbData:            [],
    whalesMode:        'wallets',
    whalesSort:        'conviction',
    whalesSortAsc:     false,
    whalesTypeFilter:  '',
    whalesDomainFilter:'',
    whalesSearch:      '',
    signalSort:        'level',
    signalFilter:      '',
    refreshTimer:      null,
    serverOnline:      true,
    currentMode:       'dry_run',
    budgetData:        null,
    killActive:        false,
    logLevel:          '',
    logCategory:       '',
    tradingCat:        '',
    logAutoRefresh:    null,
    usdcBalance:       0,
    usdcCash:          0,
    reconciliation:    null,
    // calibration
    calData:           null,
    calSource:         'trader',
    calAutoRunTs:      0,
    calAutoRunning:    false,
  },

  // ─── constants ─────────────────────────────────────────────────────────────
  CAL_AUTO_DEBOUNCE: 30 * 60 * 1000,

  CLASS_EMOJI: {
    INFORMED:      '🧠',
    MARKET_MAKER:  '🏪',
    COPYCAT:       '🐑',
    SNIPER:        '🎯',
    ACCUMULATOR:   '📈',
    NOISE:         '💨',
  },
};
