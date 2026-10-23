// Applies the saved theme before the page paints, so it never flashes the wrong colours.
// A classic script in <head> (not a module, which would run too late); the CSP forbids inline scripts.
// The theme switch in Settings (ui.js → applyTheme) uses the same rules.
(function () {
  var choice = 'auto'; // default: follow the device's light/dark setting
  try {
    choice = JSON.parse(localStorage.getItem('whisperer.prefs') || '{}').theme || 'auto';
  } catch (e) {
    // storage blocked: use the default
  }
  if (choice === 'daylight') choice = 'light'; // renamed
  var theme = choice === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : choice;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = choice;
  var meta = document.querySelector('meta[name="theme-color"]');
  var bars = { candlelit: '#1c1612', light: '#1f1f23', dark: '#0f1011' };
  if (meta) meta.setAttribute('content', bars[theme] || bars.candlelit);
})();
