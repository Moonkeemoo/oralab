/* Ora et Labora — i18n module */

(function (App) {
  'use strict';

  var _strings = {};

  App.locale = localStorage.getItem('lang') || 'ua';

  App.t = function (key, args) {
    var str = _strings[key];
    if (str == null) return key;
    if (!args) return str;
    return str.replace(/\{(\w+)\}/g, function (_, k) {
      return args[k] != null ? args[k] : k;
    });
  };

  App.loadLocale = async function (lang) {
    lang = lang || App.locale;
    try {
      var resp = await fetch('/static/locales/' + lang + '.json?v=' + Date.now());
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      _strings = await resp.json();
      App.locale = lang;
      localStorage.setItem('lang', lang);
      document.documentElement.lang = lang === 'ua' ? 'uk' : 'en';
    } catch (e) {
      console.error('[i18n] Failed to load locale:', lang, e);
    }
  };

  App.applyI18n = function (root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var val = App.t(key);
      if (val !== key) el.textContent = val;
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      var val = App.t(key);
      if (val !== key) el.title = val;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      var val = App.t(key);
      if (val !== key) el.placeholder = val;
    });
    root.querySelectorAll('[data-i18n-tip]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-tip');
      var val = App.t(key);
      if (val !== key) el.setAttribute('data-tip', val);
    });
  };

  App.switchLocale = async function (lang) {
    if (!lang) lang = App.locale === 'ua' ? 'en' : 'ua';
    await App.loadLocale(lang);
    App.applyI18n();
    var flagEl = document.querySelector('#langToggle .lang-flag');
    if (flagEl) flagEl.textContent = lang === 'ua' ? '\u{1F1FA}\u{1F1E6}' : '\u{1F1EC}\u{1F1E7}';
    if (typeof App.loadAll === 'function') App.loadAll();
  };

})(window.App);
