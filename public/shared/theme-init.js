/* 经典脚本：在解析主体前应用已保存的主题，避免闪白/闪黑。 */
(function () {
  try {
    var saved = localStorage.getItem('interview.theme');
    document.documentElement.dataset.theme = saved === 'dark' ? 'dark' : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
