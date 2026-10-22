// Applies the saved theme before the page paints, so it never flashes the wrong colours.
// A classic script in <head> (not a module, which would run too late); the CSP forbids inline scripts.
// The theme switch in Settings (ui.js → applyTheme) uses the same rules.
(function () {
  var choice = 'candlelit';
  try {
    choice = JSON.parse(localStorage.getItem('whisperer.prefs') || '{}').theme || 'candlelit';
  } catch (e) {
    // storage blocked: use the default
  }
  var theme = choice === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'daylight' : 'candlelit')
    : choice;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = choice;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'daylight' ? '#1f1f23' : '#1c1612');
})();
