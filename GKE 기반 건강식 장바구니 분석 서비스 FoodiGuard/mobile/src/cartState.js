import { isAllowedForProfile } from './domain.js';

export function reconcileCartWithProfile(cart = [], profile = {}) {
  const kept = [];
  const removed = [];

  cart.forEach((item) => {
    if (isAllowedForProfile(item, profile)) kept.push(item);
    else removed.push(item);
  });

  return {
    cart: removed.length ? kept : cart,
    removed,
  };
}

export function replaceCartItemOnce(cart = [], from, to) {
  const fromId = from?.id == null ? '' : String(from.id);
  const toId = to?.id == null ? '' : String(to.id);
  if (!fromId || !toId || fromId === toId) return cart;

  const sourceIndex = cart.findIndex((item) => String(item.id) === fromId);
  if (sourceIndex < 0) return cart;

  const targetExists = cart.some((item, index) => index !== sourceIndex && String(item.id) === toId);
  if (targetExists) return cart.filter((_, index) => index !== sourceIndex);

  return cart.map((item, index) => index === sourceIndex ? to : item);
}
