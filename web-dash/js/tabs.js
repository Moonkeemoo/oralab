/* Ora et Labora — tab switching */

(function (App) {
  'use strict';

  const S = App.state;

  App.sw = function (id, btn) {
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('on'));
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
    document.getElementById('pane-' + id).classList.add('on');
    btn.classList.add('on');
    S.activeTab = id;
    // Lazy-load tab-specific data
    App.loadTabData(id);
  };
  window.sw = App.sw;

})(window.App);
