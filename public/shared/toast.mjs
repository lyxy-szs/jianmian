import { el } from './dom.mjs';

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
  document.body.append(container);
  return container;
}

export function toast(message, { type = 'info', timeout = 4200 } = {}) {
  const node = el('div', { class: `toast toast-${type}`, text: message });
  ensureContainer().append(node);
  const remove = () => {
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 180);
  };
  node.addEventListener('click', remove);
  if (timeout > 0) setTimeout(remove, timeout);
  return node;
}
