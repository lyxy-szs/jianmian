const KEY = 'interview.theme';

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    const dark = theme === 'dark';
    button.textContent = dark ? '☀ 浅色' : '☾ 深色';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? '切换到浅色主题' : '切换到深色主题';
  }
}

export function initTheme() {
  let theme = 'light';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') theme = saved;
  } catch {
    /* ignore */
  }
  apply(theme);
  const api = {
    get theme() {
      return document.documentElement.dataset.theme || 'light';
    },
    toggle() {
      theme = this.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        /* ignore */
      }
      apply(theme);
      return theme;
    },
  };
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => api.toggle());
  }
  return api;
}
