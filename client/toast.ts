/**
 * Toast notifications. Additive to the screen-reader `#status-region`
 * announcements in ./app — this is the visual layer, `announce()` stays the
 * accessible one. CSP forbids inline style/script, so every node here is
 * built with createElement and styled entirely through classes.
 */
import { icon } from './icons';
import type { IconName } from './icons';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type ToastInput = { kind: ToastKind; title: string; message?: string };
export type Toaster = { push(toast: ToastInput): void };

const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE = 4;
const ICON_FOR: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'success',
  warning: 'alert',
  error: 'alert',
};

export function createToaster(host: HTMLElement): Toaster {
  function dismiss(node: HTMLElement): void {
    if (!node.isConnected) return;
    if (node.classList.contains('is-leaving')) return;
    node.classList.add('is-leaving');
    const remove = () => node.remove();
    node.addEventListener('animationend', remove, { once: true });
    // Reduced-motion users get no animationend; don't leave ghosts behind.
    setTimeout(remove, 400);
  }

  return {
    push({ kind, title, message }) {
      const node = document.createElement('div');
      node.className = `toast toast-${kind}`;

      const body = document.createElement('div');
      body.className = 'toast-body';
      const strong = document.createElement('strong');
      strong.textContent = title;
      body.appendChild(strong);
      if (message) {
        const p = document.createElement('p');
        p.textContent = message;
        body.appendChild(p);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.appendChild(icon('x', { size: 14 }));
      close.addEventListener('click', () => dismiss(node));

      node.append(icon(ICON_FOR[kind], { size: 18, className: 'toast-icon' }), body, close);
      host.appendChild(node);

      while (host.children.length > MAX_VISIBLE) {
        const oldest = host.firstElementChild;
        if (oldest instanceof HTMLElement) oldest.remove();
        else break;
      }
      if (kind !== 'error') setTimeout(() => dismiss(node), AUTO_DISMISS_MS);
    },
  };
}
