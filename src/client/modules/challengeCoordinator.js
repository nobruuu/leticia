import EventBus from './eventBus.js';

let coordinator = null;
let transition = null;

// Challenge can be destroyed while its sibling routes still need this handler.
// Replace only the previous challenge coordinator when entering a challenge again.
export function registerChallengeCoordinator(handler) {
  if (coordinator) EventBus.$off('leticia-next-challenge', coordinator);
  coordinator = () => {
    // Ignore repeated advances while the current snapshot/navigation is pending.
    if (!transition) runChallengeTransition(handler);
  };
  EventBus.$on('leticia-next-challenge', coordinator);
}

export function runChallengeTransition(handler) {
  if (transition) return transition;
  transition = Promise.resolve().then(handler).finally(() => { transition = null; });
  return transition;
}

export async function stopChallengeCoordinator() {
  if (coordinator) EventBus.$off('leticia-next-challenge', coordinator);
  coordinator = null;
  // A global advance (including timeout) must not race an older challenge write.
  if (transition) await transition;
}
